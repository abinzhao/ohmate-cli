/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
interface Section { nameIndex: number; type: number; offset: number; size: number }
const machines: Record<number, string> = { 3: 'x86', 40: 'armeabi-v7a', 62: 'x86_64', 183: 'arm64-v8a' };
function range(bytes: Buffer, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error('ELF field exceeds the bounded input');
  }
  return bytes.subarray(offset, offset + length);
}
function reader(bytes: Buffer, little: boolean) {
  return (offset: number, width: 2 | 4 | 8) => {
    range(bytes, offset, width);
    const value = width === 8 ? Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)) :
      width === 4 ? little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset) : little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
    if (!Number.isSafeInteger(value)) { throw new Error('ELF integer is outside the supported range'); }
    return value;
  };
}
function notes(bytes: Buffer, little: boolean) {
  const read = reader(bytes, little), ids: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    range(bytes, offset, 12);
    const nameSize = read(offset, 4), descSize = read(offset + 4, 4), type = read(offset + 8, 4);
    const name = range(bytes, offset + 12, nameSize), descStart = offset + 12 + Math.ceil(nameSize / 4) * 4;
    const desc = range(bytes, descStart, descSize);
    if (type === 3 && name.toString('ascii') === 'GNU\0') {
      if (!descSize || descSize > 64) { throw new Error('Unsupported GNU BuildID length'); } ids.push(desc.toString('hex'));
    }
    offset = descStart + Math.ceil(descSize / 4) * 4;
    if (offset > bytes.length) { throw new Error('ELF note padding exceeds the bounded input'); }
  }
  return ids;
}
function sectionName(strings: Buffer, offset: number) {
  range(strings, offset, 1);
  const bounded = strings.subarray(offset, offset + 257), end = bounded.indexOf(0);
  if (end < 0) { throw new Error('Unterminated or oversized ELF section name'); }
  return bounded.subarray(0, end).toString('utf8');
}
export function readElf(bytes: Buffer) {
  range(bytes, 0, 16);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    ![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5]) || bytes[6] !== 1) { throw new Error('Unsupported ELF header'); }
  const wide = bytes[4] === 2, little = bytes[5] === 1, read = reader(bytes, little);
  range(bytes, 0, wide ? 64 : 52);
  const type = read(16, 2), machine = read(18, 2), offset = read(wide ? 40 : 32, wide ? 8 : 4);
  const size = read(wide ? 58 : 46, 2), count = read(wide ? 60 : 48, 2), stringIndex = read(wide ? 62 : 50, 2);
  if (!count || count > 10_000 || size < (wide ? 64 : 40) || stringIndex >= count) { throw new Error('Unsupported ELF section table or extended section numbering'); }
  range(bytes, offset, size * count);
  const sections: Section[] = Array.from({ length: count }, (_, index) => {
    const start = offset + index * size;
    return { nameIndex: read(start, 4), type: read(start + 4, 4),
      offset: read(start + (wide ? 24 : 16), wide ? 8 : 4), size: read(start + (wide ? 32 : 20), wide ? 8 : 4) };
  });
  const strings = sections[stringIndex], names = range(bytes, strings.offset, strings.size), ids: string[] = [];
  let noteBytes = 0;
  const named = sections.map((section) => {
    const name = sectionName(names, section.nameIndex);
    if (section.type !== 8) { range(bytes, section.offset, section.size); }
    if (section.type === 7) {
      noteBytes += section.size;
      if (noteBytes > bytes.length) { throw new Error('ELF note inspection exceeds the bounded input budget'); }
      ids.push(...notes(range(bytes, section.offset, section.size), little));
    }
    return name;
  }).filter(Boolean);
  if (new Set(ids).size > 1) { throw new Error('ELF records contradictory BuildIDs'); }
  const debugSections = named.filter((name) => /^\.z?debug|^\.symtab$|^\.gnu_debugdata$/.test(name));
  return { abi: machines[machine] ?? null, machine, type, bits: wide ? 64 : 32, byteOrder: little ? 'little' : 'big',
    sections: named, debugSections, stripped: !debugSections.length, buildId: ids[0] ?? null };
}
