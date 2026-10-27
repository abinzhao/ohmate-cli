/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const CORE_ARCHIVE_MAX_BYTES: number = 262144;
export interface CoreZipEntry { path: string; bytes: Uint8Array; }

// Core has no platform imports. Canonical UTF-8 is also used for file hashes.
export function coreUtf8(text: string): Uint8Array {
  if (text.length > CORE_ARCHIVE_MAX_BYTES) { throw new Error('ARCHIVE_SIZE_LIMIT'); }
  const values: number[] = [];
  for (let index: number = 0; index < text.length; index++) {
    let code: number = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low: number = text.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) { throw new Error('ARCHIVE_UTF8_INVALID'); }
      code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
    } else if (code >= 0xdc00 && code <= 0xdfff) { throw new Error('ARCHIVE_UTF8_INVALID'); }
    if (code < 0x80) { values.push(code); }
    else if (code < 0x800) { values.push(0xc0 | (code >> 6), 0x80 | (code & 63)); }
    else if (code < 0x10000) { values.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
    else { values.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
    if (values.length > CORE_ARCHIVE_MAX_BYTES) { throw new Error('ARCHIVE_SIZE_LIMIT'); }
  }
  return new Uint8Array(values);
}
function crc32(bytes: Uint8Array): number {
  let crc: number = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit: number = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function coreStoredZip(files: CoreZipEntry[]): Uint8Array {
  const allowed: string[] = ['manifest.json', 'core-summary.json',
    'schemas/manifest.schema.json', 'schemas/core-summary.schema.json'];
  if (files.length !== allowed.length ||
    files.some((file: CoreZipEntry, index: number): boolean => file.path !== allowed[index])) {
    throw new Error('ARCHIVE_LAYOUT_INVALID');
  }
  const names: Uint8Array[] = files.map((file: CoreZipEntry): Uint8Array => coreUtf8(file.path));
  let size: number = 22;
  for (let index: number = 0; index < files.length; index++) {
    size += 76 + names[index].length * 2 + files[index].bytes.length;
  }
  if (size > CORE_ARCHIVE_MAX_BYTES) { throw new Error('ARCHIVE_SIZE_LIMIT'); }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const offsets: number[] = [], checksums: number[] = [];
  let offset: number = 0;
  for (let index: number = 0; index < files.length; index++) {
    const file: CoreZipEntry = files[index], name: Uint8Array = names[index];
    offsets.push(offset); checksums.push(crc32(file.bytes));
    view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); view.setUint16(offset + 12, 33, true);
    view.setUint32(offset + 14, checksums[index], true);
    view.setUint32(offset + 18, file.bytes.length, true); view.setUint32(offset + 22, file.bytes.length, true);
    view.setUint16(offset + 26, name.length, true);
    bytes.set(name, offset + 30); bytes.set(file.bytes, offset + 30 + name.length);
    offset += 30 + name.length + file.bytes.length;
  }
  const directory: number = offset;
  for (let index: number = 0; index < files.length; index++) {
    const file: CoreZipEntry = files[index], name: Uint8Array = names[index];
    view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true); view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 14, 33, true); view.setUint32(offset + 16, checksums[index], true);
    view.setUint32(offset + 20, file.bytes.length, true); view.setUint32(offset + 24, file.bytes.length, true);
    view.setUint16(offset + 28, name.length, true); view.setUint32(offset + 42, offsets[index], true);
    bytes.set(name, offset + 46); offset += 46 + name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, files.length, true); view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - directory, true); view.setUint32(offset + 16, directory, true);
  return bytes;
}
