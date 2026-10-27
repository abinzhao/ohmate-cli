/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-deps-'));
  await put('build-profile.json5', { modules: [{ name: 'entry', srcPath: './entry' }, { name: 'shared', srcPath: './shared' }] });
  await put('entry/src/main/module.json5', { module: { name: 'entry', type: 'entry' } });
  await put('shared/src/main/module.json5', { module: { name: 'shared', type: 'har' } });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}
async function run(id = 'deps.analyze', input: unknown = {}) {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute(id, input, context);
}
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
async function ohpm() {
  await put('entry/oh-package.json5', { name: 'entry', version: '1.0.0', dependencies: { '@demo/a': '^1.0.0', shared: 'file:../shared' } });
  await put('shared/oh-package.json5', { name: 'shared', version: '1.0.0' });
  await put('oh-package-lock.json5', {
    lockfileVersion: 3, meta: { enableUnifiedLockfile: true },
    specifiers: { '@demo/a@^1.0.0': '@demo/a@1.2.0' },
    packages: {
      '@demo/a@1.2.0': { name: '@demo/a', version: '1.2.0', integrity, license: 'MIT', dependencies: { b: '2.0.0' } },
      'b@2.0.0': { name: 'b', version: '2.0.0', integrity },
    },
  });
}

it('uses the OHPM v3 specifier map and locked transitive versions with original evidence hashes', async () => {
  await ohpm();
  const before = await readFile(join(root, 'oh-package-lock.json5'));
  const result = await run();
  expect(result.exitCode).toBe(0);
  const graph = result.data as { components: { id: string; name: string; version?: string; origin: string }[]; relationships: { from: string; to: string; kind: string }[]; inputs: { path: string; sha256: string }[] };
  const a = graph.components.find((item) => item.name === '@demo/a')!;
  expect(a).toMatchObject({ version: '1.2.0', origin: 'lock' });
  const b = graph.components.find((item) => item.name === 'b')!;
  expect(graph.relationships).toContainEqual(expect.objectContaining({ from: a.id, to: b.id, kind: 'depends-on' }));
  expect(graph.inputs).toContainEqual(expect.objectContaining({ path: 'oh-package-lock.json5', sha256: createHash('sha256').update(before).digest('hex') }));
  expect(await readFile(join(root, 'oh-package-lock.json5'))).toEqual(before);
});

it('uses module-local locks unless the root lock explicitly enables unified locking', async () => {
  await ohpm();
  await put('oh-package-lock.json5', { lockfileVersion: 3, packages: {}, specifiers: {} });
  await put('entry/oh-package-lock.json5', { lockfileVersion: 3, specifiers: { '@demo/a@^1.0.0': '@demo/a@1.1.0' }, packages: { '@demo/a@1.1.0': { name: '@demo/a', version: '1.1.0', integrity } } });
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({ name: '@demo/a', version: '1.1.0' })]) });
});

it('reports drift separately without replacing the locked version with the manifest range', async () => {
  await ohpm();
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { '@demo/a': '^2.0.0' } });
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({ name: '@demo/a', version: '1.2.0' })]), findings: expect.arrayContaining([expect.objectContaining({ code: 'LOCK_MANIFEST_DRIFT' })]) });
});

it('keeps missing locks and unknown lock versions explicitly incomplete', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { a: '^1.0.0' } });
  const missing = await run();
  expect(missing.exitCode).toBe(3);
  expect(missing.data).toMatchObject({ completeness: 'incomplete', findings: expect.arrayContaining([expect.objectContaining({ code: 'LOCK_MISSING' })]) });
  await put('entry/oh-package-lock.json5', { lockfileVersion: 99, packages: { 'a@1.2.0': { name: 'a', version: '1.2.0' } } });
  const unknown = await run();
  expect(unknown.exitCode).toBe(3);
  expect(unknown.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({ name: 'a', version: null, origin: 'declaration' })]), findings: expect.arrayContaining([expect.objectContaining({ code: 'LOCK_VERSION_UNSUPPORTED' })]) });
});

it('connects local modules and reports cycles without traversing outside the project', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { shared: 'file:../shared' } });
  await put('shared/oh-package.json5', { name: 'shared', dependencies: { entry: 'file:../entry' } });
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_CYCLE', evidence: expect.arrayContaining([expect.objectContaining({ path: 'entry/oh-package.json5' })]) })]) });
});

