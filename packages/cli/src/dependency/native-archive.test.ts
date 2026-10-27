/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import type { DependencyGraph } from './types.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-native-archive-')); });
afterEach(async () => { await rm(root, { recursive: true }); });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function object(machine = 183, bits = 64, little = true) {
  // Synthetic ELF tests format boundaries; real compiler archives are checked separately.
  const bytes = Buffer.alloc(512), strings = Buffer.from('\0.shstrtab\0');
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, little ? 1 : 2, 1]).copy(bytes);
  const u16 = (offset: number, value: number) => little ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const word = (offset: number, value: number) => bits === 64 ?
    little ? bytes.writeBigUInt64LE(BigInt(value), offset) : bytes.writeBigUInt64BE(BigInt(value), offset) :
    little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  u16(16, 1); u16(18, machine); word(bits === 64 ? 40 : 32, 256);
  u16(bits === 64 ? 58 : 46, bits === 64 ? 64 : 40); u16(bits === 64 ? 60 : 48, 2); u16(bits === 64 ? 62 : 50, 1);
  strings.copy(bytes, 64);
  const section = 256 + (bits === 64 ? 64 : 40);
  if (little) { bytes.writeUInt32LE(1, section); bytes.writeUInt32LE(3, section + 4); }
  else { bytes.writeUInt32BE(1, section); bytes.writeUInt32BE(3, section + 4); }
  word(section + (bits === 64 ? 24 : 16), 64); word(section + (bits === 64 ? 32 : 20), strings.length);
  return bytes;
}
function member(name: string, bytes: Buffer) {
  const header = Buffer.from(name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) +
    '100644'.padEnd(8) + String(bytes.length).padEnd(10) + '`\n');
  expect(header.length).toBe(60);
  return Buffer.concat([header, bytes, ...(bytes.length % 2 ? [Buffer.from('\n')] : [])]);
}
const archive = (...members: Buffer[]) => Buffer.concat([Buffer.from('!<arch>\n'), ...members]);
async function run(bytes: Buffer, id = 'deps.analyze', input: unknown = {}) {
  await mkdir(join(root, 'libs'), { recursive: true });
  await writeFile(join(root, 'CMakeLists.txt'), 'add_library(core STATIC IMPORTED)\nset_target_properties(core PROPERTIES IMPORTED_LOCATION libs/libcore.a)\n');
  await writeFile(join(root, 'libs/libcore.a'), bytes);
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute(id, input, context);
}
const binary = (graph: DependencyGraph) => graph.components.find(node => node.origin === 'binary')!;

it('hashes the embedded object bytes with offsets independent of header and alignment padding', async () => {
  const bytes = object(), odd = Buffer.concat([bytes, Buffer.from([7])]);
  const raw = archive(member('first.o/', odd), member('second.o/', bytes));
  const result = await run(raw), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(0);
  expect(binary(graph)).toMatchObject({ evidence: [{ path: 'libs/libcore.a', sha256: sha(raw) }],
    binary: { format: 'ar-header', archive: { status: 'complete', gaps: [], members: [
      { index: 0, name: 'first.o', role: 'object', headerOffset: 8, offset: 68, byteLength: odd.length, sha256: sha(odd),
        format: 'elf', elf: { type: 1, machine: 183, bits: 64, byteOrder: 'little', abiHint: 'arm64-v8a' } },
      { index: 1, name: 'second.o', role: 'object', headerOffset: 582, offset: 642, byteLength: bytes.length, sha256: sha(bytes) },
    ] } } });
  expect(graph.checks.nativeAbi).toBe('not-run');
  expect(await readFile(join(root, 'libs/libcore.a'))).toEqual(raw);
});

it('resolves GNU long names and records table hashes without exposing table payloads', async () => {
  const name = 'ohmate_long_archive_member.o', table = Buffer.from(name + '/\n'), symbol = Buffer.from([0, 0, 0, 0]);
  const bytes = object(), result = await run(archive(member('/', symbol), member('//', table), member('/0', bytes)));
  expect(result.exitCode).toBe(0);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { members: [
    { index: 0, role: 'symbol-table', sha256: sha(symbol) }, { index: 1, role: 'name-table', sha256: sha(table) },
    { index: 2, role: 'object', name, sha256: sha(bytes) },
  ] } } });
  expect(JSON.stringify(result)).not.toContain(name + '/\\n');
});

