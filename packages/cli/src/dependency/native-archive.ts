/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { sha256 } from '../agent/context-files.js';
import { readElf } from '../release/elf.js';
import { publicPath } from '../workspace/path-guard.js';
import { assertPublicValue } from '../tasks/task-state.js';
import type { NativeArchiveMember, NativeBinary } from './types.js';

export function nativeElf(bytes: Buffer): NativeBinary['elf'] {
  try {
    const elf = readElf(bytes);
    return { machine: elf.machine, type: elf.type, bits: elf.bits, byteOrder: elf.byteOrder,
      abiHint: elf.abi, buildId: elf.buildId, stripped: elf.stripped };
  } catch { return undefined; }
}
function decimal(text: string) {
  if (!/^\d+ *$/.test(text)) { throw new Error('Malformed archive integer'); }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) { throw new Error('Archive integer exceeds bounds'); }
  return value;
}
function header(bytes: Buffer, offset: number) {
  if (offset + 60 > bytes.length || !bytes.subarray(offset + 58, offset + 60).equals(Buffer.from('`\n'))) {
    throw new Error('Malformed archive header');
  }
  const size = decimal(bytes.subarray(offset + 48, offset + 58).toString('latin1')), start = offset + 60;
  if (start + size + size % 2 > bytes.length || (size % 2 && bytes[start + size] !== 10)) {
    throw new Error('Malformed archive range or padding');
  }
  return { token: bytes.subarray(offset, offset + 16).toString('latin1').trimEnd(), start, size, next: start + size + size % 2 };
}
function nameBytes(token: string, payload: Buffer, table: Buffer | undefined) {
  if (token.startsWith('#1/')) {
    const length = decimal(token.slice(3));
    if (!length || length > payload.length) { throw new Error('Malformed BSD extended name'); }
    let end = length;
    while (end && payload[end - 1] === 0) { end--; }
    return { name: payload.subarray(0, end), prefix: length };
  }
  if (/^\/\d/.test(token)) {
    const offset = decimal(token.slice(1));
    if (!table || offset >= table.length || (offset && table[offset - 1] !== 10)) { throw new Error('Malformed GNU name offset'); }
    const bounded = table.subarray(offset, offset + 258), end = bounded.indexOf(10);
    if (end < 1 || bounded[end - 1] !== 47) { throw new Error('Malformed GNU long name'); }
    return { name: bounded.subarray(0, end - 1), prefix: 0 };
  }
  return { name: Buffer.from(token.endsWith('/') ? token.slice(0, -1) : token, 'latin1'), prefix: 0 };
}
function declaredName(bytes: Buffer) {
  if (!bytes.length || bytes.length > 256) { return undefined; }
  try {
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(name).equals(bytes)) { return undefined; }
    publicPath(name); assertPublicValue(name);
    return name;
  } catch { return undefined; }
}
function archiveMember(bytes: Buffer, start: number, index: number, table: Buffer | undefined, gaps: Set<string>) {
  const item = header(bytes, start), payload = bytes.subarray(item.start, item.start + item.size);
  const special = ['/', '/SYM64/', '//'].includes(item.token);
  const declared = special ? { name: Buffer.from(item.token), prefix: 0 } : nameBytes(item.token, payload, table);
  const name = special ? item.token : declaredName(declared.name), data = payload.subarray(declared.prefix);
  if (!name) { gaps.add('member-name-unavailable'); }
  const role = item.token === '//' ? 'name-table' : ['/', '/SYM64/'].includes(item.token) ||
    (name && /^__\.SYMDEF(?:_64)?(?: SORTED)?$/.test(name)) ? 'symbol-table' : 'object';
  const elf = role === 'object' ? nativeElf(data) : undefined;
  const member: NativeArchiveMember = { index, headerOffset: start, offset: item.start + declared.prefix,
    byteLength: data.length, sha256: sha256(data), ...(name ? { name } : {}), role, format: elf ? 'elf' : 'unrecognized',
    ...(elf ? { elf } : {}) };
  if (role === 'object' && (!elf || !elf.abiHint || elf.type !== 1)) { gaps.add('member-metadata-unavailable'); }
  return { item, member, data };
}
export function readNativeArchive(bytes: Buffer): NonNullable<NativeBinary['archive']> {
  if (bytes.subarray(0, 8).equals(Buffer.from('!<thin>\n'))) {
    // Thin member paths are external references, never a request to read another file.
    return { status: 'incomplete', gaps: ['thin-external-members'], members: [] };
  }
  const members: NativeArchiveMember[] = [], gaps = new Set<string>();
  let offset = 8, table: Buffer | undefined, sawTable = false;
  if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) { gaps.add('malformed'); }
  try {
    while (!gaps.has('malformed') && offset < bytes.length) {
      if (members.length >= 256) { gaps.add('member-limit'); break; }
      const { item, member, data } = archiveMember(bytes, offset, members.length, table, gaps);
      if (member.role === 'name-table') {
        if (sawTable) { throw new Error('Duplicate GNU name table'); }
        sawTable = true;
        if (data.length > 65536) { gaps.add('name-table-limit'); } else { table = data; }
      }
      members.push(member); offset = item.next;
    }
  } catch { gaps.add('malformed'); }
  if (!members.some(member => member.role === 'object')) { gaps.add('no-object-members'); }
  return { status: gaps.size ? 'incomplete' : 'complete', gaps: [...gaps], members };
}
