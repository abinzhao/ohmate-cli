/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fileSystem from 'node:fs';
import * as paths from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';

let root: string;
const hvigor = "// preserve\nimport { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n";
const config = { schemaVersion: '1.0', release: 'none', debug: 'debug', test: 'test', probes: [] };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-profile-'));
  await mkdir(join(root, 'entry/src/main/ets'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), '{"modules":[{"name":"entry","srcPath":"./entry"}]}');
  await writeFile(join(root, 'entry/src/main/module.json5'), '{"module":{"name":"entry","type":"entry"}}');
  await writeFile(join(root, 'entry/hvigorfile.ts'), hvigor);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function setup() {
  return { runtime: await createRuntime(), context: await createExecutionContext({
    cwd: root, projectRoot: root, dataDir: join(root, 'private'),
  }) };
}
const entryPath = 'entry/src/main/ets/OHMateRuntimeEntry.ets';
const manifestPath = 'entry/ohmate-profile-manifest.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it('previews none entry and incomplete manifest without writing source', async () => {
  const { runtime, context } = await setup();
  const receipt = await runtime.execute('integrate.runtime', { module: 'entry' }, context);
  expect(receipt.exitCode).toBe(0);
  const data = receipt.data as { patch: { changes: { path: string; text: string }[] } };
  expect(data).toMatchObject({ write: false, profile: 'release-none', buildId: null, completeness: 'incomplete',
    missing: expect.arrayContaining(['compiled-Aspect-AbcKitTS-and-debug-manifest-purity']) });
  const entry = data.patch.changes.find(item => item.path === entryPath)!.text;
  const manifest = JSON.parse(data.patch.changes.find(item => item.path === manifestPath)!.text);
  expect(entry).not.toMatch(/\bimport\b|console\.|hilog|setTimeout|writeFile|register|@ohmate/);
  expect(entry).toContain('CAPABILITY_NOT_AVAILABLE');
  expect(manifest).toMatchObject({ profile: 'release-none', buildMode: 'release', buildId: null,
    entry: { path: entryPath, sha256: hash(entry) }, probes: [] });
  expect(await readFile(join(root, 'entry/hvigorfile.ts'), 'utf8')).toBe(hvigor);
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('binds explicit writes to reviewed bytes and preserves existing Hvigor plugins', async () => {
  const { runtime, context } = await setup(), input = { module: 'entry', write: true };
  const planned = await runtime.execute('integrate.runtime', input, context);
  expect(planned.exitCode).toBe(5);
  const applied = await runtime.execute('integrate.runtime', input, { ...context,
    policy: { ...context.policy, approvedPlan: (planned.data as { planId: string }).planId } });
  expect(applied.exitCode).toBe(0);
  expect(await readFile(join(root, 'entry/hvigorfile.ts'), 'utf8')).toContain('ohmateRuntimePlugin()');
  expect(await readFile(join(root, 'entry/hvigorfile.ts'), 'utf8')).toContain('// preserve');
  expect(JSON.parse(await readFile(join(root, 'runtime-profile.json5'), 'utf8'))).toEqual(config);
  expect((await runtime.execute('integrate.runtime', input, context)).exitCode).toBe(4);
});

it('does not overwrite collisions or accept dynamic Hvigor declarations', async () => {
  const { runtime, context } = await setup();
  await writeFile(join(root, 'entry/ohmate-runtime-hvigor.ts'), '// owned by user\n');
  expect((await runtime.execute('integrate.runtime', { module: 'entry' }, context)).exitCode).toBe(4);
  expect(await readFile(join(root, 'entry/ohmate-runtime-hvigor.ts'), 'utf8')).toBe('// owned by user\n');
  await rm(join(root, 'entry/ohmate-runtime-hvigor.ts'));
  await writeFile(join(root, 'entry/hvigorfile.ts'), 'export default { plugins: dangerous() };');
  expect((await runtime.execute('integrate.runtime', { module: 'entry' }, context)).exitCode).toBe(4);
});

