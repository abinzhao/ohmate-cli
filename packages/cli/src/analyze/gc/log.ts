/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { GC_LIMITS, type GCCandidate, type GCEvent } from './types.js';

// The OpenHarmony 5.0.3 GCStats emitter uses distinct local/shared duration shapes.
const types = new Set(['STWYoungGC', 'HPP EdenGC', 'HPP YoungGC', 'HPP OldGC', 'CompressGC', 'SharedGC']);
const reasons = new Set(['Memory reach limit', 'Allocate object failed', 'Idle time task', 'Switch to background',
  'Externally triggered', 'Worker Destruction', 'Trigger by JS', 'Trigger by ArkUI', 'Trigger by AbilityRuntime',
  'Trigger by Mem tools', 'Trigger by taskPool', 'Other']);
const number = '([0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)';
const summary = new RegExp('^\\[[ \\t]*([^\\]]{1,32}?)[ \\t]*\\][ \\t]+' + number +
  '[ \\t]+\\(' + number + '\\)[ \\t]+->[ \\t]+' + number + '[ \\t]+\\(' + number +
  '\\)[ \\t]+MB,[ \\t]+' + number + '(?:\\(\\+' + number + '\\))?ms,[ \\t]+([^\\r\\n]{1,64})[ \\t]*$');
function numeric(value: string): number {
  const result = Number(value);
  const nonzeroMantissa = /[1-9]/.test(value.split(/[eE]/)[0]);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER ||
    (result === 0 && nonzeroMantissa)) { throw new Error('GC_NUMBER_UNSUPPORTED'); }
  return result;
}
function event(text: string, source: GCEvent['source']): GCEvent | null {
  const tag = text.match(/^[^\r\n]*?ArkCompiler:[ \t]*\[gc\][ \t]*(.*)$/);
  if (!tag || !tag[1].startsWith('[')) { return null; }
  const match = summary.exec(tag[1]);
  if (!match) { throw new Error('GC_SUMMARY_UNSUPPORTED'); }
  const type = match[1].trim(), reason = match[8].trim();
  if (!types.has(type) || !reasons.has(reason)) { throw new Error('GC_ENUM_UNSUPPORTED'); }
  const [beforeUsedMiB, beforeCommittedMiB, afterUsedMiB, afterCommittedMiB, totalGcMs] = match.slice(2, 7).map(numeric);
  const concurrentMarkMs = match[7] === undefined ? null : numeric(match[7]);
  if ((type === 'SharedGC') !== (concurrentMarkMs === null) ||
    beforeUsedMiB > beforeCommittedMiB || afterUsedMiB > afterCommittedMiB) { throw new Error('GC_FIELDS_INCONSISTENT'); }
  return { type, heap: type === 'SharedGC' ? 'shared' : 'local', beforeUsedMiB, beforeCommittedMiB,
    afterUsedMiB, afterCommittedMiB, totalGcMs, concurrentMarkMs, reason, source };
}
function decode(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > GC_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0')) { throw new Error('GC_TEXT_UNSUPPORTED'); }
  return text;
}
export async function parseGCLog(bytes: Buffer, signal: AbortSignal) {
  signal.throwIfAborted(); decode(bytes);
  const events: GCEvent[] = [];
  let offset = 0, lines = 0, ignoredLines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1;
    if (++lines > GC_LIMITS.lines || end - offset > GC_LIMITS.lineBytes) { throw new Error('GC_LINE_LIMIT'); }
    const raw = bytes.subarray(offset, end), text = raw.toString('utf8').replace(/\r?\n$/, '');
    const parsed = event(text, { line: lines, offset, bytes: raw.length, sha256: digest(raw) });
    if (parsed) {
      if (events.length === GC_LIMITS.events) { throw new Error('GC_EVENT_LIMIT'); }
      events.push(parsed);
    } else { ignoredLines++; }
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted();
  if (!events.length) { throw new Error('GC_INPUT_TYPE_UNSUPPORTED'); }
  return { events, ignoredLines };
}
export function gcSummary(events: GCEvent[]) {
  const byType: Record<string, number> = {};
  let maxTotalGcMs = 0;
  for (const item of events) { byType[item.type] = (byType[item.type] ?? 0) + 1; maxTotalGcMs = Math.max(maxTotalGcMs, item.totalGcMs); }
  return { eventCount: events.length, maxTotalGcMs, byType };
}
export function gcCandidates(events: GCEvent[]): GCCandidate[] {
  const limits = events.filter(item => item.reason === 'Memory reach limit').length;
  const failures = events.filter(item => item.reason === 'Allocate object failed').length;
  const candidates: GCCandidate[] = [];
  if (limits) {
    candidates.push({ code: 'allocation-limit-reported', evidenceLevel: 'single-feature', eventCount: limits,
      interpretation: 'The logger reports a GC trigger threshold; workload and allocation evidence are required to assess pressure.' });
  }
  if (failures) {
    candidates.push({ code: 'allocation-failure-reported', evidenceLevel: 'single-feature', eventCount: failures,
      interpretation: 'The logger reports an allocation failure trigger; an OOM detector and matching runtime context are still required.' });
  }
  return candidates;
}
