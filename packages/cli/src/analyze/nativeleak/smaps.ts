/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { digest } from '../../quality/evidence.js';
import { nativeInteger, nativeLines, nativeSum } from './sample.js';
import { NATIVELEAK_LIMITS, type NativeCategory, type NativeSmaps, type NativeSource } from './types.js';

function category(name: string): NativeCategory {
  if (name === '[anon:native_heap:jemalloc]') { return 'native-heap'; }
  if (name === '[anon:ArkTS Heap]') { return 'arkts-heap'; }
  if (name === '[anon]') { return 'anon'; }
  if (/^(?:\/dev\/ashmem\/|anon_inode:dev\/ashmem\/)/.test(name)) { return 'ashmem'; }
  return 'unclassified';
}
function smapsRow(text: string, source: NativeSource) {
  const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*?)\s*$/.exec(text);
  if (!match) { throw new Error('NATIVELEAK_SMAPS_ROW_UNSUPPORTED'); }
  if (Buffer.byteLength(match[11]) > NATIVELEAK_LIMITS.nameBytes) { throw new Error('NATIVELEAK_NAME_LIMIT'); }
  return { values: match.slice(1, 11).map(nativeInteger), source, name: match[11] };
}
function totals(rows: NativeSmaps['rows'], summary: NativeSmaps['summary']) {
  const sums = Array<number>(10).fill(0);
  for (const row of rows) {
    row.values.forEach((value, index) => { sums[index] = nativeSum(sums[index], value); });
  }
  const combinedKiB = nativeSum(sums[2], sums[8]);
  const expected = [...sums]; expected[2] = combinedKiB;
  if (!expected.every((value, index) => value === summary.values[index])) { throw new Error('NATIVELEAK_SMAPS_SUMMARY_MISMATCH'); }
  return { pssKiB: sums[2], swapPssKiB: sums[8], combinedKiB };
}
function shares(rows: NativeSmaps['rows'], denominatorKiB: number): NativeSmaps['shares'] {
  const values = new Map<NativeCategory, number>();
  for (const row of rows) {
    values.set(row.category, nativeSum(values.get(row.category) ?? 0, nativeSum(row.values[2], row.values[8])));
  }
  return [...values].map(([category, numeratorKiB]) => ({ category, numeratorKiB, denominatorKiB,
    percent: denominatorKiB === 0 ? null : numeratorKiB / denominatorKiB * 100 }));
}
export async function parseNativeSmaps(bytes: Buffer, signal: AbortSignal): Promise<NativeSmaps> {
  const headers: NativeSource[] = [], rows: NativeSmaps['rows'] = [], names = new Set<string>();
  let summary: NativeSmaps['summary'] | undefined;
  for await (const line of nativeLines(bytes, signal)) {
    if (!line.text.trim()) { continue; }
    if (headers.length < 2) {
      const expected = headers.length === 0 ? 'Shared Shared Private Private' :
        'Size Rss Pss Clean Dirty Clean Dirty Swap SwapPss Counts Name';
      if (line.text.trim().split(/\s+/).join(' ') !== expected) { throw new Error('NATIVELEAK_SMAPS_HEADER_UNSUPPORTED'); }
      headers.push(line.source); continue;
    }
    if (summary) { throw new Error('NATIVELEAK_SMAPS_TRAILING_DATA'); }
    const row = smapsRow(line.text, line.source);
    if (row.name === 'Summary') { summary = { values: row.values, source: row.source }; continue; }
    if (rows.length === NATIVELEAK_LIMITS.smapsRows) { throw new Error('NATIVELEAK_SMAPS_ROW_LIMIT'); }
    const nameSha256 = digest(row.name);
    if (names.has(nameSha256)) { throw new Error('NATIVELEAK_SMAPS_DUPLICATE_NAME'); }
    names.add(nameSha256); rows.push({ values: row.values, source: row.source, nameSha256, category: category(row.name) });
  }
  if (headers.length !== 2 || !rows.length || !summary) { throw new Error('NATIVELEAK_SMAPS_INCOMPLETE'); }
  const sum = totals(rows, summary);
  return { headers, rows, summary, totals: sum, shares: shares(rows, sum.combinedKiB) };
}