it('invalidates approval on configuration drift without rewriting it', async () => {
  const { runtime, context } = await setup(), input = { module: 'entry', write: true };
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify(config));
  const plan = await runtime.execute('integrate.runtime', input, context);
  expect(plan.exitCode).toBe(5);
  const changed = JSON.stringify({ ...config, release: 'core' });
  await writeFile(join(root, 'runtime-profile.json5'), changed);
  const stale = await runtime.execute('integrate.runtime', input, { ...context,
    policy: { ...context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(stale.exitCode).not.toBe(0);
  expect(await readFile(join(root, 'runtime-profile.json5'), 'utf8')).toBe(changed);
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps unverified release-core implementation unavailable', async () => {
  const profile = 'release-core';
  const { runtime, context } = await setup();
  const result = await runtime.execute('integrate.runtime', { module: 'entry', profile }, context);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ code: 'RUNTIME_ENTRY_UNAVAILABLE', profile, write: false });
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

async function declareRuntime(version = 'file:../ohmatekit') {
  await writeFile(join(root, 'entry/oh-package.json5'), JSON.stringify({
    name: 'entry', version: '1.0.0', dependencies: { '@ohmate/ohmatekit': version },
  }));
}
type Preview = { patch: { changes: { path: string; text: string }[] }; review: Record<string, unknown> };
function generated(source: string, runtime: object) {
  const exports_: { OHMateRuntimeEntry?: Record<string, (...args: unknown[]) => unknown>;
    ohmateRuntimePlugin?: () => { apply: (node: object) => void } } = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: exports_, require: (name: string) => {
      if (name === '@ohmate/ohmatekit/src/main/ets/api/runtime') { return { OHMateRuntime: runtime }; }
      if (name === '@ohos/hvigor-ohos-plugin') { return { OhosPluginId: { OHOS_HAP_PLUGIN: 'hap' } }; }
      throw new Error(`Unexpected generated dependency ${name}`);
    },
  });
  return exports_;
}

it.each(['debug', 'test'] as const)('previews actual Runtime delegation without starting it: %s', async profile => {
  await declareRuntime();
  const { runtime, context } = await setup();
  const result = await runtime.execute('integrate.runtime', { module: 'entry', profile }, context);
  expect(result.exitCode).toBe(0);
  const data = result.data as Preview;
  expect(data).toMatchObject({ write: false, profile, buildId: null, completeness: 'incomplete',
    review: { runtimeBinding: 'declared-only', buildMode: 'debug', releaseBuild: 'blocked' } });
  const source = data.patch.changes.find(item => item.path === entryPath)!.text;
  const calls: unknown[][] = [];
  const target = { start: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ code: 'STARTED' }); },
    attachWindow: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ code: 'WINDOW_ATTACHED' }); },
    openPanel: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ code: 'PANEL_OPENED' }); },
    retryArchiveSaveCleanup: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ code: 'SAVE_CLEANED' }); },
    registerProvider: (...args: unknown[]) => { calls.push(args); return { code: 'PROVIDER_REGISTERED' }; },
    captureProvider: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ code: 'PROVIDER_READ' }); },
    ready: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ code: 'READY' }); } };
  const entry = generated(source, target).OHMateRuntimeEntry!;
  expect(calls).toEqual([]);
  const app = { filesDir: '/private/app' }, ui = { id: 2 }, options = { marker: true };
  expect(await entry.start(app, options)).toMatchObject({ code: 'STARTED' });
  expect(await entry.attachWindow(ui, 1500, 'main')).toMatchObject({ code: 'WINDOW_ATTACHED' });
  await entry.openPanel('window-2', 1200);
  await entry.retryArchiveSaveCleanup('window-2', 800);
  expect(calls).toEqual([[app, profile, options], [ui, 1500, 'main'], ['window-2', 1200], ['window-2', 800]]);
  const descriptor = { id: 'sample' }, provider = { read: true };
  expect(entry.registerProvider(descriptor, provider)).toMatchObject({ code: 'PROVIDER_REGISTERED' });
  expect(await entry.captureProvider('sample', 500)).toMatchObject({ code: 'PROVIDER_READ' });
  expect(calls.slice(-2)).toEqual([[descriptor, provider], ['sample', 500]]);
  if (profile === 'test') { await entry.ready(700); expect(calls.at(-1)).toEqual([700]); }
  else { expect(entry.ready).toBeUndefined(); }
  expect(source).not.toMatch(/\bconsole\.|setTimeout|connectDesktop\(/);
  const manifest = JSON.parse(data.patch.changes.find(item => item.path === manifestPath)!.text);
  expect(manifest).toMatchObject({ profile, buildMode: 'debug', entry: { sha256: hash(source) }, buildId: null, completeness: 'incomplete' });
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['debug', 'test'] as const)('requires reviewed writes and invalidates dependency drift: %s', async profile => {
  await declareRuntime();
  const { runtime, context } = await setup(), input = { module: 'entry', profile, write: true };
  const plan = await runtime.execute('integrate.runtime', input, context);
  expect(plan.exitCode).toBe(5);
  await declareRuntime('^6.0.0');
  const policy = { ...context.policy, approvedPlan: (plan.data as { planId: string }).planId };
  expect((await runtime.execute('integrate.runtime', input, { ...context, policy })).exitCode).not.toBe(0);
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await runtime.execute('integrate.runtime', input, context);
  expect(next.exitCode).toBe(5);
  const applied = await runtime.execute('integrate.runtime', input, { ...context,
    policy: { ...context.policy, approvedPlan: (next.data as { planId: string }).planId } });
  expect(applied.exitCode).toBe(0);
  expect(await readFile(join(root, entryPath), 'utf8')).toContain(`OHMateRuntime.start(context, '${profile}', options)`);
});