it.each(['__.SYMDEF', '__.SYMDEF SORTED', '__.SYMDEF_64', '__.SYMDEF_64 SORTED'])('separates BSD %s from object metadata', async name => {
  const padded = Buffer.alloc(24); Buffer.from(name).copy(padded);
  const bytes = object(), objectName = Buffer.from('long_object_name.o\0\0');
  const raw = archive(member('#1/24', Buffer.concat([padded, Buffer.from([1, 2, 3, 4])])),
    member('#1/' + objectName.length, Buffer.concat([objectName, bytes])));
  const result = await run(raw);
  expect(result.exitCode).toBe(0);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { members: [
    { role: 'symbol-table', name, byteLength: 4, sha256: sha(Buffer.from([1, 2, 3, 4])) },
    { role: 'object', name: 'long_object_name.o', offset: 68 + 28 + 60 + objectName.length, sha256: sha(bytes) },
  ] } } });
});

it('retains duplicate declared names as distinct ordered byte ranges', async () => {
  const first = object(), second = object(62);
  const result = await run(archive(member('same.o/', first), member('same.o/', second)));
  expect(result.exitCode).toBe(0);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { members: [
    { index: 0, name: 'same.o', sha256: sha(first), elf: { machine: 183 } },
    { index: 1, name: 'same.o', sha256: sha(second), elf: { machine: 62 } },
  ] } } });
  expect((result.data as DependencyGraph).checks.nativeAbi).toBe('not-run');
});

it.each([[40, 32, true], [3, 32, false], [62, 64, false]])('keeps member machine %i, %i-bit and endian %s declarations', async (machine, bits, little) => {
  const result = await run(archive(member('core.o/', object(machine as number, bits as number, little as boolean))));
  expect(result.exitCode).toBe(0);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { members: [
    { elf: { machine, bits, byteOrder: little ? 'little' : 'big' } },
  ] } } });
});

it.each(['truncated-header', 'truncated-data', 'bad-size', 'negative-size', 'bad-trailer', 'missing-pad', 'bad-pad',
  'missing-table', 'middle-name-offset', 'out-of-range-offset', 'duplicate-table', 'bad-bsd-size', 'zero-bsd-size',
  'unterminated-long-name'])('retains archive hash and a structural gap for %s', async kind => {
  const entry = member('core.o/', object()), table = member('//', Buffer.from('long_name.o/\n'));
  let raw = archive(entry);
  if (kind === 'truncated-header') { raw = raw.subarray(0, 30); }
  if (kind === 'truncated-data') { raw = raw.subarray(0, raw.length - 1); }
  if (kind === 'bad-size') { raw.write('12x       ', 56); }
  if (kind === 'negative-size') { raw.write('-1        ', 56); }
  if (kind === 'bad-trailer') { raw[66] = 0; }
  if (kind === 'missing-pad' || kind === 'bad-pad') {
    raw = archive(member('odd.o/', Buffer.concat([object(), Buffer.from([1])])));
    if (kind === 'missing-pad') { raw = raw.subarray(0, raw.length - 1); } else { raw[raw.length - 1] = 0; }
  }
  if (kind === 'missing-table') { raw = archive(member('/0', object())); }
  if (kind === 'middle-name-offset') { raw = archive(table, member('/1', object())); }
  if (kind === 'out-of-range-offset') { raw = archive(table, member('/999', object())); }
  if (kind === 'duplicate-table') { raw = archive(table, table, entry); }
  if (kind === 'bad-bsd-size') { raw = archive(member('#1/999', object())); }
  if (kind === 'zero-bsd-size') { raw = archive(member('#1/0', object())); }
  if (kind === 'unterminated-long-name') { raw = archive(member('//', Buffer.from('not_terminated')), member('/0', object())); }
  const result = await run(raw), graph = result.data as DependencyGraph;
  expect(result.exitCode).toBe(3);
  expect(binary(graph)).toMatchObject({ evidence: [{ path: 'libs/libcore.a', sha256: sha(raw) }],
    binary: { archive: { status: 'incomplete', gaps: expect.arrayContaining(['malformed']) } } });
  expect(graph.findings).toContainEqual(expect.objectContaining({ code: 'NATIVE_ARCHIVE_MEMBERS_UNINSPECTED', incomplete: true }));
});

it.each(['../escape.o', '/outside.o', '.env', 'credentials.o', 'bad\nname.o', 'access_token=fixture_only'])('omits unsafe declared member name %s without reading a named file', async name => {
  const encoded = Buffer.from(name), bytes = object();
  const result = await run(archive(member('#1/' + encoded.length, Buffer.concat([encoded, bytes]))));
  expect(result.exitCode).toBe(3);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { status: 'incomplete',
    gaps: expect.arrayContaining(['member-name-unavailable']), members: [expect.not.objectContaining({ name })] } } });
  expect(JSON.stringify(result)).not.toContain(name);
});