it('resolves npm v3 workspace links, nested duplicate versions and dependency scopes', async () => {
  await put('cloud/package.json', { name: 'cloud', workspaces: ['functions/*'], dependencies: { a: '^1.0.0', f: 'file:functions/f' }, devDependencies: { tooling: '1.0.0' }, scripts: { postinstall: 'node setup.js' } });
  await put('cloud/functions/f/package.json', { name: 'f', version: '1.0.0', dependencies: { a: '^2.0.0' } });
  await put('cloud/package-lock.json', { lockfileVersion: 3, packages: {
    '': { name: 'cloud', dependencies: { a: '^1.0.0', f: 'file:functions/f' }, devDependencies: { tooling: '1.0.0' } },
    'node_modules/a': { version: '1.1.0', integrity, dependencies: { a: '^2.0.0' }, license: 'MIT' },
    'node_modules/a/node_modules/a': { version: '2.0.0', integrity },
    'node_modules/tooling': { version: '1.0.0', dev: true, integrity },
    'node_modules/f': { resolved: 'functions/f', link: true },
    'functions/f': { name: 'f', version: '1.0.0', dependencies: { a: '^2.0.0' } },
    'functions/f/node_modules/a': { version: '2.0.0', integrity },
  } });
  const result = await run();
  expect(result.exitCode).toBe(1);
  const graph = result.data as { components: { id: string; name: string; version: string; path: string }[]; relationships: { from: string; to: string; scope: string }[]; findings: { code: string }[] };
  expect(graph.components.filter((item) => item.name === 'a').map((item) => item.version)).toEqual(expect.arrayContaining(['1.1.0', '2.0.0']));
  const f = graph.components.find((item) => item.path === 'cloud/functions/f/package.json')!;
  expect(graph.relationships).toContainEqual(expect.objectContaining({ to: f.id, scope: 'production' }));
  expect(graph.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_VERSIONS' }), expect.objectContaining({ code: 'INSTALL_SCRIPT' })]));
});

it('supports npm v2 and degrades npm v1 rather than claiming modern lock semantics', async () => {
  await put('cloud/package.json', { name: 'cloud', dependencies: { a: '^1.0.0' } });
  await put('cloud/package-lock.json', { lockfileVersion: 2, packages: { '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': { version: '1.2.0', integrity } } });
  expect((await run()).exitCode).toBe(0);
  await put('cloud/package-lock.json', { lockfileVersion: 1, dependencies: { a: { version: '1.2.0' } } });
  expect((await run()).exitCode).toBe(3);
});

it('records literal imports, dynamic loads and native bridges without declaring unused packages', async () => {
  await ohpm();
  await put('entry/src/main/ets/page.ets', "import { A } from '@demo/a/internal';\nconst module = import('@demo/a');\nimport addon from 'libentry.so';\n");
  await put('entry/src/main/cpp/CMakeLists.txt', 'add_library(entry SHARED entry.cpp)\ntarget_link_libraries(entry PUBLIC other)\n');
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ relationships: expect.arrayContaining([
    expect.objectContaining({ kind: 'imports', evidence: expect.arrayContaining([expect.objectContaining({ path: 'entry/src/main/ets/page.ets', line: 1 })]) }),
    expect.objectContaining({ kind: 'native-bridge' }),
  ]), findings: expect.arrayContaining([expect.objectContaining({ code: 'DEEP_IMPORT' })]), usage: { unused: 'not-evaluated' } });
});

it('models literal CMake targets and links and marks dynamic CMake incomplete', async () => {
  await put('entry/src/main/cpp/CMakeLists.txt', 'add_library(entry SHARED entry.cpp)\nadd_library(helper STATIC helper.cpp)\ntarget_link_libraries(entry PRIVATE helper PUBLIC libace_napi.z.so)\ntarget_include_directories(helper PUBLIC include)\nadd_subdirectory(${EXTERNAL_DIR})\n');
  const result = await run();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({ name: 'entry', ecosystem: 'native', kind: 'target' }), expect.objectContaining({ name: 'libace_napi.z.so', ecosystem: 'native' })]), relationships: expect.arrayContaining([expect.objectContaining({ kind: 'links' })]), findings: expect.arrayContaining([expect.objectContaining({ code: 'CMAKE_DYNAMIC_UNRESOLVED' })]) });
});

