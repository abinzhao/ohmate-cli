/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import type { DependencyGraph } from './types.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-native-binary-')); });
afterEach(async () => { await rm(root, { recursive: true }); });
async function put(path: string, value: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}
async function run(id = 'deps.analyze', input: unknown = {}) {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute(id, input, context);
}
function elf(machine = 183, tail = 1) {
  // Synthetic section-bearing ELF exercises bounded metadata; it is not a compiled library.
  const bytes = Buffer.alloc(512), strings = Buffer.from('\0.shstrtab\0');
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(256n, 40); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(2, 60); bytes.writeUInt16LE(1, 62); strings.copy(bytes, 64);
  bytes.writeUInt32LE(1, 320); bytes.writeUInt32LE(3, 324);
  bytes.writeBigUInt64LE(64n, 344); bytes.writeBigUInt64LE(BigInt(strings.length), 352);
  bytes[511] = tail;
  return bytes;
}
async function imported(path = 'libs/libcore.so', bytes = elf()) {
  await put('CMakeLists.txt', `add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION ${path})\n`);
  await put(path, bytes);
}

it('binds an imported target to one observed binary with its raw hash and metadata-only ELF identity', async () => {
  const bytes = elf();
  await imported('libs/libcore.so', bytes);
  const before = await readFile(join(root, 'libs/libcore.so')), result = await run();
  expect(result.exitCode).toBe(0);
  const graph = result.data as DependencyGraph;
  const binary = graph.components.find((node) => node.path === 'libs/libcore.so')!;
  expect(binary).toMatchObject({ name: 'libcore.so', kind: 'library', ecosystem: 'native', origin: 'binary', version: null,
    evidence: [{ path: 'libs/libcore.so', sha256: createHash('sha256').update(bytes).digest('hex') }],
    binary: { byteLength: bytes.length, format: 'elf', elf: { machine: 183, bits: 64, byteOrder: 'little', type: 3, abiHint: 'arm64-v8a' } } });
  const target = graph.components.find((node) => node.name === 'core')!;
  expect(graph.relationships).toContainEqual(expect.objectContaining({ from: target.id, to: binary.id, kind: 'links',
    evidence: expect.arrayContaining([expect.objectContaining({ path: 'CMakeLists.txt', line: 2 }), binary.evidence[0]]) }));
  expect(graph.checks.nativeAbi).toBe('not-run');
  expect(await readFile(join(root, 'libs/libcore.so'))).toEqual(before);
  expect(JSON.stringify(binary)).not.toContain('"sections"');
});

it('exports actual binary SHA-256 in both SBOM standards without reusing CMake hashes', async () => {
  const bytes = elf(), hash = createHash('sha256').update(bytes).digest('hex');
  await imported('libs/libcore.so', bytes);
  const cdx = await run('deps.sbom', { standard: 'cyclonedx' });
  expect(cdx.exitCode).toBe(0);
  expect(cdx.data).toMatchObject({ document: { components: expect.arrayContaining([expect.objectContaining({
    name: 'libcore.so', hashes: [{ alg: 'SHA-256', content: hash }],
    properties: expect.arrayContaining([{ name: 'ohmate:native-abi-validation', value: 'not-run' }]),
  })]) } });
  const spdx = await run('deps.sbom', { standard: 'spdx' });
  expect(spdx.exitCode).toBe(0);
  expect(spdx.data).toMatchObject({ document: { packages: expect.arrayContaining([expect.objectContaining({
    name: 'libcore.so', checksums: [{ algorithm: 'SHA256', checksumValue: hash }], licenseDeclared: 'NOASSERTION',
    comment: expect.stringContaining('nativeAbi=not-run'),
  })]) } });
  const graph = (await run()).data as DependencyGraph, target = graph.components.find((node) => node.kind === 'target')!;
  expect(target.evidence[0].sha256).not.toBe(hash);
  const doc = (cdx.data as { document: { components: { name: string; hashes?: unknown[]; purl?: string }[] } }).document;
  expect(doc.components.find((node) => node.name === 'core')?.hashes).toBeUndefined();
  expect(doc.components.find((node) => node.name === 'libcore.so')?.purl).toBeUndefined();
});

