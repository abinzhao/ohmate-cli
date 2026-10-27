/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { readProject } from './project-reader.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-facets-')); });
afterEach(async () => { await rm(root, { recursive: true }); });
async function put(path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
async function run(id = 'project.inspect', input: unknown = {}) {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute(id, input, context);
}
async function cloud(directory = '.') {
  const prefix = directory === '.' ? '' : `${directory}/`;
  await put(`${prefix}package.json`, { name: 'cloud-function', main: 'src/index.js', dependencies: { '@hw-agconnect/cloud-server': '^1.0.0' } });
  await put(`${prefix}src/index.js`, "const cloud = require('@hw-agconnect/cloud-server');\nexports.handler = () => cloud;\n");
  await put(`${prefix}package-lock.json`, { lockfileVersion: 3, packages: {
    '': { name: 'cloud-function', dependencies: { '@hw-agconnect/cloud-server': '^1.0.0' } },
    'node_modules/@hw-agconnect/cloud-server': { version: '1.0.0' },
  } });
}
async function native(directory = '.') {
  const prefix = directory === '.' ? '' : `${directory}/`;
  await put(`${prefix}CMakeLists.txt`, 'add_library(core SHARED src/core.cpp)\ntarget_link_libraries(core PUBLIC helper)\nadd_library(helper STATIC src/helper.cpp)\n');
  await put(`${prefix}src/core.cpp`, 'int core() { return 1; }\n');
  await put(`${prefix}src/helper.cpp`, 'int helper() { return 2; }\n');
}
async function arkts() {
  await put('build-profile.json5', { app: { products: [{ name: 'default', compatibleSdkVersion: '7.0.0(26)' }] },
    modules: [{ name: 'phone', srcPath: './products/phone', targets: [{ name: 'default' }] }] });
  await put('products/phone/src/main/module.json5', { module: { name: 'phone', type: 'entry', deviceTypes: ['phone'] } });
  await put('products/phone/src/main/ets/Index.ets', '@Entry @ComponentV2 struct Index { build() { Text("example") } }\n');
}

it('recognizes standalone Cloud from its server declaration and referenced entry without requiring ArkTS markers', async () => {
  await cloud();
  const before = await readdir(root);
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'Cloud', facets: ['Cloud'], modules: [], cloud: [
    expect.objectContaining({ path: '.', entry: 'src/index.js', basis: 'server-sdk-entry' }),
  ], checks: { officialBuild: 'not-run', cloudRuntime: 'not-run', nativeAbi: 'not-run' } });
  const bytes = await readFile(join(root, 'package.json'));
  expect(result.data).toMatchObject({ inputs: expect.arrayContaining([
    { path: 'package.json', sha256: createHash('sha256').update(bytes).digest('hex') },
  ]) });
  expect(await readdir(root)).toEqual(before);
});

it('recognizes standalone Native only when CMake targets refer to actual native inputs', async () => {
  await native();
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'Native', facets: ['Native'], native: expect.arrayContaining([
    expect.objectContaining({ target: 'core', sources: [expect.objectContaining({ path: 'src/core.cpp' })] }),
  ]) });
});

it('recognizes a layered ArkTS module from the profile path, source and SDK configuration', async () => {
  await arkts();
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'ArkTS', facets: ['ArkTS'], modules: [
    { name: 'phone', path: join(root, 'products/phone'), type: 'entry', targets: ['default'], deviceTypes: ['phone'] },
  ], products: [{ name: 'default', compatibleSdkVersion: '7.0.0(26)' }] });
});

it('combines independently evidenced facets and keeps their source hashes', async () => {
  await arkts(); await cloud('backend'); await native('products/phone/src/main/cpp');
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'Mixed', facets: ['ArkTS', 'Cloud', 'Native'] });
  const project = result.data as { facetEvidence: Record<string, { path: string; sha256: string }[]> };
  for (const facet of ['ArkTS', 'Cloud', 'Native']) {
    expect(project.facetEvidence[facet].length).toBeGreaterThan(1);
    for (const input of project.facetEvidence[facet]) {
      expect(input.sha256).toBe(createHash('sha256').update(await readFile(join(root, input.path))).digest('hex'));
    }
  }
});

