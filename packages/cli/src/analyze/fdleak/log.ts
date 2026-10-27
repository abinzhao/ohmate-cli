/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { FD_LIMITS, type FDCandidate, type FDCount, type FDParsed, type FDSource, type FDStack } from './types.js';

const kinds = new Set(['ashmem', 'socket', 'pipe', 'sync_file', 'dmabuf', 'eventfd', 'eventpoll']);
const details: Record<string, string> = { 'Process ashmem detail info:': 'ashmem', 'Process socket info:': 'socket',
  'Process pipe info:': 'pipe', 'Process fence info:': 'sync_file', 'Process dma_heap info:': 'dmabuf' };
interface State {
  part: 'header' | 'fd' | 'dir' | 'detail' | 'allocation'; seen: Set<string>; stackDelimiter: boolean;
  parsed: FDParsed; hasSnapshot: boolean;
}
function integer(value: string, positive = false): number {
  if (!/^[0-9]+$/.test(value)) { throw new Error('FD_NUMBER_UNSUPPORTED'); }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) { throw new Error('FD_NUMBER_UNSUPPORTED'); }
  return number;
}
function nameHash(value: string): string {
  if (!value || Buffer.byteLength(value) > FD_LIMITS.nameBytes || /[\x00-\x1f\x7f]/.test(value)) { throw new Error('FD_NAME_UNSUPPORTED'); }
  return digest(value);
}
function once(state: State, name: string, source: FDSource) {
  if (state.seen.has(name)) { throw new Error('FD_FIELD_DUPLICATED'); }
  state.seen.add(name); state.parsed.fieldSources[name] = source;
}
function countRow(text: string, source: FDSource, directory: boolean): FDCount {
  const match = /^([0-9]+)[ \t]+(.+)$/.exec(text);
  if (!match || (directory && !match[2].startsWith('/'))) { throw new Error('FD_TOP_UNSUPPORTED'); }
  const name = match[2], count = integer(match[1]);
  return { count, kind: directory || name.startsWith('/') ? 'file-path' : kinds.has(name) ? name : 'other',
    nameSha256: nameHash(name), shareOfSnapshot: null, source };
}
function stackRow(text: string, source: FDSource): FDStack {
  const match = /^num[ \t]+([0-9]+)[ \t]+bt[ \t]+(.+)$/.exec(text);
  if (!match) { throw new Error('FD_STACK_UNSUPPORTED'); }
  const frames: FDStack['frames'] = [], expression = /\[([^\]\r\n]+)\]/g;
  let end = 0;
  for (const frame of match[2].matchAll(expression)) {
    if (match[2].slice(end, frame.index).trim() || frames.length === FD_LIMITS.framesPerStack) { throw new Error('FD_STACK_LIMIT'); }
    const parts = /^(.+\.so(?:\.[0-9]+)*)\+(0x[0-9a-fA-F]{1,16})$/.exec(frame[1]);
    if (!parts) { throw new Error('FD_FRAME_UNSUPPORTED'); }
    frames.push({ moduleSha256: nameHash(parts[1]), offsetHex: parts[2] }); end = frame.index! + frame[0].length;
  }
  if (!frames.length || match[2].slice(end).trim()) { throw new Error('FD_STACK_UNSUPPORTED'); }
  return { count: integer(match[1]), frames, source };
}
function scalar(state: State, text: string, source: FDSource): boolean {
  if (text.startsWith('leaked fd nums:')) {
    once(state, 'snapshot-count', source);
    state.parsed.snapshot.count = integer(text.slice('leaked fd nums:'.length).trim());
    state.parsed.snapshot.source = source; state.hasSnapshot = true; return true;
  }
  const fields = state.part === 'header' ? ['pid', 'process', 'time'] :
    state.part === 'allocation' && !state.stackDelimiter ? ['pid', 'get stack time'] : [];
  for (const field of fields) {
    if (!text.startsWith(field + ':')) { continue; }
    const value = text.slice(field.length + 1).trim(), key = state.part + '-' + field;
    once(state, key, source);
    if (field === 'pid') {
      const pid = integer(value, true);
      if (state.part === 'header') { state.parsed.snapshot.pid = pid; } else { state.parsed.allocation.pid = pid; }
    } else if (field === 'process') { state.parsed.snapshot.processSha256 = nameHash(value); }
    else if (state.part === 'header') { state.parsed.snapshot.timeSha256 = nameHash(value); }
    else { state.parsed.allocation.timeSha256 = nameHash(value); }
    return true;
  }
  return false;
}
function section(state: State, text: string, source: FDSource): boolean {
  const part = text === 'Leaked fd Top 10:' ? 'fd' : text === 'Dir Type Top 10:' ? 'dir' :
    text === 'LOGGER_MEMCHECK_FD_STACK_INFO' ? 'allocation' : Object.hasOwn(details, text) ? 'detail' : null;
  if (part) {
    once(state, 'section-' + text, source); state.part = part;
    if (part === 'detail') { state.parsed.detailSections.push(details[text]); }
    return true;
  }
  if (/^=+FdTrack Stack=+$/.test(text)) {
    if (state.part !== 'allocation' || state.stackDelimiter) { throw new Error('FD_STACK_SECTION_UNSUPPORTED'); }
    once(state, 'stack-delimiter', source); state.stackDelimiter = true; return true;
  }
  return false;
}
function consume(state: State, text: string, source: FDSource) {
  if (scalar(state, text, source) || section(state, text, source)) { return; }
  if (state.part === 'fd' || state.part === 'dir') {
    if (!text || /^[-=*]+$/.test(text) || /^(?:FdCount|FileDescriptor|Sorted by)(?:[ \t]|$)/.test(text)) { state.parsed.ignoredLines++; return; }
    const list = state.part === 'fd' ? state.parsed.fdTop : state.parsed.dirTop;
    if (list.length === FD_LIMITS.topEntries) { throw new Error('FD_TOP_LIMIT'); }
    const row = countRow(text, source, state.part === 'dir');
    if (list.some(entry => entry.nameSha256 === row.nameSha256)) { throw new Error('FD_TOP_DUPLICATED'); }
    list.push(row); return;
  }
  if (text.startsWith('num')) {
    if (state.part !== 'allocation' || !state.stackDelimiter) { throw new Error('FD_STACK_SECTION_UNSUPPORTED'); }
    if (state.parsed.allocation.stacks.length === FD_LIMITS.stacks) { throw new Error('FD_STACK_LIMIT'); }
    state.parsed.allocation.stacks.push(stackRow(text, source)); return;
  }
  state.parsed.ignoredLines++;
}
function finish(state: State): FDParsed {
  if (!state.hasSnapshot) { throw new Error('FD_INPUT_TYPE_UNSUPPORTED'); }
  const data = state.parsed, sum = data.fdTop.reduce((total, row) => total + row.count, 0);
  if ((state.seen.has('section-Leaked fd Top 10:') && !data.fdTop.length) ||
    (state.seen.has('section-Dir Type Top 10:') && !data.dirTop.length) ||
    (state.seen.has('section-LOGGER_MEMCHECK_FD_STACK_INFO') && (!state.stackDelimiter || !data.allocation.stacks.length))) {
    throw new Error('FD_SECTION_TRUNCATED');
  }
  if (!Number.isSafeInteger(sum) || sum > data.snapshot.count) { throw new Error('FD_TOP_INCONSISTENT'); }
  for (const row of data.fdTop) { row.shareOfSnapshot = data.snapshot.count ? row.count / data.snapshot.count : null; }
  const { pid } = data.snapshot;
  data.allocation.snapshotPidRelation = pid === null || data.allocation.pid === null ? 'unavailable' :
    pid === data.allocation.pid ? 'matches-declared-pid' : 'different-declared-pid';
  return data;
}
export async function parseFDLog(bytes: Buffer, signal: AbortSignal): Promise<FDParsed> {
  signal.throwIfAborted();
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > FD_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0')) { throw new Error('FD_TEXT_UNSUPPORTED'); }
  const state: State = { part: 'header', seen: new Set(), stackDelimiter: false, hasSnapshot: false,
    parsed: { snapshot: { count: 0, pid: null, processSha256: null, timeSha256: null, source: { line: 0, offset: 0, bytes: 0, sha256: '' } },
      fdTop: [], dirTop: [], allocation: { pid: null, timeSha256: null, snapshotPidRelation: 'unavailable', stacks: [] },
      fieldSources: {}, ignoredLines: 0, detailSections: [] } };
  let offset = 0, lines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > FD_LIMITS.lines || raw.length > FD_LIMITS.lineBytes) { throw new Error('FD_LINE_LIMIT'); }
    consume(state, raw.toString('utf8').replace(/\r?\n$/, '').trim(), { line: lines, offset, bytes: raw.length, sha256: digest(raw) });
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted(); return finish(state);
}
export function fdSummary(data: FDParsed) {
  const fdTopSum = data.fdTop.reduce((total, row) => total + row.count, 0);
  let maxAllocationCount = 0;
  for (const row of data.allocation.stacks) { maxAllocationCount = Math.max(maxAllocationCount, row.count); }
  return { snapshotCount: data.snapshot.count, fdTopSum, fdTopRemainder: data.snapshot.count - fdTopSum,
    stackCount: data.allocation.stacks.length, maxAllocationCount };
}
export function fdCandidates(data: FDParsed): FDCandidate[] {
  const candidates: FDCandidate[] = [{ code: 'fd-snapshot-reported', evidenceLevel: 'single-feature',
    interpretation: 'A declared descriptor stock snapshot is present; background state, thresholds and resource lifecycle evidence remain unverified.' }];
  if (data.allocation.stacks.some(row => row.count > 0)) {
    candidates.push({ code: 'fd-allocation-hotspot', evidenceLevel: 'single-feature',
      interpretation: 'Declared ten-minute allocation counts include subsequently closed descriptors; stack counts alone cannot prove a leak.' });
  }
  return candidates;
}