it('connects a literal local link path to binary bytes and deduplicates repeated references', async () => {
  await put('native/CMakeLists.txt', 'add_library(core SHARED core.cpp)\ntarget_link_libraries(core PRIVATE ../libs/libhelper.so ../libs/libhelper.so)\n');
  await put('native/core.cpp', 'int core() { return 1; }\n');
  await put('libs/libhelper.so', elf());
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(0);
  const binary = graph.components.filter((node) => node.origin === 'binary');
  expect(binary).toHaveLength(1);
  expect(binary[0].path).toBe('libs/libhelper.so');
  expect(graph.relationships.filter((edge) => edge.to === binary[0].id)).toHaveLength(1);
});

it('explains the Cloud module to imported Native target to actual binary chain', async () => {
  await imported();
  await put('package.json', JSON.stringify({ name: 'cloud', main: 'index.js', dependencies: { '@hw-agconnect/cloud-server': '1.0.0' } }));
  await put('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'cloud', dependencies: { '@hw-agconnect/cloud-server': '1.0.0' } },
    'node_modules/@hw-agconnect/cloud-server': { version: '1.0.0' },
  } }));
  await put('index.js', "import addon from 'libcore.so';\nexport const handler = () => addon;\n");
  const result = await run('deps.why', { name: 'libcore.so' });
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ project: { kind: 'Mixed' },
    chains: expect.arrayContaining([[expect.objectContaining({ kind: 'native-bridge' }), expect.objectContaining({ kind: 'links' })]]) });
});

it('leaves unreferenced bytes out of binary components and does not guess a bare system link', async () => {
  await put('CMakeLists.txt', 'add_library(core SHARED core.cpp)\ntarget_link_libraries(core PRIVATE helper)\n');
  await put('core.cpp', 'int core() { return 1; }\n');
  await put('libs/libhelper.so', elf());
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(0);
  expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
  expect(graph.components.find((node) => node.name === 'helper')).toMatchObject({ origin: 'cmake' });
});

it.each(['truncated', 'bad-section', 'unknown-format', 'archive'])('retains raw hash and incomplete metadata for %s bytes', async (kind) => {
  const bytes = kind === 'truncated' ? elf().subarray(0, 20) : kind === 'unknown-format' ? Buffer.from('SYNTHETIC_PAYLOAD_ONLY') :
    kind === 'archive' ? Buffer.from('!<arch>\nSYNTHETIC_MEMBER_ONLY') : elf();
  if (kind === 'bad-section') { bytes.writeBigUInt64LE(2n ** 63n, 40); }
  await imported(kind === 'archive' ? 'libs/libcore.a' : 'libs/libcore.so', bytes);
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  const binary = graph.components.find((node) => node.origin === 'binary')!;
  expect(binary).toMatchObject({ evidence: [{ path: binary.path, sha256: createHash('sha256').update(bytes).digest('hex') }] });
  expect(graph.findings).toContainEqual(expect.objectContaining({ code: kind === 'archive' ? 'NATIVE_ARCHIVE_MEMBERS_UNINSPECTED' : 'NATIVE_BINARY_METADATA_UNAVAILABLE', incomplete: true }));
  expect(graph.checks.nativeAbi).toBe('not-run');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PAYLOAD_ONLY');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_MEMBER_ONLY');
});

it('does not map an unsupported ELF machine to an ABI by its path', async () => {
  await imported('arm64-v8a/libcore.so', elf(65535));
  const result = await run();
  expect(result.exitCode).toBe(3);
  const graph = result.data as DependencyGraph;
  expect(graph.components.find((node) => node.origin === 'binary')).toMatchObject({ binary: { elf: { machine: 65535, abiHint: null } } });
  expect(graph.findings).toContainEqual(expect.objectContaining({ code: 'NATIVE_ELF_MACHINE_UNRECOGNIZED' }));
});

it.each(['symlink', 'hardlink', 'empty', 'oversize'])('keeps a %s referenced library unavailable without bypassing safe reads', async (kind) => {
  await imported();
  await rm(join(root, 'libs/libcore.so'));
  await put('private/libcore.so', elf());
  if (kind === 'symlink') { await symlink(join(root, 'private/libcore.so'), join(root, 'libs/libcore.so')); }
  else if (kind === 'hardlink') { await link(join(root, 'private/libcore.so'), join(root, 'libs/libcore.so')); }
  else { await put('libs/libcore.so', Buffer.alloc(kind === 'oversize' ? 8 * 1024 * 1024 + 1 : 0)); }
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
  expect(graph.findings).toContainEqual(expect.objectContaining({ code: 'NATIVE_IMPORTED_LOCATION_UNRESOLVED', incomplete: true }));
});

