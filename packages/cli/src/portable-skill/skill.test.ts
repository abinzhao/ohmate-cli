/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { sha256 } from '../agent/context-files.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-skill-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function setup() {
  return { runtime: await createRuntime(), context: await createExecutionContext({ cwd: root, dataDir: join(root, 'private') }) };
}
async function exported() {
  const setup_ = await setup(), result = await setup_.runtime.execute('skill.export', {}, setup_.context);
  expect(result.exitCode).toBe(0);
  return { ...setup_, result, path: (result.data as { path: string }).path };
}

it('exports a self-contained Skill with the actual public registry and hashed files', async () => {
  const { runtime, context, result, path } = await exported();
  expect(basename(path)).toBe('ohmate-cli');
  const skill = await readFile(join(path, 'SKILL.md'), 'utf8'), commands = JSON.parse(await readFile(join(path, 'commands.json'), 'utf8'));
  expect(skill).toMatch(/^---\nname: ohmate-cli\ndescription: .+\n---\n/);
  expect(skill).toContain('commands.json');
  expect(skill).toContain('ohmatecli');
  expect(skill).not.toContain('--raw');
  const publicIds = runtime.registry.list().filter((spec) => !spec.hidden).map((spec) => spec.id);
  expect(commands.commands.map((command: { id: string }) => command.id)).toEqual(publicIds);
  expect(JSON.stringify(commands)).not.toContain(root);
  expect(JSON.stringify(commands)).not.toContain('--api-key');
  expect(result.artifacts).toHaveLength(3);
  const verified = await runtime.execute('skill.verify', { path }, context);
  expect(verified.exitCode).toBe(0);
  expect(verified.data).toMatchObject({ valid: true, commandDrift: [], integrity: 'passed', count: publicIds.length });
});

it('does not overwrite previous exports and validates without an installed model', async () => {
  const first = await exported();
  const second = await first.runtime.execute('skill.export', {}, first.context);
  expect(second.exitCode).toBe(0);
  expect((second.data as { path: string }).path).not.toBe(first.path);
  expect((await first.runtime.execute('skill.verify', { path: first.path }, first.context)).exitCode).toBe(0);
});

it('rejects tampering and reports exact command drift against the running registry', async () => {
  const { runtime, context, path } = await exported();
  await writeFile(join(path, 'SKILL.md'), 'bad content');
  const tampered = await runtime.execute('skill.verify', { path }, context);
  expect(tampered.exitCode).toBe(1);
  expect(tampered.data).toMatchObject({ valid: false, integrity: 'failed' });
  const fresh = await runtime.execute('skill.export', {}, context), otherPath = (fresh.data as { path: string }).path;
  const doctor = runtime.registry.get('doctor')!;
  runtime.registry.register({ ...doctor, id: 'extra.capability', command: ['extra', 'capability'] });
  const drift = await runtime.execute('skill.verify', { path: otherPath }, context);
  expect(drift.exitCode).toBe(1);
  expect(drift.data).toMatchObject({ valid: false, commandDrift: ['extra.capability'] });
});

it('rejects symlinks, extra executable files and absolute-path leakage', async () => {
  const { runtime, context, path } = await exported();
  const linked = join(root, 'linked');
  await symlink(path, linked);
  expect((await runtime.execute('skill.verify', { path: linked }, context)).exitCode).toBe(4);
  await writeFile(join(path, 'extra.sh'), 'echo example\n');
  expect((await runtime.execute('skill.verify', { path }, context)).exitCode).toBe(1);
  const setup_ = await setup(), doctor = setup_.runtime.registry.get('doctor')!;
  setup_.runtime.registry.register({ ...doctor, id: 'leaking.tool', command: ['leaking', 'tool'], description: `Read ${root}/private.txt` });
  const leaking = await setup_.runtime.execute('skill.export', {}, setup_.context);
  expect(leaking.exitCode).toBe(4);
  expect(JSON.stringify(leaking)).not.toContain('private.txt');
});

it('rejects duplicate commands and changed dispatch entry even with recomputed file hashes', async () => {
  const { runtime, context, path } = await exported();
  const catalogPath = join(path, 'commands.json'), manifestPath = join(path, 'manifest.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const change of ['duplicate', 'entry']) {
    const modified = structuredClone(catalog);
    if (change === 'duplicate') { modified.commands.push(modified.commands[0]); }
    else { modified.entry = 'other-command'; }
    const text = JSON.stringify(modified);
    const updated = { ...manifest, registryHash: sha256(JSON.stringify(modified.commands)),
      files: manifest.files.map((file: { path: string; sha256: string }) => file.path === 'commands.json' ? { ...file, sha256: sha256(text) } : file) };
    await writeFile(catalogPath, text); await writeFile(manifestPath, JSON.stringify(updated));
    expect((await runtime.execute('skill.verify', { path }, context)).exitCode).toBe(1);
  }
});

it('rejects arbitrary Unix paths and raw process instructions in exported metadata', async () => {
  for (const description of ['Read /opt/company/file', 'Run execFile(command)', 'Run sh -c command']) {
    const { runtime, context } = await setup(), doctor = runtime.registry.get('doctor')!;
    runtime.registry.register({ ...doctor, id: 'unsafe.tool', command: ['unsafe', 'tool'], description });
    expect((await runtime.execute('skill.export', {}, context)).exitCode).toBe(4);
  }
});