it.each(['invalid-utf8', 'interior-nul', 'oversized-name', 'oversized-table'])('bounds %s name decoding', async kind => {
  const encoded = kind === 'invalid-utf8' ? Buffer.from([0xff]) : kind === 'interior-nul' ? Buffer.from('one\0two') : Buffer.alloc(257, 97);
  const raw = kind === 'oversized-table' ? archive(member('//', Buffer.alloc(65537)), member('/0', object())) :
    archive(member('#1/' + encoded.length, Buffer.concat([encoded, object()])));
  const result = await run(raw);
  expect(result.exitCode).toBe(3);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { status: 'incomplete',
    gaps: expect.arrayContaining([kind === 'oversized-table' ? 'name-table-limit' : 'member-name-unavailable']) } } });
});

it.each(['non-elf', 'nested-archive', 'unknown-machine', 'non-relocatable', 'empty-object', 'empty-archive'])('keeps %s metadata incomplete while hashing supported ranges', async kind => {
  let bytes = kind === 'non-elf' ? Buffer.from('PRIVATE_MEMBER_PAYLOAD_ONLY') :
    kind === 'nested-archive' ? archive(member('nested.o/', object())) : kind === 'empty-object' ? Buffer.alloc(0) : object(65535);
  if (kind === 'non-relocatable') { bytes = object(); bytes.writeUInt16LE(3, 16); }
  const result = await run(kind === 'empty-archive' ? archive() : archive(member('core.o/', bytes)));
  expect(result.exitCode).toBe(3);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { archive: { status: 'incomplete' } } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_MEMBER_PAYLOAD_ONLY');
  expect((result.data as DependencyGraph).checks.nativeAbi).toBe('not-run');
});

it('does not traverse thin archive names even when a matching source object exists', async () => {
  await writeFile(join(root, 'external.o'), object());
  const raw = Buffer.concat([Buffer.from('!<thin>\n'), member('//', Buffer.from('external.o/\n')), member('/0', Buffer.alloc(0))]);
  const result = await run(raw);
  expect(result.exitCode).toBe(3);
  expect(binary(result.data as DependencyGraph)).toMatchObject({ binary: { format: 'ar-thin',
    archive: { status: 'incomplete', gaps: ['thin-external-members'], members: [] } } });
  expect((result.data as DependencyGraph).findings).toContainEqual(expect.objectContaining({
    code: 'NATIVE_ARCHIVE_MEMBERS_UNINSPECTED', incomplete: true,
  }));
  expect((result.data as DependencyGraph).inputs.some(item => item.path === 'external.o')).toBe(false);
});

it('stops before admitting member 257 while exactly 256 object members remain supported', async () => {
  const entry = member('core.o/', object());
  const complete = await run(archive(...Array.from({ length: 256 }, () => entry)));
  expect(complete.exitCode).toBe(0);
  const limited = await run(archive(...Array.from({ length: 257 }, () => entry)));
  expect(limited.exitCode).toBe(3);
  expect(binary(limited.data as DependencyGraph)).toMatchObject({ binary: { archive: {
    status: 'incomplete', gaps: ['member-limit'], members: expect.any(Array),
  } } });
  const value = binary(limited.data as DependencyGraph).binary as unknown as { archive: { members: unknown[] } };
  expect(value.archive.members).toHaveLength(256);
});

it.each(['cyclonedx', 'spdx'])('preserves archive and member hashes in %s without inventing member dependencies', async standard => {
  const bytes = object(), raw = archive(member('core.o/', bytes)), hash = sha(raw);
  const result = await run(raw, 'deps.sbom', { standard });
  expect(result.exitCode).toBe(0);
  const data = result.data as { document: { components?: { name: string; hashes?: unknown[]; properties: { name: string; value: string }[] }[];
    packages?: { name: string; checksums?: unknown[]; comment: string }[] }; relationships: unknown[] };
  if (standard === 'cyclonedx') {
    const library = data.document.components!.find(item => item.name === 'libcore.a')!;
    expect(library.hashes).toEqual([{ alg: 'SHA-256', content: hash }]);
    expect(library.properties.find(item => item.name === 'ohmate:native-binary')?.value).toContain(sha(bytes));
    expect(data.document.components!.some(item => item.name === 'core.o')).toBe(false);
  } else {
    const library = data.document.packages!.find(item => item.name === 'libcore.a')!;
    expect(library.checksums).toEqual([{ algorithm: 'SHA256', checksumValue: hash }]);
    expect(library.comment).toContain(sha(bytes)); expect(library.comment).toContain('nativeAbi=not-run');
    expect(data.document.packages!.some(item => item.name === 'core.o')).toBe(false);
  }
  expect(data.relationships).toHaveLength(1);
});