it('does not confirm conditional, dynamic, escaped or private binary links', async () => {
  await imported();
  for (const cmake of [
    'if(FALSE)\nadd_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION libs/libcore.so)\nendif()\n',
    'add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION ${ROOT}/libs/libcore.so)\n',
    'add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION ../outside/libcore.so)\n',
    'add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION private/libcore.so)\n',
  ]) {
    await put('CMakeLists.txt', cmake);
    const result = await run(), graph = result.data as DependencyGraph;
    expect(result.exitCode).toBe(3);
    expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
  }
});

it('keeps multiple imported locations ambiguous instead of claiming both were linked', async () => {
  await imported();
  await put('libs/libother.so', elf());
  await put('CMakeLists.txt', 'add_library(core SHARED IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION libs/libcore.so)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION libs/libother.so)\n');
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  expect(graph.findings).toContainEqual(expect.objectContaining({ code: 'NATIVE_IMPORTED_LOCATION_AMBIGUOUS', incomplete: true }));
  expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
});

it('reports different referenced bytes with the same library basename as a candidate conflict', async () => {
  await imported();
  await put('other/CMakeLists.txt', 'add_library(other SHARED IMPORTED)\nset_target_properties(other PROPERTIES IMPORTED_LOCATION libcore.so)\n');
  await put('other/libcore.so', elf(183, 2));
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(1);
  expect(graph.components.filter((node) => node.origin === 'binary')).toHaveLength(2);
  expect(graph.findings).toContainEqual(expect.objectContaining({ code: 'NATIVE_BINARY_NAME_CONFLICT', confidence: 'inferred', severity: 'warning',
    evidence: expect.arrayContaining([expect.objectContaining({ path: 'libs/libcore.so' }), expect.objectContaining({ path: 'other/libcore.so' })]) }));
});

it.each([
  'set_target_properties(core PROPERTIES IMPORTED_LOCATION ${FINAL_LIBRARY})',
  'include(overrides.cmake)',
  'add_subdirectory(extra)',
  'set_property(TARGET core PROPERTY IMPORTED_LOCATION libs/libcore.so)',
])('does not certify a literal binary before unresolved configuration: %s', async (override) => {
  await imported();
  const text = await readFile(join(root, 'CMakeLists.txt'), 'utf8');
  await put('CMakeLists.txt', text + override + '\n');
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
});

it('does not bind local link bytes while a dynamic link changes final selection', async () => {
  await put('CMakeLists.txt', 'add_library(core SHARED core.cpp)\ntarget_link_libraries(core PRIVATE libs/libcore.so ${OTHER_LIBS})\ntarget_link_libraries(core PRIVATE libs/libcore.so)\n');
  await put('core.cpp', 'int core() { return 1; }\n');
  await put('libs/libcore.so', elf());
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
});

it('does not warn of a basename conflict when two referenced files have identical bytes', async () => {
  await imported();
  await put('other/CMakeLists.txt', 'add_library(other SHARED IMPORTED)\nset_target_properties(other PROPERTIES IMPORTED_LOCATION libcore.so)\n');
  await put('other/libcore.so', elf());
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(0);
  expect(graph.components.filter((node) => node.origin === 'binary')).toHaveLength(2);
  expect(graph.findings.some((item) => item.code === 'NATIVE_BINARY_NAME_CONFLICT')).toBe(false);
});

it('binds an exact same-directory library path rather than guessing a lib prefix', async () => {
  await put('CMakeLists.txt', 'add_library(core SHARED core.cpp)\ntarget_link_libraries(core PRIVATE libcore.so)\n');
  await put('core.cpp', 'int core() { return 1; }\n');
  await put('libcore.so', elf());
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(0);
  expect(graph.components.find((node) => node.origin === 'binary')).toMatchObject({ path: 'libcore.so' });
});

it('keeps debug or optimized link selection unresolved until configuration is available', async () => {
  await put('CMakeLists.txt', 'add_library(core SHARED core.cpp)\ntarget_link_libraries(core PRIVATE debug libs/libcore.so)\n');
  await put('core.cpp', 'int core() { return 1; }\n');
  await put('libs/libcore.so', elf());
  const result = await run(), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  expect(graph.components.some((node) => node.origin === 'binary')).toBe(false);
});
