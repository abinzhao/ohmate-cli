/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { buildProblemPackage, problemHash, verifyProblemArchive, verifyProblemPackage } from './package.js';
import { readProblemZip, readProblemZipAt, storedProblemZip } from './zip.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xHkAAAAASUVORK5CYII=', 'base64');
const source = { id: 'fixture-import', kind: 'manual-import', provenance: 'peer-reported' };
function input(bytes = Buffer.from('Reason: fixture-only fault\n'), path = 'faultlog/fixture.log') {
  return { debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)],
    kit: { files: [], attachments: [{ path, bytes, source, status: 'captured', dropped: 0, sampled: false, review: 'explicit-export' }] } };
}
function rehashed(bytes: Buffer, change: (files: Map<string, Buffer>, manifest: Record<string, unknown>) => void) {
  const files = new Map([...readProblemZip(bytes)].map(([path, file]) => [path, file.read()]));
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  change(files, manifest);
  for (const file of manifest.files) {
    const value = files.get(file.path)!; Object.assign(file, { size: value.length, sha256: problemHash(value) });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return storedProblemZip(files);
}
async function positional(bytes: Buffer, signal = new AbortController().signal, reads: number[] = []) {
  return readProblemZipAt(bytes.length, async (offset, length) => {
    reads.push(length); return bytes.subarray(offset, offset + length);
  }, signal);
}

it('requires explicit attachment review and returns metadata without raw text or pixels', () => {
  const value = input(), result = buildProblemPackage(value);
  expect(result.manifest.files.find((file) => file.path === 'faultlog/fixture.log'))
    .toMatchObject({ type: 'text', sensitivity: 'reviewed-attachment' });
  const checked = verifyProblemPackage(result.bytes);
  expect(checked.kit).toMatchObject({ attachmentPolicy: 'user-reviewed', files: [{
    path: 'faultlog/fixture.log', count: 1, representation: 'attachment', review: 'explicit-export', source,
  },] });
  expect(JSON.stringify(checked)).not.toContain('Reason: fixture-only fault');
  expect(checked.payloadIntegrity).toBe('verified');
});

it.each(['snapshots/fixture.png', 'snapshots/fixture.jpg', 'faultlog/fixture.txt'])('allows reviewed inert attachment %s', (path) => {
  const bytes = path.endsWith('.png') ? png : path.endsWith('.jpg') ? Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]) :
    Buffer.from('Synthetic fault only\n');
  const result = buildProblemPackage(input(bytes, path));
  expect(verifyProblemPackage(result.bytes).kit!.files[0].path).toBe(path);
});

it.each(['missing-review', 'empty', 'wrong-magic', 'invalid-utf8', 'null-text', 'script', 'wrong-directory', 'traversal'])(
  'rejects unsafe attachment input: %s', (change) => {
    const value = input(), attachment = value.kit.attachments[0];
    if (change === 'missing-review') { attachment.review = 'none'; }
    if (change === 'empty') { attachment.bytes = Buffer.alloc(0); }
    if (change === 'wrong-magic') { attachment.path = 'snapshots/fixture.png'; }
    if (change === 'invalid-utf8') { attachment.bytes = Buffer.from([255]); }
    if (change === 'null-text') { attachment.bytes = Buffer.from([0]); }
    if (change === 'script') { attachment.path = 'snapshots/fixture.svg'; }
    if (change === 'wrong-directory') { attachment.path = 'web-dom/fixture.log'; }
    if (change === 'traversal') { attachment.path = 'faultlog/../fixture.log'; }
    expect(() => buildProblemPackage(value)).toThrow();
  });

