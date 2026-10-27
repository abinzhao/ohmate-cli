/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { expect, it } from 'vitest';

async function api() {
  expect(existsSync(new URL('./zip.ts', import.meta.url)), 'strict ZIP preflight is missing').toBe(true);
  return import('./zip.js');
}
function archive(names = ['session.json', 'events.jsonl']) {
  const zip = new AdmZip();
  for (const name of names) { zip.addFile(name, Buffer.from('{"summary":"example"}'), '', 0o100600); }
  return zip.toBuffer();
}
function rawName(bytes: Buffer, from: string, to: string) {
  expect(from.length).toBe(to.length);
  const copy = Buffer.from(bytes);
  for (let offset = copy.indexOf(from); offset !== -1; offset = copy.indexOf(from, offset + to.length)) {
    copy.write(to, offset, 'ascii');
  }
  return copy;
}

it('reads stored and deflated files without extracting anything', async () => {
  const { readProblemZip, storedProblemZip } = await api();
  const original = Buffer.from('{"summary":"example"}');
  for (const bytes of [archive(), storedProblemZip(new Map([['session.json', original]]))]) {
    const files = readProblemZip(bytes);
    expect(files.get('session.json')!.read()).toEqual(original);
  }
});

it.each(['../bad.jsonl', '/badx.jsonl', 'C:bad.jsonl', 'evilx.jsxx', 'dir\\x.jsonl'])(
  'rejects untrusted path %s before decompression', async (name) => {
    const { readProblemZip } = await api();
    const bytes = archive(['x'.repeat(name.length)]);
    expect(() => readProblemZip(rawName(bytes, 'x'.repeat(name.length), name))).toThrow(/PATH/);
  });

it('rejects duplicate and case-colliding raw names', async () => {
  const { readProblemZip } = await api();
  for (const replacement of ['events.jsonl', 'EVENTS.jsonl']) {
    expect(() => readProblemZip(rawName(archive(['events.jsonl', 'otherx.jsonl']), 'otherx.jsonl', replacement)))
      .toThrow(/DUPLICATE/);
  }
});

it('rejects symlinks and special files encoded in central attributes', async () => {
  const { readProblemZip } = await api();
  for (const mode of [0o120777, 0o010600, 0o040700]) {
    const bytes = archive(), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(0x0314, central + 4);
    bytes.writeUInt32LE((mode * 65536) >>> 0, central + 38);
    expect(() => readProblemZip(bytes)).toThrow(/TYPE/);
  }
});

it('rejects local header disagreements, encrypted flags and truncated archives', async () => {
  const { readProblemZip } = await api();
  const mismatch = archive(); mismatch.writeUInt16LE(0, 8);
  expect(() => readProblemZip(mismatch)).toThrow(/HEADER/);
  const encrypted = archive(); encrypted.writeUInt16LE(1, 6);
  expect(() => readProblemZip(encrypted)).toThrow(/HEADER|UNSUPPORTED/);
  expect(() => readProblemZip(archive().subarray(0, -1))).toThrow(/ZIP/);
});

it('checks byte, file-count and expansion budgets before returning lazy readers', async () => {
  const { readProblemZip } = await api();
  const bytes = archive();
  expect(() => readProblemZip(bytes, { maxArchiveBytes: bytes.length - 1 })).toThrow(/LIMIT/);
  expect(() => readProblemZip(bytes, { maxFiles: 1 })).toThrow(/LIMIT/);
  expect(() => readProblemZip(bytes, { maxFileBytes: 1 })).toThrow(/LIMIT/);
  const zip = new AdmZip(); zip.addFile('events.jsonl', Buffer.alloc(40000, 65));
  expect(() => readProblemZip(zip.toBuffer())).toThrow(/RATIO/);
});

it('does not trust CRC or declared decompressed length', async () => {
  const { readProblemZip } = await api();
  const bytes = archive();
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = bytes.readUInt32LE(central + 42);
  bytes.writeUInt32LE(0, central + 16); bytes.writeUInt32LE(0, local + 14);
  expect(() => readProblemZip(bytes).get('events.jsonl')!.read()).toThrow(/CRC/);
});

it('rejects trailing data inside a deflated member instead of silently ignoring it', async () => {
  const { readProblemZip } = await api();
  const bytes = archive(['events.jsonl']), end = bytes.length - 22, start = bytes.readUInt32LE(end + 16);
  const copy = Buffer.concat([bytes.subarray(0, start), Buffer.from([65]), bytes.subarray(start)]);
  const compressed = bytes.readUInt32LE(start + 20);
  copy.writeUInt32LE(compressed + 1, 18); copy.writeUInt32LE(compressed + 1, start + 1 + 20);
  copy.writeUInt32LE(start + 1, copy.length - 22 + 16);
  expect(() => readProblemZip(copy).get('events.jsonl')!.read()).toThrow('PROBLEM_ZIP_DATA');
});

it('applies the same unsafe-header checks to random-access imports', async () => {
  const { readProblemZip, readProblemZipAt } = await api();
  const unsafe = [archive().subarray(0, -1), rawName(archive(['events.jsonl', 'otherx.jsonl']), 'otherx.jsonl', 'events.jsonl')];
  const mismatch = archive(); mismatch.writeUInt32LE(0, 14); unsafe.push(mismatch);
  const link = archive(), central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE((0o120777 * 65536) >>> 0, central + 38); unsafe.push(link);
  for (const bytes of unsafe) {
    expect(() => readProblemZip(bytes)).toThrow();
    await expect(readProblemZipAt(bytes.length, async (offset, length) => bytes.subarray(offset, offset + length), new AbortController().signal))
      .rejects.toThrow();
  }
});