it('does not infer a facet from directory names, ordinary npm metadata or CMake filenames alone', async () => {
  await put('cloud/package.json', { name: 'ordinary-client', main: 'index.js' });
  await put('cloud/index.js', 'export const value = 1;\n');
  await put('cpp/CMakeLists.txt', '# add_library(core SHARED core.cpp)\n');
  await put('cpp/core.cpp', 'int core() { return 1; }\n');
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ kind: 'unknown', facets: [] });
});

it('does not promote missing or unrelated source paths into Cloud or Native evidence', async () => {
  await cloud(); await native();
  await rm(join(root, 'src/index.js')); await rm(join(root, 'src/core.cpp')); await rm(join(root, 'src/helper.cpp'));
  await put('elsewhere/index.js', 'exports.handler = () => 1;\n');
  await put('elsewhere/core.cpp', 'int core() { return 1; }\n');
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ kind: 'unknown', facets: [], completeness: 'incomplete' });
});

it('preserves unknown diagnostics for broken ArkTS metadata while discovering a separate Native facet', async () => {
  await put('build-profile.json5', '{modules:[}');
  await native();
  const result = await run();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ kind: 'Native', facets: ['Native'], completeness: 'incomplete',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_INPUT_UNAVAILABLE' })]) });
});

it('keeps the strict ArkTS reader unavailable for independently inspected Cloud and Native roots', async () => {
  await cloud(); await native();
  expect((await run()).data).toMatchObject({ kind: 'Mixed', facets: ['Cloud', 'Native'] });
  await expect(readProject(root)).rejects.toThrow();
  await put('oh-package.json5', { name: 'fixture' });
  const config = await run('config.inspect', { path: 'oh-package.json5' });
  expect(config.exitCode).toBe(4);
  expect(config.data).toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringContaining('build-profile.json5') });
});

it.each(['symlink', 'hardlink'])('refuses a %s entry as Cloud evidence and does not copy its text', async (kind) => {
  await cloud();
  await put('private/index.js', 'SYNTHETIC_PRIVATE_VALUE');
  await rm(join(root, 'src/index.js'));
  if (kind === 'symlink') { await symlink(join(root, 'private/index.js'), join(root, 'src/index.js')); }
  else { await link(join(root, 'private/index.js'), join(root, 'src/index.js')); }
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ facets: [], completeness: 'incomplete' });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
});

it('rejects escapes, product state, installed packages and sensitive paths as declared entries', async () => {
  await cloud();
  for (const entry of ['../outside.js', 'private/index.js', 'node_modules/a/index.js', 'oh_modules/a/index.js', 'credentials/index.js']) {
    await put('package.json', { name: 'cloud', main: entry, dependencies: { '@hw-agconnect/cloud-server': '1.0.0' } });
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect(result.data).toMatchObject({ facets: [], completeness: 'incomplete' });
  }
});

it('records an imported native library raw hash without decoding its bytes or asserting ABI', async () => {
  await put('CMakeLists.txt', 'add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION libs/libcore.so)\n');
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x00]);
  await put('libs/libcore.so', bytes);
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'Native', native: [expect.objectContaining({
    target: 'core', libraries: [{ path: 'libs/libcore.so', sha256: createHash('sha256').update(bytes).digest('hex') }],
  })], checks: { nativeAbi: 'not-run' } });
});

it('does not treat an empty imported library as available Native input', async () => {
  await put('CMakeLists.txt', 'add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION libs/libcore.so)\n');
  await put('libs/libcore.so', Buffer.alloc(0));
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ facets: [], completeness: 'incomplete' });
});

it('bounds source reads and retains incomplete evidence instead of accepting an oversized entry', async () => {
  await cloud();
  await put('src/index.js', 'x'.repeat(8 * 1024 * 1024 + 1));
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ kind: 'unknown', completeness: 'incomplete' });
});

it.each([
  'message("add_library(core SHARED src/core.cpp)")\n',
  '#[=[\nadd_library(core SHARED src/core.cpp)\n]=]\n',
])('does not identify CMake commands in strings or bracket comments: %s', async (cmake) => {
  await native(); await put('CMakeLists.txt', cmake);
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ kind: 'unknown', native: [] });
});

