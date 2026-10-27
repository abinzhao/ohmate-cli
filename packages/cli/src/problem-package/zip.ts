/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ProblemLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxRatio: number;
}
export const PROBLEM_LIMITS: Readonly<ProblemLimits> = Object.freeze({
  maxArchiveBytes: 2 * 1024 ** 3, maxExpandedBytes: 2 * 1024 ** 3,
  maxFileBytes: 1024 ** 3, maxFiles: 10000, maxRatio: 100,
});
export interface ProblemZipFile {
  size: number;
  compression: 'store' | 'deflate';
  read(): Buffer;
  consume(budget: number, visit: (chunk: Buffer) => void): void;
}
export function problemAttachmentType(path: string): 'text' | 'png' | 'jpeg' | null {
  if (/^faultlog\/[A-Za-z0-9][A-Za-z0-9._-]*\.(txt|log)$/.test(path)) { return 'text'; }
  if (/^snapshots\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(path)) { return 'png'; }
  if (/^snapshots\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg)$/.test(path)) { return 'jpeg'; }
  return null;
}
export function problemPath(name: string): string {
  if (name.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(json|jsonl)$/.test(name) && !problemAttachmentType(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('PROBLEM_PATH_INVALID');
  }
  return name;
}
function fail(code = 'PROBLEM_ZIP_INVALID'): never { throw new Error(code); }

function centralRecord(bytes: Buffer, cursor: number, end: number, centralStart: number, limits: ProblemLimits) {
  if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) { fail(); }
  const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
  const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20);
  const size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
  const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
  const attr = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
  if ((flags & ~0x0800) !== 0 || ![0, 8].includes(method) || extra || comment ||
    bytes.readUInt16LE(cursor + 34) !== 0 || bytes.readUInt16LE(cursor + 6) > 20) {
    fail('PROBLEM_ZIP_UNSUPPORTED');
  }
  const mode = (attr >>> 16) & 0o170000;
  if ((mode !== 0 && mode !== 0o100000) || (attr & 0x18) !== 0) { fail('PROBLEM_FILE_TYPE'); }
  const next = cursor + 46 + nameLength;
  if (next > end || local + 30 > centralStart) { fail(); }
  const rawName = bytes.subarray(cursor + 46, next);
  let name: string;
  try { name = problemPath(new TextDecoder('utf8', { fatal: true }).decode(rawName)); }
  catch { fail('PROBLEM_PATH_INVALID'); }
  if (size > limits.maxFileBytes) { fail('PROBLEM_LIMIT'); }
  if (size > Math.max(1, compressed) * limits.maxRatio) { fail('PROBLEM_EXPANSION_RATIO'); }
  if (method === 0 && compressed !== size) { fail('PROBLEM_ZIP_HEADER'); }
  const dataStart = local + 30 + nameLength, dataEnd = dataStart + compressed;
  if (dataEnd > centralStart) { fail('PROBLEM_ZIP_HEADER'); }
  return { name, size, method, crc, compressed, next, local, dataStart, dataEnd, flags, rawName,
    version: bytes.readUInt16LE(cursor + 6) };
}
function checkLocal(bytes: Buffer, record: ReturnType<typeof centralRecord>): void {
  const { version, flags, method, crc, compressed, size, rawName } = record;
  if (bytes.length !== 30 + rawName.length || bytes.readUInt32LE(0) !== 0x04034b50 ||
    bytes.readUInt16LE(4) !== version || bytes.readUInt16LE(6) !== flags || bytes.readUInt16LE(8) !== method ||
    bytes.readUInt32LE(14) !== crc || bytes.readUInt32LE(18) !== compressed ||
    bytes.readUInt32LE(22) !== size || bytes.readUInt16LE(26) !== rawName.length ||
    bytes.readUInt16LE(28) !== 0 || !bytes.subarray(30).equals(rawName)) {
    fail('PROBLEM_ZIP_HEADER');
  }
}
function lazyFile(bytes: Buffer, record: ReturnType<typeof centralRecord>): ProblemZipFile {
  const { size, method, crc, dataStart, dataEnd } = record;
  const file: ProblemZipFile = { size, compression: method === 0 ? 'store' : 'deflate', read() {
    const input = bytes.subarray(dataStart, dataEnd);
    let content: Buffer;
    try {
      if (method === 0) { content = Buffer.from(input); }
      else {
        const inflated = inflateRawSync(input, { maxOutputLength: Math.max(1, size), info: true }) as unknown as {
          buffer: Buffer; engine: { bytesWritten: number };
        };
        if (inflated.engine.bytesWritten !== input.length) { fail('PROBLEM_ZIP_DATA'); }
        content = inflated.buffer;
      }
    }
    catch { fail('PROBLEM_ZIP_DATA'); }
    if (content.length !== size) { fail('PROBLEM_FILE_SIZE'); }
    if (crc32(content) !== crc) { fail('PROBLEM_CRC'); }
    return content;
  }, consume(budget, visit) {
    if (size > budget) { fail('PROBLEM_LIMIT'); }
    if (method === 8 && size > 4 * 1024 ** 2) { fail('PROBLEM_ATTACHMENT_ASYNC_REQUIRED'); }
    const content = method === 0 ? bytes.subarray(dataStart, dataEnd) : file.read();
    let checksum = 0, expanded = 0;
    for (let offset = 0; offset < content.length; offset += 65536) {
      const chunk = content.subarray(offset, offset + 65536);
      expanded += chunk.length; checksum = crc32(chunk, checksum); visit(chunk);
    }
    if (expanded !== size) { fail('PROBLEM_FILE_SIZE'); }
    if (checksum !== crc) { fail('PROBLEM_CRC'); }
  } };
  return file;
}

