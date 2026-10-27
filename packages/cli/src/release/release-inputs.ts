/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import JSON5 from 'json5';
import { readProject } from '../project-model/index.js';
import { analyzeDependencies } from '../dependency/index.js';
import { Project } from '../utils/project.js';
import { digest, evidenceFile, inputEvidence } from '../quality/evidence.js';
import { assertPublicValue } from '../tasks/task-state.js';
import type { ExecutionContext } from '../runtime/types.js';
import { manifestSchema, releaseSchema, type ReleaseFile, type ReleaseSelection } from './types.js';
import { readPackage } from './package-reader.js';

const privateName = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
export function within(root: string, file: string) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
export async function readReleaseFile(context: ExecutionContext, name: string, allowStore = false, maxBytes = 128 * 1024 * 1024): Promise<ReleaseFile> {
  const root = context.projectRoot ?? context.cwd, path = resolve(root, name);
  const boundary = within(root, path) ? root : allowStore && within(context.artifactStore.root, path) ? context.artifactStore.root : null;
  if (!boundary || relative(boundary, path).split(sep).some((part) => privateName.test(part))) { throw new Error('Release input is outside scope or private'); }
  const evidence = await evidenceFile(boundary, path, maxBytes);
  if (evidence.size > 128 * 1024 * 1024) { throw new Error('Release input exceeds 128 MiB'); }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== evidence.size) { throw new Error('Release input changed or is not a bounded file'); }
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) { break; } count += next.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path), data = bytes.subarray(0, count);
    if (count !== before.size || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || digest(data) !== evidence.sha256) { throw new Error('Release input changed during reading'); }
    return { ...evidence, path: boundary === root ? evidence.path : path, bytes: data };
  } finally { await handle.close(); }
}
function object(file: ReleaseFile) {
  if (file.size > 8 * 1024 * 1024) { throw new Error('Release JSON exceeds 8 MiB'); }
  const value: unknown = JSON5.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  assertPublicValue(value); return value;
}
export function reachableNodes(selection: Pick<ReleaseSelection, 'model' | 'modules' | 'dependencies'>) {
  const roots = selection.modules.map((spec) => selection.model.modules.find((m) => m.name === spec.split('@')[0])!);
  const reached = new Set(selection.dependencies.components.filter((n) =>
    roots.some((m) => resolve(selection.model.root, dirname(n.path)) === m.path)).map((n) => n.id));
  const queue = [...reached];
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of selection.dependencies.relationships.filter((e) => e.from === from && e.scope !== 'development')) {
      if (reached.has(edge.to)) { continue; } reached.add(edge.to); queue.push(edge.to);
    }
  }
  return reached;
}
async function readSources(context: ExecutionContext, selection: Pick<ReleaseSelection, 'model' | 'modules' | 'dependencies'>) {
  const inputs = await inputEvidence(context), nodes = reachableNodes(selection);
  const roots = selection.modules.map((spec) => selection.model.modules.find((m) => m.name === spec.split('@')[0])!.path);
  roots.push(...selection.dependencies.components.filter((n) => nodes.has(n.id) && n.origin === 'manifest')
    .map((n) => resolve(selection.model.root, dirname(n.path))));
  const files = inputs.files.filter((f) => f.path === 'build-profile.json5' || f.path === 'AppScope/app.json5' ||
    roots.some((root) => within(root, resolve(selection.model.root, f.path))));
  const sources = [];
  for (const file of files.filter((f) => /\.(?:json5|json|ets|ts|js|mjs|cjs|cpp|cc|c|h|hpp|txt|cmake)$/.test(f.path))) {
    context.abortSignal.throwIfAborted();
    if (/(?:^|\/)(?:test|ohosTest|src\/test)\//.test(file.path)) { continue; }
    const current = await readReleaseFile(context, file.path);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes);
    if (text.includes('\0')) { throw new Error('Binary release source is unsupported'); }
    sources.push({ ...file, text });
  }
  return { sources, excluded: inputs.skipped };
}
function selectModules(model: ReleaseSelection['model'], product: string, requested?: string[]) {
  const project = Project.discover(model.root); project.validateProduct(product);
  const allowed = project.resolveModuleSpecsForProduct(product), selected = requested ?? allowed;
  const modules = selected.map((m) => m.includes('@') ? m : `${m}@default`);
  if (!modules.length || new Set(modules).size !== modules.length || modules.some((m) => !allowed.includes(m))) {
    throw new Error('Unknown or duplicate Release module/target selection');
  }
  return modules;
}
async function loadManifest(context: ExecutionContext, path?: string) {
  if (!path) { return null; }
  if (!path.endsWith('.json')) { throw new Error('Build manifest must be a JSON file'); }
  const file = await readReleaseFile(context, path, true);
  return { file, value: manifestSchema.parse(object(file)) };
}
async function loadPackages(context: ExecutionContext, value: ReleaseSelection['value'], manifest: ReleaseSelection['manifest']) {
  const declared = manifest?.value.artifacts.filter((a) => ['hap', 'hsp', 'har', 'app'].includes(a.kind)) ?? [];
  const paths = value.artifacts.length ? value.artifacts : declared.map((a) => a.path);
  if (new Set(paths.map((p) => resolve(context.projectRoot ?? context.cwd, p))).size !== paths.length) { throw new Error('Duplicate Release artifacts'); }
  const packages = [], budget = { bytes: 0, entries: 0 }, inputBudget = { bytes: 0 };
  for (const path of paths) {
    if (!/\.(?:hap|hsp|har|app)$/.test(path)) { throw new Error('Unsupported Release artifact'); }
    const file = await readReleaseFile(context, path);
    if ((inputBudget.bytes += file.size) > 128 * 1024 * 1024) { throw new Error('Release packages exceed the combined 128 MiB input budget'); }
    const expected = declared.find((a) => resolve(context.projectRoot ?? context.cwd, a.path) === resolve(context.projectRoot ?? context.cwd, path));
    if (manifest && (!expected || expected.sha256 !== file.sha256)) { throw new Error('Artifact does not match the selected build manifest'); }
    packages.push(await readPackage(file, context.abortSignal, budget));
  }
  return packages;
}
export async function resolveRelease(input: unknown, context: ExecutionContext): Promise<ReleaseSelection> {
  const value = releaseSchema.parse(input), model = await readProject(context.projectRoot ?? context.cwd);
  const manifest = await loadManifest(context, value.manifest), product = value.product ?? manifest?.value.product ?? 'default';
  const modules = selectModules(model, product, value.modules ?? manifest?.value.modules);
  if (manifest?.value.product && manifest.value.product !== product) { throw new Error('Build manifest product differs from the selected product'); }
  if (manifest?.value.modules && JSON.stringify([...manifest.value.modules].sort()) !== JSON.stringify([...modules].sort())) {
    throw new Error('Build manifest modules differ from the selected modules');
  }
  const scoped = { ...context, projectRoot: model.root }, dependencies = await analyzeDependencies(scoped);
  const sources = await readSources(scoped, { model, modules, dependencies }), symbols: ReleaseFile[] = [];
  let symbolBytes = 0;
  for (const path of value.symbols) {
    if (!/\.(?:map|so|debug)$|(?:^|[\\/])nameCache\.json$/.test(path)) { throw new Error('Select SourceMap, nameCache or Native symbol files explicitly'); }
    const file = await readReleaseFile(scoped, path);
    if ((symbolBytes += file.size) > 64 * 1024 * 1024) { throw new Error('Release symbols exceed the combined 64 MiB input budget'); }
    if (!/\.(?:so|debug)$/.test(path)) { object(file); } symbols.push(file);
  }
  return { value, model, product, modules, ...sources, dependencies, manifest,
    packages: await loadPackages(scoped, value, manifest), symbols };
}
