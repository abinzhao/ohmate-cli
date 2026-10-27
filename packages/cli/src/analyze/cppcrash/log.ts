/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { CPP_LIMITS, type CppFrame, type CppParsed, type CppSource } from './types.js';

const codes: Record<string, string[]> = {
  SIGILL: ['ILL_ILLOPC', 'ILL_ILLOPN', 'ILL_ILLADR', 'ILL_ILLTRP', 'ILL_PRVOPC', 'ILL_PRVREG', 'ILL_COPROC', 'ILL_BADSTK'],
  SIGTRAP: ['TRAP_BRKPT', 'TRAP_TRACE', 'TRAP_BRANCH', 'TRAP_HWBKPT'],
  SIGABRT: [], SIGBUS: ['BUS_ADRALN', 'BUS_ADRERR', 'BUS_OBJERR', 'BUS_MCEERR_AR', 'BUS_MCEERR_AO'],
  SIGFPE: ['FPE_INTDIV', 'FPE_INTOVF', 'FPE_FLTDIV', 'FPE_FLTOVF', 'FPE_FLTUND', 'FPE_FLTRES', 'FPE_FLTINV', 'FPE_FLTSUB'],
  SIGSEGV: ['SEGV_MAPERR', 'SEGV_ACCERR'], SIGSTKFLT: [], SIGSYS: [],
};
const commonCodes = new Set(['SI_USER', 'SI_KERNEL', 'SI_QUEUE', 'SI_TIMER', 'SI_MESGQ', 'SI_ASYNCIO', 'SI_SIGIO', 'SI_TKILL', 'UNKNOWN']);
const fields = new Set(['Device info', 'Build info', 'DeviceDebuggable', 'Fingerprint', 'Timestamp', 'Module name',
  'Process name', 'ReleaseType', 'CpuAbi', 'Version', 'VersionCode', 'IsSystemApp', 'PreInstalled', 'Foreground',
  'Pid', 'Uid', 'HiTraceId', 'TraceId', 'Process life time', 'Process Memory(kB)', 'Device Memory(kB)', 'Reason', 'LastFatalMessage']);