// A closed classic-ZIP dialect: no descriptors, extras (including links/ZIP64),
// encryption, comments, prepended executables or trailing records.
function checkedLimits(overrides: Partial<ProblemLimits>): ProblemLimits {
  const limits = { ...PROBLEM_LIMITS, ...overrides };
  for (const key of Object.keys(PROBLEM_LIMITS) as Array<keyof ProblemLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > PROBLEM_LIMITS[key]) {
      fail('PROBLEM_LIMIT_INVALID');
    }
  }
  return limits;
}
function directoryHeader(bytes: Buffer, size: number, limits: ProblemLimits) {
  if (size > limits.maxArchiveBytes) { fail('PROBLEM_LIMIT'); }
  if (bytes.length !== 22 || bytes.readUInt32LE(0) !== 0x06054b50 || bytes.readUInt16LE(4) !== 0 ||
    bytes.readUInt16LE(6) !== 0 || bytes.readUInt16LE(20) !== 0) { fail(); }
  const count = bytes.readUInt16LE(10), centralSize = bytes.readUInt32LE(12);
  const centralStart = bytes.readUInt32LE(16);
  if (!count || count > limits.maxFiles) { fail('PROBLEM_LIMIT'); }
  if (bytes.readUInt16LE(8) !== count || centralStart + centralSize !== size - 22) { fail(); }
  if (centralSize > count * (46 + 240)) { fail('PROBLEM_ZIP_UNSUPPORTED'); }
  return { count, centralSize, centralStart };
}
function directoryRecords(bytes: Buffer, header: ReturnType<typeof directoryHeader>, limits: ProblemLimits) {
  const names = new Set<string>(), records: Array<ReturnType<typeof centralRecord>> = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0, expanded = 0;
  for (let index = 0; index < header.count; index++) {
    const record = centralRecord(bytes, cursor, bytes.length, header.centralStart, limits);
    if (names.has(record.name.toLowerCase())) { fail('PROBLEM_DUPLICATE_PATH'); }
    names.add(record.name.toLowerCase());
    expanded += record.size;
    if (expanded > limits.maxExpandedBytes) { fail('PROBLEM_LIMIT'); }
    ranges.push({ start: record.local, end: record.dataEnd });
    records.push(record);
    cursor = record.next;
  }
  if (cursor !== bytes.length) { fail(); }
  let offset = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    if (range.start !== offset) { fail('PROBLEM_ZIP_OVERLAP'); }
    offset = range.end;
  }
  if (offset !== header.centralStart) { fail('PROBLEM_ZIP_OVERLAP'); }
  return records;
}
export function readProblemZip(bytes: Buffer, overrides: Partial<ProblemLimits> = {}): Map<string, ProblemZipFile> {
  const limits = checkedLimits(overrides);
  const header = directoryHeader(bytes.subarray(Math.max(0, bytes.length - 22)), bytes.length, limits);
  const records = directoryRecords(bytes.subarray(header.centralStart, bytes.length - 22), header, limits);
  return new Map(records.map((record) => {
    checkLocal(bytes.subarray(record.local, record.dataStart), record);
    return [record.name, lazyFile(bytes, record)];
  }));
}