it.each(['debug', 'test'] as const)('rejects undeclared Runtime before any proposed write: %s', async profile => {
  const { runtime, context } = await setup();
  expect((await runtime.execute('integrate.runtime', { module: 'entry', profile }, context)).exitCode).toBe(4);
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['debug', 'test'] as const)('does not omit configured probes without their compiler producer: %s', async profile => {
  await declareRuntime();
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify({ ...config, probes: [
    { id: 'probe', kind: 'abckitts', module: 'entry', ruleHash: 'a'.repeat(64), runtimeGate: true },
  ] }));
  const { runtime, context } = await setup();
  const result = await runtime.execute('integrate.runtime', { module: 'entry', profile }, context);
  expect(result.exitCode).toBe(4);
  expect(result.data).toMatchObject({ message: 'RUNTIME_PROBE_PRODUCER_UNAVAILABLE' });
  await expect(readFile(join(root, entryPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['debug', 'test'] as const)('binds Debug/Test build guard to actual mode and reviewed configuration: %s', async profile => {
  await declareRuntime();
  const { runtime, context } = await setup();
  const result = await runtime.execute('integrate.runtime', { module: 'entry', profile }, context);
  expect(result.exitCode).toBe(0);
  const data = result.data as Preview;
  const source = data.patch.changes.find(item => item.path === 'entry/ohmate-runtime-hvigor.ts')!.text;
  for (const item of data.patch.changes) { await writeFile(join(root, item.path), item.text); }
  const exports_: { ohmateRuntimePlugin?: () => { apply: (node: object) => void } } = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: exports_, Buffer, require: (name: string) => {
      if (name === '@ohos/hvigor-ohos-plugin') { return { OhosPluginId: { OHOS_HAP_PLUGIN: 'hap' } }; }
      if (name === 'node:fs') { return fileSystem; }
      if (name === 'node:path') { return paths; }
      if (name === 'node:crypto') { return { createHash }; }
      throw new Error(`Unexpected guard dependency ${name}`);
    },
  });
  function guard(mode: string) {
    let callback: (() => void) | undefined;
    exports_.ohmateRuntimePlugin!().apply({ afterNodeEvaluate: (fn: () => void) => { callback = fn; },
      getContext: () => ({ getBuildMode: () => mode }), getNodeDir: () => ({ getPath: () => join(root, 'entry') }) });
    return callback!;
  }
  expect(guard('debug')).not.toThrow();
  for (const mode of ['test', 'release', 'Debug', 'Release', 'unknown']) {
    expect(guard(mode)).toThrow('OHMATE_PROFILE_BUILD_MODE_MISMATCH');
  }
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify({ ...config, release: 'core' }));
  expect(guard('debug')).toThrow('OHMATE_PROFILE_INPUT_DRIFT');
});

it.each([
  { ...config, release: 'debug' }, { ...config, debug: 'none' }, { ...config, extra: true },
  { ...config, probes: [{ id: 'p', kind: 'abckitts', module: 'entry', ruleHash: 'a'.repeat(64), runtimeGate: false }] },
  { ...config, probes: [{ id: 'p', kind: 'abckitts', module: 'missing', ruleHash: 'a'.repeat(64), runtimeGate: true }] },
])('rejects invalid Profile semantics without accepting generic JSON5: %j', async value => {
  const { runtime, context } = await setup();
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify(value));
  const receipt = await runtime.execute('config.validate', { path: 'runtime-profile.json5' }, context);
  expect(receipt.exitCode).toBe(1);
  expect(receipt.data).toMatchObject({ valid: false, runtimeProfile: { staticValid: false } });
});