it('keeps conditional CMake declarations unverified instead of certifying an inactive target', async () => {
  await native(); await put('CMakeLists.txt', 'if(FALSE)\nadd_library(core SHARED src/core.cpp)\nendif()\n');
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ facets: [], completeness: 'incomplete',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_NATIVE_CONFIG_UNRESOLVED' })]) });
});

it('does not reuse root SDK evidence for a module whose only source is a type declaration', async () => {
  await arkts();
  await rm(join(root, 'products/phone/src/main/ets/Index.ets'));
  await put('products/phone/src/main/ets/types.d.ts', 'declare const addon: string;\n');
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ facets: [], modules: [expect.objectContaining({ name: 'phone' })] });
});

it('retains an unavailable input diagnostic after exhausting the entry budget', async () => {
  await mkdir(join(root, 'many'));
  for (let offset = 0; offset < 10_001; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 10_001 - offset) }, (_, index) =>
      writeFile(join(root, 'many', `entry-${offset + index}.txt`), '')));
  }
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ completeness: 'incomplete',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_INPUT_UNAVAILABLE' })]) });
});

it('bounds CMake command parsing and reports the unparsed remainder', async () => {
  await native();
  await put('CMakeLists.txt', 'message("bounded")\n'.repeat(2_001) + 'add_library(core SHARED src/core.cpp)\n');
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ facets: [], completeness: 'incomplete',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_NATIVE_CONFIG_UNRESOLVED' })]) });
  expect((await run('deps.analyze')).exitCode).toBe(3);
});

it('bounds profile module discovery and does not probe paths beyond that budget', async () => {
  await arkts();
  await put('build-profile.json5', { modules: Array.from({ length: 2_001 }, () => ({ name: 'phone', srcPath: './products/phone' })) });
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.data).toMatchObject({ modules: [], completeness: 'incomplete',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_MODULE_BUDGET_EXCEEDED' })]) });
});

it('analyzes and exports standalone Cloud dependencies through the shared registry', async () => {
  await cloud();
  const result = await run('deps.analyze');
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ project: { kind: 'Cloud' }, components: expect.arrayContaining([
    expect.objectContaining({ name: '@hw-agconnect/cloud-server', ecosystem: 'npm', version: '1.0.0', origin: 'lock' }),
  ]) });
  expect((await run('deps.why', { name: '@hw-agconnect/cloud-server' })).exitCode).toBe(0);
  expect((await run('deps.audit')).data).toMatchObject({ project: { kind: 'Cloud' } });
  for (const standard of ['cyclonedx', 'spdx']) {
    const sbom = await run('deps.sbom', { standard });
    expect(sbom.exitCode).toBe(0);
    expect(sbom.data).toMatchObject({ project: { kind: 'Cloud' }, document: expect.any(Object) });
    expect(JSON.stringify(sbom)).toContain('Cloud');
  }
});

it('preserves a Cloud to Native import bridge in both SBOM formats without ArkTS markers', async () => {
  await cloud(); await native('native');
  await put('src/index.js', "import addon from 'libcore.so';\nexport const handler = () => addon;\n");
  const analyzed = await run('deps.analyze');
  expect(analyzed.exitCode).toBe(0);
  expect(analyzed.data).toMatchObject({ project: { kind: 'Mixed', facets: ['Cloud', 'Native'] },
    relationships: expect.arrayContaining([expect.objectContaining({ kind: 'native-bridge' })]) });
  const cdx = await run('deps.sbom', { standard: 'cyclonedx' });
  expect(cdx.exitCode).toBe(0);
  const doc = (cdx.data as { document: { components: { 'bom-ref': string; name: string }[]; dependencies: { ref: string; dependsOn: string[] }[] } }).document;
  const module = doc.components.find((item) => item.name === 'cloud-function')!;
  const target = doc.components.find((item) => item.name === 'core')!;
  expect(doc.dependencies).toContainEqual(expect.objectContaining({ ref: module['bom-ref'], dependsOn: expect.arrayContaining([target['bom-ref']]) }));
  expect((await run('deps.sbom', { standard: 'spdx' })).data).toMatchObject({ document: {
    relationships: expect.arrayContaining([expect.objectContaining({ relationshipType: 'DEPENDS_ON', comment: 'kind=native-bridge; scope=production' })]),
  } });
});
