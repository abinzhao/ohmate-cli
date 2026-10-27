/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { readElf } from './elf.js';

function elf(debug = false) {
  const bytes = Buffer.alloc(1024), strings = Buffer.from('\0.shstrtab\0.note.gnu.build-id\0.dynsym\0.debug_info\0.symtab\0');
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(183, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(512n, 40); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(debug ? 6 : 4, 60); bytes.writeUInt16LE(1, 62); strings.copy(bytes, 64);
  const section = (index: number, name: string, type: number, offset: number, size: number) => {
    const start = 512 + 64 * index; bytes.writeUInt32LE(strings.indexOf(Buffer.from(name)), start);
    bytes.writeUInt32LE(type, start + 4); bytes.writeBigUInt64LE(BigInt(offset), start + 24); bytes.writeBigUInt64LE(BigInt(size), start + 32);
  };
  section(1, '.shstrtab', 3, 64, strings.length);
  section(2, '.note.gnu.build-id', 7, 160, 36);
  bytes.writeUInt32LE(4, 160); bytes.writeUInt32LE(20, 164); bytes.writeUInt32LE(3, 168);
  Buffer.from('GNU\0').copy(bytes, 172); Buffer.alloc(20, 0xa1).copy(bytes, 176);
  section(3, '.dynsym', 11, 208, 0);
  if (debug) { section(4, '.debug_info', 1, 216, 8); section(5, '.symtab', 2, 224, 0); }
  return bytes;
}
it('reads GNU BuildID, machine, class and dynamic symbols from bounded ELF sections', () => {
  expect(readElf(elf())).toMatchObject({ abi: 'arm64-v8a', machine: 183, bits: 64, buildId: 'a1'.repeat(20), stripped: true,
    sections: ['.shstrtab', '.note.gnu.build-id', '.dynsym'] });
});
it('distinguishes debug/static symbols from the dynamic table required for loading', () => {
  expect(readElf(elf(true))).toMatchObject({ stripped: false, debugSections: ['.debug_info', '.symtab'] });
});
it('rejects truncated, oversized offsets, malformed note and unsupported ELF class', () => {
  const huge = elf(); huge.writeBigUInt64LE(2n ** 63n, 40);
  const note = elf(); note.writeUInt32LE(0xffffffff, 164);
  const invalid = elf(); invalid[4] = 0;
  for (const bytes of [elf().subarray(0, 30), huge, note, invalid, Buffer.from('not ELF')]) { expect(() => readElf(bytes)).toThrow(); }
});

it('bounds repeated note inspection rather than multiplying work through overlapping sections', () => {
  const bytes = elf(true);
  for (let index = 3; index <= 5; index++) {
    const start = 512 + 64 * index;
    bytes.writeUInt32LE(bytes.readUInt32LE(512 + 64 * 2), start);
    bytes.writeUInt32LE(7, start + 4);
    bytes.writeBigUInt64LE(160n, start + 24); bytes.writeBigUInt64LE(288n, start + 32);
  }
  bytes.writeBigUInt64LE(288n, 512 + 64 * 2 + 32);
  expect(() => readElf(bytes)).toThrow('ELF note inspection exceeds the bounded input budget');
});
