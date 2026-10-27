/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { NATIVELEAK_LIMITS, type NativeSample, type NativeSampleRow, type NativeSource } from './types.js';

export function nativeInteger(value: string): number {
  const number = Number(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(number)) { throw new Error('NATIVELEAK_NUMBER_UNSUPPORTED'); }
  return number;
}
export function nativeSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) { throw new Error('NATIVELEAK_NUMBER_UNSUPPORTED'); }
  return result;
}
export async function* nativeLines(bytes: Buffer, signal: AbortSignal): AsyncGenerator<{ text: string; source: NativeSource }> {
  signal.throwIfAborted();
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > NATIVELEAK_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) ||
    text.includes('\0') || text.includes('\ufeff')) { throw new Error('NATIVELEAK_TEXT_UNSUPPORTED'); }
  let offset = 0, lines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > NATIVELEAK_LIMITS.lines || raw.length > NATIVELEAK_LIMITS.lineBytes) { throw new Error('NATIVELEAK_LINE_LIMIT'); }
    yield { text: raw.toString('utf8').replace(/\r?\n$/, ''), source: { line: lines, offset, bytes: raw.length, sha256: digest(raw) } };
    offset = end;
    if (lines % 256 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted();
}
function validRealtime(value: string) {
  const values = value.match(/\d+/g)!.map(Number), [year, month, day, hour, minute, second] = values;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (year < 1970 || month < 1 || month > 12 || day < 1 ||
    day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ||
    hour > 23 || minute > 59 || second > 59) { throw new Error('NATIVELEAK_TIME_UNSUPPORTED'); }
}
function sampleRow(text: string, source: NativeSource): NativeSampleRow {
  const match = /^\s*(\S+)\s+(\S+)\s+(\d{4}\/\d{2}\/\d{2} \d{2}\/\d{2}\/\d{2})\s*$/.exec(text);
  if (!match) { throw new Error('NATIVELEAK_SAMPLE_ROW_UNSUPPORTED'); }
  validRealtime(match[3]);
  return { monotonicSeconds: nativeInteger(match[1]), valueKiB: nativeInteger(match[2]),
    realtimeSha256: digest(match[3]), metric: 'rss-or-pss-plus-swap-pss-unidentified', source };
}
function sampleTrend(rows: NativeSampleRow[]): NativeSample['trend'] {
  const values = rows, first = values[0], last = values.at(-1)!;
  let increasing = false, decreasing = false, peakKiB = first.valueKiB;
  for (let index = 1; index < values.length; index++) {
    increasing ||= values[index].valueKiB > values[index - 1].valueKiB;
    decreasing ||= values[index].valueKiB < values[index - 1].valueKiB;
    peakKiB = Math.max(peakKiB, values[index].valueKiB);
  }
  const deltaKiB = last.valueKiB - first.valueKiB;
  return { metric: 'mixed-memory-series', startKiB: first.valueKiB, endKiB: last.valueKiB, peakKiB, deltaKiB,
    deltaPercent: first.valueKiB === 0 ? null : deltaKiB / first.valueKiB * 100,
    durationSeconds: last.monotonicSeconds - first.monotonicSeconds, rowCount: values.length,
    direction: increasing && decreasing ? 'mixed' : increasing ? 'nondecreasing' : decreasing ? 'nonincreasing' : 'stable' };
}
function sampleField(text: string, source: NativeSource, fields: NativeSample['fields']) {
  const match = /^\s*(pid|processName|threshold|actualRss|TopPssMemory):[ \t]*(.+?)[ \t]*$/.exec(text);
  if (!match || Object.hasOwn(fields, match[1])) { throw new Error('NATIVELEAK_SAMPLE_FIELD_UNSUPPORTED'); }
  let value: number | string;
  if (match[1] === 'processName') {
    if (Buffer.byteLength(match[2]) > NATIVELEAK_LIMITS.nameBytes) { throw new Error('NATIVELEAK_NAME_LIMIT'); }
    value = digest(match[2]);
  } else {
    const scalar = match[1] === 'pid' ? match[2] : /^(\S+)\(KB\)$/.exec(match[2])?.[1];
    if (scalar === undefined) { throw new Error('NATIVELEAK_SAMPLE_FIELD_UNSUPPORTED'); }
    value = nativeInteger(scalar);
    if (match[1] === 'pid' && value === 0) { throw new Error('NATIVELEAK_SAMPLE_FIELD_UNSUPPORTED'); }
  }
  fields[match[1]] = { value, source };
}
export async function parseNativeSample(bytes: Buffer, signal: AbortSignal): Promise<NativeSample> {
  const fields: NativeSample['fields'] = {}, rows: NativeSampleRow[] = [];
  let header: NativeSource | undefined;
  for await (const line of nativeLines(bytes, signal)) {
    if (!line.text.trim()) { continue; }
    if (!header) {
      if (/^\s*time\(s\)\s+PssMemory\(KB\)\s+realtime\s*$/.test(line.text)) {
        if (Object.keys(fields).length !== 5) { throw new Error('NATIVELEAK_SAMPLE_FIELDS_MISSING'); }
        header = line.source;
      } else { sampleField(line.text, line.source, fields); }
      continue;
    }
    if (rows.length === NATIVELEAK_LIMITS.sampleRows) { throw new Error('NATIVELEAK_SAMPLE_ROW_LIMIT'); }
    const row = sampleRow(line.text, line.source);
    if (rows.length && row.monotonicSeconds < rows.at(-1)!.monotonicSeconds) { throw new Error('NATIVELEAK_TIME_REVERSED'); }
    rows.push(row);
  }
  if (!header || rows.length < 3) { throw new Error('NATIVELEAK_SAMPLE_INCOMPLETE'); }
  return { pid: fields.pid.value as number, processNameSha256: fields.processName.value as string,
    fields, header, rows, trend: sampleTrend(rows) };
}
