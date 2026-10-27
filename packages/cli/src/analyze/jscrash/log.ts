/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { JS_LIMITS, type JSFrame, type JSParsed, type JSSource } from './types.js';

const types = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'URIError',
  'OutOfMemoryError', 'OOMError', 'TerminationError', 'AggregateError', 'BusinessError', 'EvalError']);
const fields = new Set(['Device info', 'Build info', 'DeviceDebuggable', 'Fingerprint', 'Timestamp', 'Fault time',
  'Module name', 'Process name', 'Package name', 'ReleaseType', 'CpuAbi', 'Version', 'VersionCode', 'IsSystemApp',
  'Pid', 'Uid', 'Process life time', 'Reason', 'Error name', 'Error message', 'Error code', 'page']);
const numbers = new Set(['Pid', 'Uid', 'VersionCode', 'Error code']);
const optionalSections = new Set(['HybridStack', 'SubmitterStacktrace', 'AsyncStack', 'ModuleImportStack', 'HiLog']);
const expectedFields = ['Device info', 'Build info', 'Fingerprint', 'Timestamp', 'Module name', 'Version',
  'VersionCode', 'Pid', 'Uid', 'Reason', 'Error name', 'Error message'];
interface State {
  part: 'header' | 'primary' | 'supplementary'; seen: Set<string>; raw: Map<string, string>; parsed: JSParsed;
}
function integer(text: string, positive = false): number {
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error('JSCRASH_NUMBER_UNSUPPORTED');
  }
  return value;
}
function boundedHash(value: string, limit: number): string {
  if (!value || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('JSCRASH_FIELD_UNSUPPORTED');
  }
  return digest(value);
}
function once(state: State, name: string, source: JSSource) {
  if (state.seen.has(name)) { throw new Error('JSCRASH_FIELD_DUPLICATED'); }
  state.seen.add(name); state.parsed.fieldSources[name] = source;
}
function field(state: State, text: string, source: JSSource): boolean {
  const match = /^([^:]+):[ \t]*(.*)$/.exec(text);
  if (!match || !fields.has(match[1])) { return false; }
  if (state.part !== 'header') { throw new Error('JSCRASH_HEADER_POSITION_UNSUPPORTED'); }
  const name = match[1], value = match[2];
  once(state, name, source);
  const sha256 = boundedHash(value, JS_LIMITS.fieldBytes);
  if (numbers.has(name)) { integer(value, name === 'Pid'); }
  if ((name === 'Reason' || name === 'Error name') && !types.has(value)) { throw new Error('JSCRASH_INPUT_TYPE_UNSUPPORTED'); }
  if (name === 'Fingerprint' && !/^[0-9a-fA-F]{64}$/.test(value)) { throw new Error('JSCRASH_FINGERPRINT_UNSUPPORTED'); }
  state.parsed.fields[name] = { sha256, bytes: Buffer.byteLength(value) };
  if (['Reason', 'Error name', 'Error code'].includes(name)) { state.raw.set(name, value); }
  return true;
}
function section(state: State, text: string, source: JSSource): boolean {
  const name = text === 'Stacktrace:' ? 'Stacktrace' :
    /^=+SubmitterStacktrace=+$/.test(text) ? 'SubmitterStacktrace' :
      text.endsWith(':') && optionalSections.has(text.slice(0, -1)) ? text.slice(0, -1) : null;
  if (!name) { return false; }
  once(state, 'section-' + name, source);
  if (name === 'Stacktrace') {
    if (state.part !== 'header') { throw new Error('JSCRASH_SECTION_ORDER_UNSUPPORTED'); }
    state.part = 'primary';
  } else {
    if (!state.seen.has('section-Stacktrace') || !state.parsed.frames.length) { throw new Error('JSCRASH_SECTION_TRUNCATED'); }
    state.part = 'supplementary'; state.parsed.sections.push({ name, source });
  }
  return true;
}
function frame(text: string, source: JSSource, ordinal: number): JSFrame {
  const match = /^(?:#([0-9]+)[ \t]+)?at[ \t]+(.+?)[ \t]+\((.+):([0-9]+):([0-9]+)\)$/.exec(text);
  if (!match || ordinal >= JS_LIMITS.frames) { throw new Error('JSCRASH_STACK_UNSUPPORTED'); }
  const location = match[3], parts = location.split('|');
  if (!/\.(?:ets|ts|js)$/.test(location) || (parts.length !== 1 && (parts.length !== 4 || parts.some(part => !part)))) {
    throw new Error('JSCRASH_LOCATION_UNSUPPORTED');
  }
  return { ordinal, declaredIndex: match[1] === undefined ? null : integer(match[1]),
    functionSha256: boundedHash(match[2], JS_LIMITS.nameBytes), locationSha256: boundedHash(location, JS_LIMITS.nameBytes),
    line: integer(match[4], true), column: integer(match[5]), locationForm: parts.length === 4 ? 'release-module-path' : 'path', source };
}
function consume(state: State, text: string, source: JSSource) {
  // A second faultlog envelope must not disappear into an ignored HiLog section.
  if (text.startsWith('Device info:') && state.seen.has('Device info')) { throw new Error('JSCRASH_EVENT_DUPLICATED'); }
  if (section(state, text, source)) { return; }
  if (state.part === 'supplementary') { state.parsed.ignoredLines++; return; }
  if (text === 'Cannot get SourceMap info, dump raw stack:') {
    once(state, 'raw-stack-marker', source); state.parsed.rawStackDeclared = true; return;
  }
  if (field(state, text, source)) { return; }
  if (state.part === 'header' && state.seen.has('Error message') && text) { throw new Error('JSCRASH_MESSAGE_TRAILER_UNSUPPORTED'); }
  if (state.part === 'primary' && text) {
    const frames = state.parsed.frames, next = frame(text, source, frames.length);
    if (next.declaredIndex !== null && next.declaredIndex !== frames.length) { throw new Error('JSCRASH_FRAME_ORDER_UNSUPPORTED'); }
    if (frames.length && (frames[0].declaredIndex === null) !== (next.declaredIndex === null)) {
      throw new Error('JSCRASH_FRAME_ORDER_UNSUPPORTED');
    }
    frames.push(next); return;
  }
  state.parsed.ignoredLines++;
}
function finish(state: State): JSParsed {
  const reason = state.raw.get('Reason'), name = state.raw.get('Error name');
  if (!reason && !name) { throw new Error('JSCRASH_INPUT_TYPE_UNSUPPORTED'); }
  if (reason && name && reason !== name) { throw new Error('JSCRASH_TYPE_CONFLICT'); }
  if (!state.seen.has('section-Stacktrace') || !state.parsed.frames.length || !state.parsed.fields['Error message']) {
    throw new Error('JSCRASH_SECTION_TRUNCATED');
  }
  const code = state.raw.get('Error code');
  state.parsed.error = { type: reason ?? name!, classificationBasis: reason && name ? 'reason-and-error-name' : reason ? 'reason' : 'error-name',
    message: state.parsed.fields['Error message'], code: code === undefined ? null : integer(code) };
  state.parsed.missingFields = expectedFields.filter(name => !state.seen.has(name));
  return state.parsed;
}
export async function parseJSLog(bytes: Buffer, signal: AbortSignal): Promise<JSParsed> {
  signal.throwIfAborted();
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > JS_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0')) { throw new Error('JSCRASH_TEXT_UNSUPPORTED'); }
  const state: State = { part: 'header', seen: new Set(), raw: new Map(), parsed: {
    error: { type: '', classificationBasis: 'reason', message: { sha256: '', bytes: 0 }, code: null },
    fields: {}, fieldSources: {}, frames: [], missingFields: [], sections: [], rawStackDeclared: false, ignoredLines: 0,
  } };
  let offset = 0, lines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > JS_LIMITS.lines || raw.length > JS_LIMITS.lineBytes) { throw new Error('JSCRASH_LINE_LIMIT'); }
    consume(state, raw.toString('utf8').replace(/\r?\n$/, '').trim(), { line: lines, offset, bytes: raw.length, sha256: digest(raw) });
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted(); return finish(state);
}