it.each(['role', 'review', 'magic', 'count', 'policy'])('rejects rehashed attachment with forged %s', (change) => {
  const result = buildProblemPackage(input(png, 'snapshots/fixture.png'));
  const bytes = rehashed(result.bytes, (files, manifest) => {
    const profile = JSON.parse(files.get('profile.json')!.toString());
    if (change === 'role') { (manifest.files as Array<Record<string, unknown>>).find((file) => file.path === 'snapshots/fixture.png')!.type = 'json'; }
    if (change === 'review') { profile.files[0].review = 'none'; }
    if (change === 'magic') { files.set('snapshots/fixture.png', Buffer.from('not an image')); }
    if (change === 'count') { profile.files[0].count = 2; }
    if (change === 'policy') { profile.attachmentPolicy = 'none'; }
    files.set('profile.json', Buffer.from(JSON.stringify(profile)));
  });
  expect(() => verifyProblemPackage(bytes)).toThrow();
});

it('streams an 8 MiB attachment through the public archive verifier without aggregate allocation', async () => {
  const text = Buffer.from(randomBytes(4 * 1024 ** 2).toString('hex'));
  const result = buildProblemPackage(input(text)), reads: number[] = [], files = await positional(result.bytes, undefined, reads);
  const allocation = Buffer.alloc, concat = Buffer.concat;
  vi.spyOn(Buffer, 'alloc').mockImplementation((size, ...args) => {
    if (size > 4 * 1024 ** 2) { throw new Error('TEST_ATTACHMENT_ALLOCATION'); }
    return allocation(size, ...args);
  });
  vi.spyOn(Buffer, 'concat').mockImplementation((buffers, length) => {
    if ((length ?? buffers.reduce((sum, buffer) => sum + buffer.length, 0)) > 4 * 1024 ** 2) {
      throw new Error('TEST_ATTACHMENT_CONCAT');
    }
    return concat(buffers, length);
  });
  const file = files.get('faultlog/fixture.log')!, originalRead = file.read.bind(file);
  const read = vi.spyOn(file, 'read').mockImplementation(originalRead);
  const checked = await verifyProblemArchive(files, new AbortController().signal);
  expect(checked.payloadIntegrity).toBe('verified');
  expect(checked.kit!.files[0]).toMatchObject({ count: 1, representation: 'attachment' });
  expect(read).not.toHaveBeenCalled();
  expect(Math.max(...reads)).toBeLessThanOrEqual(65536);
});

it('verifies every attachment byte and rejects hash and CRC disagreement', async () => {
  const result = buildProblemPackage(input());
  const hashFiles = new Map([...readProblemZip(result.bytes)].map(([path, file]) => [path, file.read()]));
  const manifest = JSON.parse(hashFiles.get('manifest.json')!.toString());
  manifest.files.find((file: { path: string }) => file.path === 'faultlog/fixture.log').sha256 = '0'.repeat(64);
  hashFiles.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  await expect(verifyProblemArchive(await positional(storedProblemZip(hashFiles)), new AbortController().signal)).rejects.toThrow('PROBLEM_HASH_MISMATCH');
  const crc = Buffer.from(result.bytes), end = crc.length - 22, central = crc.readUInt32LE(end + 16);
  let offset = central;
  while (crc.subarray(offset + 46, offset + 46 + crc.readUInt16LE(offset + 28)).toString() !== 'faultlog/fixture.log') {
    offset += 46 + crc.readUInt16LE(offset + 28);
  }
  crc.writeUInt32LE(0, offset + 16); crc.writeUInt32LE(0, crc.readUInt32LE(offset + 42) + 14);
  await expect(verifyProblemArchive(await positional(crc), new AbortController().signal)).rejects.toThrow('PROBLEM_CRC');
});