export interface AsyncProblemZipFile {
  size: number;
  compression: 'store' | 'deflate';
  read(budget: number): Promise<Buffer>;
  consume(budget: number, visit: (chunk: Buffer) => void | Promise<void>): Promise<void>;
}
async function consumeFile(record: ReturnType<typeof centralRecord>, readAt: (offset: number, length: number) => Promise<Buffer>,
  signal: AbortSignal, budget: number, visit: (chunk: Buffer) => void | Promise<void>): Promise<void> {
  if (record.size > budget) { fail('PROBLEM_SUMMARY_LIMIT'); }
  let expanded = 0, crc = 0;
  async function* compressed() {
    for (let offset = record.dataStart; offset < record.dataEnd; offset += 65536) {
      signal.throwIfAborted();
      const length = Math.min(65536, record.dataEnd - offset), chunk = await readAt(offset, length);
      if (chunk.length !== length) { fail('PROBLEM_FILE_SIZE'); }
      yield chunk;
    }
  }
  const consume = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      signal.throwIfAborted(); expanded += chunk.length;
      if (expanded > record.size || expanded > budget) { fail('PROBLEM_FILE_SIZE'); }
      crc = crc32(chunk, crc); await visit(chunk);
    }
  };
  if (record.method === 0) { await consume(compressed()); }
  else {
    const inflater = createInflateRaw();
    try {
      await pipeline(Readable.from(compressed()), inflater, consume, { signal });
      if (inflater.bytesWritten !== record.compressed) { fail('PROBLEM_ZIP_DATA'); }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('PROBLEM_')) { throw error; }
      fail('PROBLEM_ZIP_DATA');
    }
  }
  signal.throwIfAborted();
  if (expanded !== record.size) { fail('PROBLEM_FILE_SIZE'); }
  if (crc !== record.crc) { fail('PROBLEM_CRC'); }
}
export async function readProblemZipAt(size: number, readAt: (offset: number, length: number) => Promise<Buffer>,
  signal: AbortSignal): Promise<Map<string, AsyncProblemZipFile>> {
  signal.throwIfAborted();
  if (size < 22) { fail(); }
  const limits = checkedLimits({}), header = directoryHeader(await readAt(size - 22, 22), size, limits);
  const records = directoryRecords(await readAt(header.centralStart, header.centralSize), header, limits);
  const files = new Map<string, AsyncProblemZipFile>();
  for (const record of records) {
    signal.throwIfAborted();
    checkLocal(await readAt(record.local, record.dataStart - record.local), record);
    files.set(record.name, { size: record.size, compression: record.method === 0 ? 'store' : 'deflate',
      consume: (budget, visit) => consumeFile(record, readAt, signal, budget, visit),
      async read(budget) {
        const chunks: Buffer[] = []; let expanded = 0;
        await consumeFile(record, readAt, signal, budget, (chunk) => { chunks.push(chunk); expanded += chunk.length; });
        return Buffer.concat(chunks, expanded);
      } });
  }
  return files;
}

export function storedProblemZip(files: Map<string, Buffer>): Buffer {
  const records: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(problemPath(path)), crc = crc32(data);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    records.push(local, name, data); directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...records, centralBytes, end]);
  readProblemZip(bytes);
  return bytes;
}
