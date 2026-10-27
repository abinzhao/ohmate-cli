/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sha256 } from '../agent/context-files.js';
import { InputInvalidError, type ExecutionContext, type ToolResult } from '../runtime/types.js';
import type { ToolSpecRegistry } from '../runtime/registry.js';
import { assertPortable, commandCatalog, manifestSchema, skillContent, skillFiles } from './skill-content.js';

export async function exportSkill(registry: ToolSpecRegistry, context: ExecutionContext): Promise<ToolResult> {
  const content = skillContent(registry), base = resolve(context.artifactStore.root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (await realpath(base) !== base || !(await lstat(base)).isDirectory()) { throw new InputInvalidError('Unsafe Skill artifact root'); }
  const parent = await mkdtemp(join(base, 'skill-export-')), path = join(parent, 'ohmate-cli');
  let complete = false;
  try {
    await mkdir(path, { mode: 0o700 });
    const artifacts = [];
    for (const name of skillFiles) {
      context.abortSignal.throwIfAborted();
      const text = content.files[name], file = join(path, name), handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); }
      finally { await handle.close(); }
      artifacts.push({ path: file, kind: name === 'manifest.json' ? 'skill-manifest' : 'portable-skill', sha256: sha256(text) });
    }
    complete = true;
    return { exitCode: 0, data: { path, name: 'ohmate-cli', count: content.commands.length,
      registryHash: sha256(JSON.stringify(content.commands)), installation: 'manual-copy' }, artifacts };
  } finally { if (!complete) { await rm(parent, { recursive: true, force: true }); } }
}

async function readPublicFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) { throw new InputInvalidError('Skill file must be a bounded unlinked regular file'); }
    const bytes = await handle.readFile(), now = await lstat(path);
    if (bytes.length > 1024 * 1024 || now.ino !== info.ino || now.dev !== info.dev || now.isSymbolicLink()) {
      throw new InputInvalidError('Skill file changed while reading');
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { await handle.close(); }
}
function compareCommands(registry: ToolSpecRegistry, catalog: unknown) {
  const record = catalog as { schemaVersion?: string; entry?: string; commands?: { id: string }[] }, expected = commandCatalog(registry);
  if (record.schemaVersion !== '1.0' || record.entry !== 'ohmatecli' ||
    !Array.isArray(record.commands) || record.commands.some((item) => !item || typeof item.id !== 'string')) {
    throw new Error('Skill command catalog is invalid');
  }
  if (new Set(record.commands.map((item) => item.id)).size !== record.commands.length) { throw new Error('Duplicate Skill command'); }
  const actual = new Map(record.commands.map((item) => [item.id, JSON.stringify(item)]));
  const current = new Map(expected.map((item) => [item.id, JSON.stringify(item)]));
  return [...new Set([...actual.keys(), ...current.keys()])].filter((id) => actual.get(id) !== current.get(id)).sort();
}

export async function verifySkill(registry: ToolSpecRegistry, inputPath: string, context: ExecutionContext): Promise<ToolResult> {
  const path = resolve(context.cwd, inputPath);
  if (await realpath(path) !== path || basename(path) !== 'ohmate-cli' || !(await lstat(path)).isDirectory()) {
    throw new InputInvalidError('Skill directory must be an unlinked real ohmate-cli directory');
  }
  const findings: string[] = [], commandDrift: string[] = [];
  const names = await readdir(path);
  if (names.length !== skillFiles.length || names.some((name) => !skillFiles.includes(name as typeof skillFiles[number]))) {
    findings.push('SKILL_FILE_SET_MISMATCH');
  }
  let count = 0;
  try {
    const files: Record<string, string> = {};
    for (const name of skillFiles) {
      if ((await lstat(join(path, name))).isSymbolicLink()) { throw new InputInvalidError('Linked Skill files are unsupported'); }
      files[name] = await readPublicFile(join(path, name)); assertPortable(files[name]);
    }
    const manifest = manifestSchema.parse(JSON.parse(files['manifest.json']));
    if (new Set(manifest.files.map((file) => file.path)).size !== 2) { findings.push('SKILL_MANIFEST_INVALID'); }
    if (manifest.files.some((file) => sha256(files[file.path]) !== file.sha256)) { findings.push('SKILL_HASH_MISMATCH'); }
    if (!/^---\nname: ohmate-cli\ndescription: [^\n]+\n---\n[\s\S]+\[commands.json\]\(commands.json\)/.test(files['SKILL.md'])) {
      findings.push('SKILL_FRONTMATTER_INVALID');
    }
    const catalog = JSON.parse(files['commands.json']);
    count = catalog.commands?.length ?? 0;
    commandDrift.push(...compareCommands(registry, catalog));
    if (sha256(JSON.stringify(catalog.commands)) !== manifest.registryHash) { findings.push('SKILL_REGISTRY_HASH_MISMATCH'); }
    if (catalog.toolVersion !== manifest.toolVersion || manifest.toolVersion !== (process.env.npm_package_version ?? '0.1.0')) {
      findings.push('SKILL_VERSION_MISMATCH');
    }
  } catch (error) {
    if (error instanceof InputInvalidError) { throw error; }
    findings.push('SKILL_CONTENT_INVALID');
  }
  const valid = !findings.length && !commandDrift.length;
  return { exitCode: valid ? 0 : 1, data: { valid, count, findings, commandDrift,
    integrity: findings.length ? 'failed' : 'passed', installation: 'not-performed' } };
}