it('supports deflated attachments and stops after cancellation during a chunk read', async () => {
  const text = Buffer.from(randomBytes(128 * 1024).toString('hex'));
  const files = new Map([['faultlog/fixture.log', text]]);
  const original = storedProblemZip(files), end = original.length - 22, centralStart = original.readUInt32LE(end + 16);
  let central = centralStart;
  while (original.subarray(central + 46, central + 46 + original.readUInt16LE(central + 28)).toString() !== 'faultlog/fixture.log') {
    central += 46 + original.readUInt16LE(central + 28);
  }
  const local = original.readUInt32LE(central + 42), start = local + 30 + original.readUInt16LE(local + 26), packed = deflateRawSync(text);
  // Keep this last member's original directory offsets coherent.
  expect(start + text.length).toBe(centralStart);
  const changed = Buffer.concat([original.subarray(0, start), packed, original.subarray(centralStart)]);
  const delta = packed.length - text.length, updatedCentral = central + delta;
  changed.writeUInt16LE(8, local + 8); changed.writeUInt32LE(packed.length, local + 18);
  changed.writeUInt16LE(8, updatedCentral + 10); changed.writeUInt32LE(packed.length, updatedCentral + 20);
  changed.writeUInt32LE(centralStart + delta, changed.length - 22 + 16);
  // The manifest compression declaration is independently checked; streaming
  // ZIP decoding is exercised here without rewriting the member layout again.
  const entries = await positional(changed), member = entries.get('faultlog/fixture.log')!;
  expect(await member.read(text.length)).toEqual(text);
  const abort = new AbortController(); let reads = 0;
  const cancelled = await readProblemZipAt(changed.length, async (offset, length) => {
    if (offset >= start && offset < start + packed.length && ++reads === 2) { abort.abort(new Error('TEST_CANCEL')); }
    return changed.subarray(offset, offset + length);
  }, abort.signal);
  await expect(cancelled.get('faultlog/fixture.log')!.read(text.length)).rejects.toThrow('TEST_CANCEL');
  expect(reads).toBe(2);
});

it('streams a large deflated attachment with matching manifest and hashes without collecting output', async () => {
  const text = Buffer.from(randomBytes(4 * 1024 ** 2).toString('hex')), result = buildProblemPackage(input(text));
  const content = new Map([...readProblemZip(result.bytes)].map(([path, file]) => [path, file.read()]));
  const manifest = JSON.parse(content.get('manifest.json')!.toString());
  for (const file of manifest.files) { file.compression = 'deflate'; }
  content.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const zip = new AdmZip();
  for (const [path, bytes] of content) { zip.addFile(path, bytes, '', 0o100600); }
  const bytes = zip.toBuffer(), files = await positional(bytes);
  const read = vi.spyOn(files.get('faultlog/fixture.log')!, 'read');
  const concat = Buffer.concat;
  vi.spyOn(Buffer, 'concat').mockImplementation((chunks, size) => {
    if ((size ?? chunks.reduce((total, chunk) => total + chunk.length, 0)) > 4 * 1024 ** 2) {
      throw new Error('TEST_DEFLATE_CONCAT');
    }
    return concat(chunks, size);
  });
  expect((await verifyProblemArchive(files, new AbortController().signal)).payloadIntegrity).toBe('verified');
  expect(read).not.toHaveBeenCalled();
  expect(() => verifyProblemPackage(bytes)).toThrow('PROBLEM_ATTACHMENT_ASYNC_REQUIRED');
});

it('rejects short positional reads and respects an attachment byte budget before reading data', async () => {
  const text = Buffer.from('Synthetic fault text\n'), bytes = storedProblemZip(new Map([['faultlog/fixture.log', text]]));
  const start = 30 + Buffer.byteLength('faultlog/fixture.log'), reads: number[] = [];
  const files = await readProblemZipAt(bytes.length, async (offset, length) => {
    reads.push(offset);
    return bytes.subarray(offset, offset + length - (offset === start ? 1 : 0));
  }, new AbortController().signal);
  await expect(files.get('faultlog/fixture.log')!.consume(text.length - 1, () => {})).rejects.toThrow('PROBLEM_SUMMARY_LIMIT');
  expect(reads).not.toContain(start);
  await expect(files.get('faultlog/fixture.log')!.consume(text.length, () => {})).rejects.toThrow('PROBLEM_FILE_SIZE');
});