it('reports empty probe declarations as incomplete and does not infer Release purity', async () => {
  const { runtime, context } = await setup();
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify(config));
  const receipt = await runtime.execute('config.validate', { path: 'runtime-profile.json5' }, context);
  expect(receipt.exitCode).toBe(3);
  expect(receipt.data).toMatchObject({ valid: null, runtimeProfile: { staticValid: true, status: 'incomplete',
    missing: expect.arrayContaining(['compiler-bound-profile-entry', 'compiled-Aspect-AbcKitTS-and-debug-manifest-purity']) } });
});

it('refuses duplicate probe identities and duplicate decoded JSON5 fields', async () => {
  const { runtime, context } = await setup();
  const probe = { id: 'p', kind: 'runtime-aspect', module: 'entry', ruleHash: 'a'.repeat(64), runtimeGate: true };
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify({ ...config, probes: [probe, probe] }));
  expect((await runtime.execute('config.validate', { path: 'runtime-profile.json5' }, context)).exitCode).toBe(1);
  await writeFile(join(root, 'runtime-profile.json5'), '{schemaVersion:"1.0",release:"none",release:"core",debug:"debug",test:"test",probes:[]}');
  expect((await runtime.execute('integrate.runtime', { module: 'entry' }, context)).exitCode).toBe(4);
});

it('rejects undeclared module and mode disagreement before proposing a patch', async () => {
  const { runtime, context } = await setup();
  expect((await runtime.execute('integrate.runtime', { module: 'unknown' }, context)).exitCode).toBe(4);
  await writeFile(join(root, 'runtime-profile.json5'), JSON.stringify({ ...config, release: 'core' }));
  expect((await runtime.execute('integrate.runtime', { module: 'entry' }, context)).exitCode).toBe(4);
});

it('makes the generated Hvigor guard reject wrong modes and unverified Release without effects', async () => {
  const { runtime, context } = await setup();
  const preview = await runtime.execute('integrate.runtime', { module: 'entry' }, context);
  expect(preview.exitCode).toBe(0);
  const data = preview.data as { patch: { changes: { path: string; text: string }[] } };
  const source = data.patch.changes.find(item => item.path === 'entry/ohmate-runtime-hvigor.ts')!.text;
  const exports_: { ohmateRuntimePlugin?: () => { apply: (node: object) => void } } = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: exports_, require: (name: string) => {
      if (name === '@ohos/hvigor-ohos-plugin') { return { OhosPluginId: { OHOS_HAP_PLUGIN: 'hap' } }; }
      throw new Error(`Unexpected guard dependency ${name}`);
    },
  });
  for (const mode of ['Debug', 'debug', 'test', 'Release', 'release']) {
    let callback: (() => void) | undefined;
    exports_.ohmateRuntimePlugin!().apply({ afterNodeEvaluate: (fn: () => void) => { callback = fn; },
      getContext: () => ({ getBuildMode: () => mode }) });
    expect(callback).toBeTypeOf('function');
    expect(callback!).toThrow(mode === 'release' ? 'OHMATE_RELEASE_PURITY_UNVERIFIED' : 'OHMATE_PROFILE_BUILD_MODE_MISMATCH');
  }
});