it('exports CycloneDX with valid component references and SPDX with corresponding relationships', async () => {
  await ohpm();
  await put('entry/src/main/cpp/CMakeLists.txt', 'add_library(entry SHARED entry.cpp)\n');
  await put('entry/src/main/ets/page.ets', "import addon from 'libentry.so';\n");
  const cyclonedx = await run('deps.sbom');
  expect(cyclonedx.exitCode).toBe(0);
  const cdx = (cyclonedx.data as { document: { bomFormat: string; specVersion: string; components: { 'bom-ref': string; licenses?: unknown[] }[]; dependencies: { ref: string; dependsOn: string[] }[] } }).document;
  expect(cdx).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6' });
  const refs = new Set(cdx.components.map((item) => item['bom-ref']));
  for (const dep of cdx.dependencies) { expect(refs.has(dep.ref)).toBe(true); for (const ref of dep.dependsOn) { expect(refs.has(ref)).toBe(true); } }
  const spdx = await run('deps.sbom', { standard: 'spdx' });
  expect(spdx.exitCode).toBe(0);
  expect(spdx.data).toMatchObject({ document: { spdxVersion: 'SPDX-2.3', packages: expect.arrayContaining([expect.objectContaining({ name: '@demo/a', licenseDeclared: 'MIT' })]), relationships: expect.arrayContaining([expect.objectContaining({ relationshipType: 'DEPENDS_ON' })]) } });
});

it('explains a transitive package using all recorded inbound relationships', async () => {
  await ohpm();
  const result = await run('deps.why', { name: 'b' });
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ name: 'b', components: expect.arrayContaining([expect.objectContaining({ name: 'b' })]), chains: expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ kind: 'depends-on' })])]) });
  expect((await run('deps.why', { name: 'absent' })).exitCode).toBe(4);
});

it('keeps a complete dependency inventory separate from a truncated deep why explanation', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { 'node-0': '1.0.0' } });
  const packages = Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`node-${index}@1.0.0`, {
    name: `node-${index}`, version: '1.0.0', integrity,
    ...(index < 33 ? { dependencies: { [`node-${index + 1}`]: '1.0.0' } } : {}),
  }]));
  await put('oh-package-lock.json5', { lockfileVersion: 3, meta: { enableUnifiedLockfile: true }, packages,
    specifiers: { 'node-0@1.0.0': 'node-0@1.0.0' } });
  const before = await readFile(join(root, 'oh-package-lock.json5')), result = await run('deps.why', { name: 'node-33' });
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ name: 'node-33', completeness: 'complete', truncated: true });
  const chains = (result.data as { chains: { from: string; to: string; evidence: { path: string; sha256: string }[] }[][] }).chains;
  expect(chains).toHaveLength(1);
  expect(chains[0]).toHaveLength(32);
  expect(chains[0].every((edge, index) => !index || chains[0][index - 1].to === edge.from)).toBe(true);
  expect(chains[0].flatMap((edge) => edge.evidence)).toContainEqual({ path: 'oh-package-lock.json5',
    sha256: createHash('sha256').update(before).digest('hex') });
  expect(await readFile(join(root, 'oh-package-lock.json5'))).toEqual(before);
});

it('runs a local audit that does not fabricate vulnerability or license verification', async () => {
  await ohpm();
  const result = await run('deps.audit');
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ checks: { vulnerabilities: 'not-run', licenseValidation: 'not-run', nativeAbi: 'not-run' } });
});

it('skips ignored directories and refuses symlinks, credentials and external dependency paths', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { a: 'file:../../outside' } });
  await put('node_modules/secret/package.json', { password: 'EXAMPLE_NOT_A_REAL_SECRET' });
  await put('private/package.json', { password: 'EXAMPLE_NOT_A_REAL_SECRET' });
  const result = await run();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: 'LOCAL_DEPENDENCY_OUTSIDE_SCOPE' })]) });
  expect(JSON.stringify(result)).not.toContain('EXAMPLE_NOT_A_REAL_SECRET');
  await rm(join(root, 'entry/oh-package.json5'));
  await symlink(join(root, 'private/package.json'), join(root, 'entry/oh-package.json5'));
  const linked = await run();
  expect(linked.exitCode).toBe(3);
  expect(JSON.stringify(linked)).not.toContain('EXAMPLE_NOT_A_REAL_SECRET');
});