const sections = new Set(['SubmitterStacktrace', 'Registers', 'Other thread info', 'Memory near registers', 'FaultStack', 'Maps', 'OpenFiles', 'HiLog']);
const expectedFields = ['Device info', 'Build info', 'Fingerprint', 'Timestamp', 'Module name', 'Pid', 'Uid', 'Process name', 'Process life time'];
interface State { part: 'header' | 'primary' | 'supplementary'; seen: Set<string>; parsed: CppParsed }
function integer(text: string, positive = false): number {
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) { throw new Error('CPPCRASH_NUMBER_UNSUPPORTED'); }
  return value;
}
function boundedHash(value: string, limit: number): string {
  if (!value || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) { throw new Error('CPPCRASH_FIELD_UNSUPPORTED'); }
  return digest(value);
}
function parseSignal(value: string): CppParsed['signal'] {
  const match = /^Signal:(SIG[A-Z]+)\(([A-Z_]+)\)(?:@(0x[0-9a-fA-F]{1,16}|0{8,18}))?[ \t]*(?:from:([0-9]+):([0-9]+))?[ \t]*(.*)$/.exec(value);
  if (!match || !Object.hasOwn(codes, match[1]) || (!commonCodes.has(match[2]) && !codes[match[1]].includes(match[2]))) {
    throw new Error('CPPCRASH_SIGNAL_UNSUPPORTED');
  }
  const hint = match[6];
  if (hint && !/^probably caused by NULL pointer dereference$|^current thread stack low address = 0x[0-9a-fA-F]{1,16}, probably caused by stack-buffer-overflow$/.test(hint)) {
    throw new Error('CPPCRASH_REASON_TRAILER_UNSUPPORTED');
  }
  return { name: match[1], code: match[2], address: match[3] ?? null,
    sender: match[4] === undefined ? null : { pid: integer(match[4], true), uid: integer(match[5]) },
    hintSha256: hint ? digest(hint) : null };
}
function once(state: State, name: string) {
  if (state.seen.has(name)) { throw new Error('CPPCRASH_FIELD_DUPLICATED'); }
  state.seen.add(name);
}
function field(state: State, text: string, source: CppSource): boolean {
  const match = /^([^:]+):[ \t]*(.*)$/.exec(text);
  if (!match || !fields.has(match[1])) { return false; }
  if (state.part !== 'header') { throw new Error('CPPCRASH_HEADER_POSITION_UNSUPPORTED'); }
  const name = match[1], value = match[2];
  once(state, name);
  const sha256 = boundedHash(value, CPP_LIMITS.fieldBytes);
  if (['Pid', 'Uid', 'VersionCode'].includes(name)) { integer(value, name === 'Pid'); }
  if (name === 'Reason') { state.parsed.signal = parseSignal(value); }
  if (name === 'Fingerprint' && !/^[0-9a-fA-F]{64}$/.test(value)) { throw new Error('CPPCRASH_FINGERPRINT_UNSUPPORTED'); }
  state.parsed.fields[name] = { sha256, bytes: Buffer.byteLength(value) };
  state.parsed.fieldSources[name] = source; return true;
}
function section(state: State, text: string, source: CppSource): boolean {
  const name = text === 'Fault thread info:' ? 'Fault thread info' :
    /^=+SubmitterStacktrace=+$/.test(text) ? 'SubmitterStacktrace' :
      text.endsWith(':') && sections.has(text.slice(0, -1)) ? text.slice(0, -1) : null;
  if (!name) { return false; }
  once(state, 'section-' + name);
  if (name === 'Fault thread info') {
    if (state.part !== 'header') { throw new Error('CPPCRASH_SECTION_ORDER_UNSUPPORTED'); }
    state.part = 'primary';
  } else {
    if (state.part === 'header' || !state.parsed.frames.length) { throw new Error('CPPCRASH_SECTION_TRUNCATED'); }
    state.part = 'supplementary';
  }
  state.parsed.sections.push({ name, source }); return true;
}
function suffix(text: string): Pick<CppFrame, 'functionSha256' | 'functionOffset' | 'buildId'> {
  let remaining = text, buildId: string | null = null;
  const id = /\(([0-9a-fA-F]+)\)$/.exec(remaining);
  if (id) {
    if (id[1].length % 2 || id[1].length > CPP_LIMITS.buildIdBytes * 2) { throw new Error('CPPCRASH_BUILD_ID_UNSUPPORTED'); }
    buildId = id[1]; remaining = remaining.slice(0, id.index);
  }
  if (!remaining) { return { buildId, functionSha256: null, functionOffset: null }; }
  const fn = /^\((.+)\+(-?[0-9]+)\)$/.exec(remaining);
  if (!fn || fn[2].length > 20 || BigInt(fn[2]) < -(1n << 63n) || BigInt(fn[2]) >= (1n << 63n)) {
    throw new Error('CPPCRASH_FUNCTION_UNSUPPORTED');
  }
  let depth = 0;
  for (const char of fn[1]) {
    if (char === '(') { depth++; }
    if (char === ')' && --depth < 0) { throw new Error('CPPCRASH_FUNCTION_UNSUPPORTED'); }
  }
  if (depth) { throw new Error('CPPCRASH_FUNCTION_UNSUPPORTED'); }
  return { buildId, functionSha256: boundedHash(fn[1], CPP_LIMITS.nameBytes), functionOffset: fn[2] };
}
function frame(text: string, source: CppSource, ordinal: number): CppFrame {
  const match = /^#([0-9]+)[ \t]+pc[ \t]+([0-9a-fA-F]{8}|[0-9a-fA-F]{16})[ \t]+([^()]+)(.*)$/.exec(text);
  if (!match || ordinal >= CPP_LIMITS.frames) { throw new Error('CPPCRASH_STACK_UNSUPPORTED'); }
  const declaredIndex = integer(match[1]), location = match[3];
  if (declaredIndex !== ordinal) { throw new Error('CPPCRASH_FRAME_ORDER_UNSUPPORTED'); }
  if (location !== '[Unknown]' && (!location.startsWith('/') || /[\s]/.test(location))) { throw new Error('CPPCRASH_LOCATION_UNSUPPORTED'); }
  return { ordinal, declaredIndex, pc: match[2], locationSha256: boundedHash(location, CPP_LIMITS.nameBytes),
    unknownLocation: location === '[Unknown]', ...suffix(match[4]), source };
}
function consume(state: State, text: string, source: CppSource) {
  // Explicit envelope markers cannot disappear into an ignored supplementary section.
  if ((state.part !== 'header' && /^(?:Device info|Reason):/.test(text)) || text === '[truncated]' ||
    text.startsWith('*** GWP-ASan detected a memory error ***')) {
    throw new Error('CPPCRASH_EVENT_UNSUPPORTED');
  }
  if (section(state, text, source)) { return; }
  if (state.part === 'supplementary') { state.parsed.ignoredLines++; return; }
  if (field(state, text, source)) { return; }
  if (state.part === 'primary' && text) {
    if (text.startsWith('Tid:')) {
      once(state, 'thread');
      const match = /^Tid:([0-9]+),[ \t]*Name:(.+)$/.exec(text);
      if (!match || state.parsed.frames.length) { throw new Error('CPPCRASH_THREAD_UNSUPPORTED'); }
      state.parsed.thread = { tid: integer(match[1], true), nameSha256: boundedHash(match[2], CPP_LIMITS.nameBytes), source }; return;
    }
    if (!state.seen.has('thread')) { throw new Error('CPPCRASH_THREAD_UNSUPPORTED'); }
    state.parsed.frames.push(frame(text, source, state.parsed.frames.length)); return;
  }
  if (text && state.seen.has('LastFatalMessage')) { throw new Error('CPPCRASH_FATAL_TRAILER_UNSUPPORTED'); }
  state.parsed.ignoredLines++;
}
export async function parseCppLog(bytes: Buffer, signal: AbortSignal): Promise<CppParsed> {
  signal.throwIfAborted();
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > CPP_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0')) { throw new Error('CPPCRASH_TEXT_UNSUPPORTED'); }
  const state: State = { part: 'header', seen: new Set(), parsed: {
    signal: { name: '', code: '', address: null, sender: null, hintSha256: null },
    thread: { tid: 0, nameSha256: '', source: { line: 0, offset: 0, bytes: 0, sha256: '' } },
    fields: {}, fieldSources: {}, frames: [], missingFields: [], sections: [], ignoredLines: 0,
  } };
  let offset = 0, lines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > CPP_LIMITS.lines || raw.length > CPP_LIMITS.lineBytes) { throw new Error('CPPCRASH_LINE_LIMIT'); }
    consume(state, raw.toString('utf8').replace(/\r?\n$/, '').trim(), { line: lines, offset, bytes: raw.length, sha256: digest(raw) });
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted();
  if (!state.seen.has('Reason') || !state.seen.has('thread') || !state.parsed.frames.length) { throw new Error('CPPCRASH_SECTION_TRUNCATED'); }
  state.parsed.missingFields = expectedFields.filter(name => !state.seen.has(name));
  return state.parsed;
}