it('does not expose URL credentials or tokens from package metadata', async () => {
  await put('cloud/package.json', { name: 'cloud', dependencies: { a: '^1.0.0' } });
  await put('cloud/package-lock.json', { lockfileVersion: 3, packages: { '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': { version: '1.0.0', resolved: 'https://user:EXAMPLE_ONLY@example.invalid/a.tgz?token=EXAMPLE_ONLY' } } });
  const result = await run();
  expect(result.exitCode).toBe(3);
  expect(JSON.stringify(result)).not.toContain('EXAMPLE_ONLY');
});

it('reports OHPM specifier drift even when the old locked version satisfies the new range', async () => {
  await ohpm();
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { '@demo/a': '^1.1.0' } });
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: 'LOCK_MANIFEST_DRIFT' })]) });
});

it('marks unsupported npm locks incomplete rather than resolving local file dependencies as locked', async () => {
  await put('cloud/package.json', { name: 'cloud', dependencies: { f: 'file:f' } });
  await put('cloud/f/package.json', { name: 'f', version: '1.0.0' });
  await put('cloud/package-lock.json', { lockfileVersion: 1, dependencies: {} });
  expect((await run()).exitCode).toBe(3);
});

it('does not guess among multiple OHPM locked versions when a specifier mapping is absent', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { a: '^1.0.0' } });
  await put('entry/oh-package-lock.json5', { lockfileVersion: 3, specifiers: {}, packages: {
    'a@1.1.0': { name: 'a', version: '1.1.0' }, 'a@1.2.0': { name: 'a', version: '1.2.0' },
  } });
  const result = await run();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({ name: 'a', origin: 'declaration', version: null })]) });
});

it('marks duplicate lock keys and malformed dependency declarations incomplete', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { a: 1 } });
  expect((await run()).exitCode).toBe(3);
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { a: '^1.0.0' } });
  await put('entry/oh-package-lock.json5', '{"lockfileVersion":3,"specifiers":{"a@^1.0.0":"a@1.1.0","a@^1.0.0":"a@1.2.0"},"packages":{"a@1.2.0":{"name":"a","version":"1.2.0"}}}');
  const result = await run();
  expect(result.exitCode).toBe(3);
});

it('does not resolve npm local dependencies through another workspace lock without a registered link', async () => {
  await put('cloud/package.json', { name: 'cloud', dependencies: { a: '^1.0.0' } });
  await put('cloud/package-lock.json', { lockfileVersion: 3, packages: { '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': { version: '1.2.0' } } });
  await put('cloud/unrelated/package.json', { name: 'unrelated', dependencies: { a: '^1.0.0' } });
  const result = await run();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: 'NPM_WORKSPACE_NOT_LOCKED' })]) });
});

it('does not read the OHPM installation directory when collecting project inputs', async () => {
  await ohpm();
  await put('entry/oh_modules/installed/package.json', { password: 'EXAMPLE_NOT_A_REAL_SECRET' });
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ inputs: expect.not.arrayContaining([expect.objectContaining({ path: 'entry/oh_modules/installed/package.json' })]) });
});

it('keeps the locked local OHPM version when the source manifest version drifts', async () => {
  await put('entry/oh-package.json5', { name: 'entry', dependencies: { shared: 'file:../shared' } });
  await put('shared/oh-package.json5', { name: 'shared', version: '2.0.0' });
  await put('entry/oh-package-lock.json5', { lockfileVersion: 3, specifiers: { 'shared@../shared': 'shared@../shared' },
    packages: { 'shared@../shared': { name: 'shared', version: '1.0.0', resolved: '../shared', registryType: 'local' } } });
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({
    path: 'shared/oh-package.json5', version: '1.0.0', declaredVersion: '2.0.0', versionSource: 'lock',
  })]), findings: expect.arrayContaining([expect.objectContaining({ code: 'LOCK_MANIFEST_DRIFT' })]) });
});

it('keeps the locked npm workspace version rather than silently using changed source metadata', async () => {
  await put('cloud/package.json', { name: 'cloud', dependencies: { f: 'file:f' } });
  await put('cloud/f/package.json', { name: 'f', version: '2.0.0' });
  await put('cloud/package-lock.json', { lockfileVersion: 3, packages: {
    '': { name: 'cloud', dependencies: { f: 'file:f' } },
    f: { name: 'f', version: '1.0.0' }, 'node_modules/f': { link: true, resolved: 'f' },
  } });
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ components: expect.arrayContaining([expect.objectContaining({
    path: 'cloud/f/package.json', version: '1.0.0', declaredVersion: '2.0.0', versionSource: 'lock',
  })]) });
});
