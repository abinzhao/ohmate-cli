/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setImmediate } from 'node:timers/promises';
import { digest } from '../../quality/evidence.js';
import { FREEZE_LIMITS, type FreezeField, type FreezeFrame, type FreezeParsed, type FreezePhase, type FreezeSource, type FreezeThread } from './types.js';

const reasons = new Set(['THREAD_BLOCK_6S', 'APP_INPUT_BLOCK', 'BUSSINESS_THREAD_BLOCK_6S', 'BUSINESS_THREAD_BLOCK_6S']);
const events = new Set([...reasons, 'THREAD_BLOCK_3S']);
const headerFields = new Set(['Device info', 'Build info', 'DeviceDebuggable', 'Fingerprint', 'Timestamp', 'Module name',
  'ReleaseType', 'CpuAbi', 'Version', 'VersionCode', 'IsSystemApp', 'PreInstalled', 'Foreground', 'Pid', 'Uid',
  'Process life time', 'Process Memory(kB)', 'Device Memory(kB)', 'Reason', 'DisplayPowerInfo', 'HitraceIdInfo',
  'DOMAIN', 'STRINGID', 'TIMESTAMP', 'PID', 'UID', 'PACKAGE_NAME', 'PROCESS_NAME', 'NOTE']);
const phaseFields = new Set(['DOMAIN', 'EVENTNAME', 'TIMESTAMP', 'PID', 'UID', 'TID', 'PACKAGE_NAME', 'MODULE_NAME',
  'PROCESS_NAME', 'eventLog_action', 'eventLog_interval', 'MSG']);
const contextFields = new Set(['Fault time', 'Timestamp', 'Pid', 'Uid', 'Process name']);
interface PhaseState {
  phase: FreezePhase; raw: Map<string, string>; mode: 'metadata' | 'context' | 'stack' | 'supplementary';
  thread: FreezeThread | null;
}
interface State {
  parsed: FreezeParsed; raw: Map<string, string>; current: PhaseState | null; pending: FreezeSource | null;
  frameCount: number;
}
function integer(text: string, positive = false): number {
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) { throw new Error('FREEZE_NUMBER_UNSUPPORTED'); }
  return value;
}
function hash(value: string, limit: number, empty = false): string {
  if ((!empty && !value) || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) { throw new Error('FREEZE_FIELD_UNSUPPORTED'); }
  return digest(value);
}
function field(raw: Map<string, string>, fields: Record<string, FreezeField>, name: string, value: string, source: FreezeSource) {
  if (raw.has(name)) { throw new Error('FREEZE_FIELD_DUPLICATED'); }
  const empty = ['MSG', 'PROCESS_NAME', 'Process name'].includes(name);
  const sha256 = hash(value, FREEZE_LIMITS.fieldBytes, empty);
  if (['Pid', 'Uid', 'PID', 'UID', 'TID', 'VersionCode', 'eventLog_interval'].includes(name)) {
    integer(value, ['Pid', 'PID', 'TID'].includes(name));
  }
  if (name === 'Fingerprint' && !/^[0-9a-fA-F]{64}$/.test(value)) { throw new Error('FREEZE_FINGERPRINT_UNSUPPORTED'); }
  raw.set(name, value); fields[name] = { sha256, bytes: Buffer.byteLength(value), source };
}
function header(state: State, text: string, source: FreezeSource) {
  const match = /^([^:]+):[ \t]*(.*)$/.exec(text);
  if (match && headerFields.has(match[1])) {
    field(state.raw, state.parsed.fields, match[1], match[2], source);
    if (match[1] === 'Reason' && !reasons.has(match[2])) { throw new Error('FREEZE_INPUT_TYPE_UNSUPPORTED'); }
    return;
  }
  if (/^(?:Tid:|#|start time:)/.test(text)) { throw new Error('FREEZE_ENVELOPE_UNSUPPORTED'); }
  state.parsed.ignoredLines++;
}
function ensureThreadComplete(current: PhaseState) {
  if (current.thread && !current.thread.frames.length) { throw new Error('FREEZE_THREAD_TRUNCATED'); }
}
function beginPhase(state: State, value: string, source: FreezeSource) {
  if (!state.pending || state.current || state.parsed.phases.length === FREEZE_LIMITS.phases) { throw new Error('FREEZE_PHASE_ORDER_UNSUPPORTED'); }
  const phase: FreezePhase = { event: '', pid: 0, uid: 0, targetTid: null, targetBasis: 'missing-event-tid',
    targetThreadOrdinal: null, source: state.pending, fields: {}, threads: [], sections: [] };
  state.current = { phase, raw: new Map(), mode: 'metadata', thread: null };
  field(state.current.raw, phase.fields, 'start time', value, source);
  state.parsed.phases.push(phase); state.pending = null;
}
function endPhase(current: PhaseState) {
  ensureThreadComplete(current);
  const required = ['start time', 'EVENTNAME', 'TIMESTAMP', 'PID', 'UID', 'MSG'];
  if (required.some(name => !current.raw.has(name)) || !current.phase.threads.length) { throw new Error('FREEZE_PHASE_TRUNCATED'); }
  const event = current.raw.get('EVENTNAME')!;
  if (!events.has(event)) { throw new Error('FREEZE_EVENT_UNSUPPORTED'); }
  const phase = current.phase; phase.event = event; phase.pid = integer(current.raw.get('PID')!, true);
  phase.uid = integer(current.raw.get('UID')!);
  const tid = current.raw.has('TID') ? integer(current.raw.get('TID')!, true) : null;
  if (event === 'THREAD_BLOCK_3S' || event === 'THREAD_BLOCK_6S') {
    if (tid !== null && tid !== phase.pid) { throw new Error('FREEZE_MAIN_TID_CONFLICT'); }
    phase.targetTid = phase.pid; phase.targetBasis = 'main-pid-declared';
  } else { phase.targetTid = tid; phase.targetBasis = tid === null ? 'missing-event-tid' : 'event-tid-declared'; }
  const ordinal = phase.threads.findIndex(thread => thread.tid === phase.targetTid);
  phase.targetThreadOrdinal = ordinal < 0 ? null : ordinal;
}
function separator(state: State, source: FreezeSource) {
  if (state.pending || state.parsed.phases.length === FREEZE_LIMITS.phases) { throw new Error('FREEZE_PHASE_LIMIT'); }
  if (state.current) { endPhase(state.current); state.current = null; }
  if (!state.raw.has('Reason')) { throw new Error('FREEZE_INPUT_TYPE_UNSUPPORTED'); }
  state.pending = source;
}
function sectionName(text: string): string | null {
  if (/^EventHandler dump begin curTime:/.test(text)) { return 'event-queue'; }
  if (/^Catche stack trace start time:/.test(text)) { return 'stack-start'; }
  if (/^Catche stack trace end time:/.test(text)) { return 'stack-end'; }
  if (/^(?:Peer)?BinderCatcher(?: --|$)/.test(text)) { return 'binder'; }
  if (text === '--[cpuusage]--') { return 'cpu'; }
  if (/^MemoryCatcher --/.test(text)) { return 'memory'; }
  if (/^(?:start collect hotInfo|ThermalInfoCatcher)/.test(text)) { return 'thermal'; }
  if (/^(?:FfrtCatcher|FfrtCallback:)/.test(text)) { return 'ffrt'; }
  if (/^(?:FREEZE_EXT_INFO|#ThreadInfos Tid:)/.test(text)) { return 'sample-stacks'; }
  if (/^=+SubmitterStacktrace=+$/.test(text)) { return 'submitter-stack'; }
  if (text === 'HiLog:') { return 'hilog'; }
  return null;
}
function section(current: PhaseState, name: string, source: FreezeSource) {
  ensureThreadComplete(current);
  if (name === 'sample-stacks' && current.phase.sections.some(item => item.name === name)) { return; }
  if (current.phase.sections.length === FREEZE_LIMITS.sectionsPerPhase) { throw new Error('FREEZE_SECTION_LIMIT'); }
  current.phase.sections.push({ name, source });
  if ((name === 'event-queue' || name === 'stack-start') && !current.phase.threads.length) { current.mode = 'context'; }
  else { current.mode = 'supplementary'; }
  current.thread = null;
}
function nativeSuffix(text: string): Pick<FreezeFrame, 'functionSha256' | 'functionOffset' | 'buildId'> {
  let rest = text, buildId: string | null = null;
  const id = /\(([0-9a-fA-F]+)\)$/.exec(rest);
  if (id) {
    if (id[1].length % 2 || id[1].length > FREEZE_LIMITS.buildIdBytes * 2) { throw new Error('FREEZE_BUILD_ID_UNSUPPORTED'); }
    buildId = id[1]; rest = rest.slice(0, id.index);
  }
  if (!rest) { return { buildId, functionSha256: null, functionOffset: null }; }
  const fn = /^\((.+)\+(-?[0-9]+)\)$/.exec(rest);
  if (!fn || fn[2].length > 20 || BigInt(fn[2]) < -(1n << 63n) || BigInt(fn[2]) >= (1n << 63n)) { throw new Error('FREEZE_FUNCTION_UNSUPPORTED'); }
  let depth = 0;
  for (const char of fn[1]) {
    if (char === '(') { depth++; }
    if (char === ')' && --depth < 0) { throw new Error('FREEZE_FUNCTION_UNSUPPORTED'); }
  }
  if (depth) { throw new Error('FREEZE_FUNCTION_UNSUPPORTED'); }
  return { buildId, functionSha256: hash(fn[1], FREEZE_LIMITS.nameBytes), functionOffset: fn[2] };
}
function nativeFrame(text: string, ordinal: number, source: FreezeSource): FreezeFrame {
  const match = /^#([0-9]+)[ \t]+pc[ \t]+([0-9a-fA-F]{8}|[0-9a-fA-F]{16})[ \t]+([^()]+)(.*)$/.exec(text);
  if (!match || integer(match[1]) !== ordinal) { throw new Error('FREEZE_NATIVE_FRAME_UNSUPPORTED'); }
  const location = match[3];
  if (!['[shmm]', '[Unknown]'].includes(location) && (!location.startsWith('/') || /\s/.test(location))) { throw new Error('FREEZE_LOCATION_UNSUPPORTED'); }
  return { ordinal, kind: 'native', pc: match[2], locationSha256: hash(location, FREEZE_LIMITS.nameBytes),
    ...nativeSuffix(match[4]), line: null, column: null, source };
}
function jsFrame(text: string, ordinal: number, source: FreezeSource): FreezeFrame {
  const match = /^#([0-9]+)[ \t]+at[ \t]+(.+?)[ \t]+\((.+):([0-9]+):([0-9]+)\)$/.exec(text);
  if (!match || integer(match[1]) !== ordinal || !/\.(?:ets|ts|js)$/.test(match[3])) { throw new Error('FREEZE_JS_FRAME_UNSUPPORTED'); }
  const parts = match[3].split('|');
  if (parts.length !== 1 && (parts.length !== 4 || parts.some(part => !part))) { throw new Error('FREEZE_LOCATION_UNSUPPORTED'); }
  return { ordinal, kind: 'js', pc: null, buildId: null, functionOffset: null,
    functionSha256: hash(match[2], FREEZE_LIMITS.nameBytes), locationSha256: hash(match[3], FREEZE_LIMITS.nameBytes),
    line: integer(match[4], true), column: integer(match[5]), source };
}
function thread(current: PhaseState, text: string, source: FreezeSource) {
  ensureThreadComplete(current);
  const match = /^Tid:([0-9]+),[ \t]*Name:(.+)$/.exec(text);
  if (!match || current.phase.threads.length === FREEZE_LIMITS.threadsPerPhase) { throw new Error('FREEZE_THREAD_UNSUPPORTED'); }
  const tid = integer(match[1], true);
  if (current.phase.threads.some(item => item.tid === tid)) { throw new Error('FREEZE_THREAD_DUPLICATED'); }
  current.thread = { tid, nameSha256: hash(match[2], FREEZE_LIMITS.nameBytes), source, frames: [], state: null };
  current.phase.threads.push(current.thread); current.mode = 'stack';
}
function threadState(current: PhaseState, text: string, source: FreezeSource) {
  if (!current.thread || current.thread.frames.length || current.thread.state) { throw new Error('FREEZE_THREAD_STATE_UNSUPPORTED'); }
  const match = /^state=([RSDZTtWXxKPI]), utime=([0-9]+), (?:stime=([0-9]+), )?priority=(-?[0-9]+), nice=(-?[0-9]+), clk=([0-9]+)$/.exec(text);
  if (!match || match.slice(2).filter(value => value !== undefined).some(value => !Number.isSafeInteger(Number(value)))) {
    throw new Error('FREEZE_THREAD_STATE_UNSUPPORTED');
  }
  current.thread.state = { sha256: hash(text, FREEZE_LIMITS.fieldBytes), bytes: Buffer.byteLength(text), source };
}
function body(state: State, text: string, source: FreezeSource) {
  const current = state.current!;
  const equals = /^([^=]+?)[ \t]*=[ \t]*(.*)$/.exec(text), colon = /^([^:]+):[ \t]*(.*)$/.exec(text);
  if (equals && phaseFields.has(equals[1])) {
    if (current.mode !== 'metadata') { throw new Error('FREEZE_EVENT_POSITION_UNSUPPORTED'); }
    field(current.raw, current.phase.fields, equals[1], equals[2], source);
    if (equals[1] === 'MSG') { current.mode = 'context'; }
    return;
  }
  const name = sectionName(text);
  if (name) { section(current, name, source); return; }
  if (current.mode === 'supplementary') { state.parsed.ignoredLines++; return; }
  if (colon && contextFields.has(colon[1]) && !current.phase.threads.length) {
    field(current.raw, current.phase.fields, colon[1], colon[2], source); return;
  }
  if (text.startsWith('Tid:')) { thread(current, text, source); return; }
  if (text.startsWith('state=')) { threadState(current, text, source); return; }
  if (text.startsWith('#')) {
    if (!current.thread || current.thread.frames.length === FREEZE_LIMITS.framesPerThread || state.frameCount === FREEZE_LIMITS.totalFrames) {
      throw new Error('FREEZE_FRAME_LIMIT');
    }
    const ordinal = current.thread.frames.length;
    current.thread.frames.push(/^#[0-9]+[ \t]+at[ \t]/.test(text) ? jsFrame(text, ordinal, source) : nativeFrame(text, ordinal, source));
    state.frameCount++; return;
  }
  if (text && current.mode === 'stack') { throw new Error('FREEZE_STACK_UNSUPPORTED'); }
  state.parsed.ignoredLines++;
}
function consume(state: State, text: string, source: FreezeSource) {
  if (/^\[(?:truncated)\]$|^\.{3,}$|^\*{3} GWP-ASan|^(?:Error name|Error message|Fault thread info):/.test(text) ||
    ((state.current || state.pending) && /^(?:Device info|Reason):/.test(text))) { throw new Error('FREEZE_EVENT_UNSUPPORTED'); }
  if (/^\*{3,}$/.test(text)) { separator(state, source); return; }
  const start = /^start time:[ \t]*(.*)$/.exec(text);
  if (start && state.pending) { beginPhase(state, start[1], source); return; }
  if (state.pending) {
    if (text) { throw new Error('FREEZE_PHASE_START_UNSUPPORTED'); }
    state.parsed.ignoredLines++; return;
  }
  if (state.current) { body(state, text, source); }
  else { header(state, text, source); }
}
function validateIdentity(state: State) {
  const raw = state.raw, pid = raw.get('Pid') ?? raw.get('PID'), uid = raw.get('Uid') ?? raw.get('UID');
  if (!pid || uid === undefined) { throw new Error('FREEZE_IDENTITY_MISSING'); }
  for (const [left, right] of [['Pid', 'PID'], ['Uid', 'UID'], ['Reason', 'STRINGID']]) {
    if (raw.has(left) && raw.has(right) && raw.get(left) !== raw.get(right)) { throw new Error('FREEZE_IDENTITY_CONFLICT'); }
  }
  for (const phase of state.parsed.phases) {
    if (phase.pid !== integer(pid, true) || phase.uid !== integer(uid)) { throw new Error('FREEZE_IDENTITY_CONFLICT'); }
    for (const name of ['Pid', 'Uid']) {
      const claim = phase.fields[name], expected = name === 'Pid' ? pid : uid;
      if (claim && claim.sha256 !== digest(expected)) { throw new Error('FREEZE_IDENTITY_CONFLICT'); }
    }
  }
  const process = state.parsed.phases[0]?.fields.PROCESS_NAME?.sha256;
  if (state.parsed.phases.some(phase => phase.fields.PROCESS_NAME?.sha256 !== process)) { throw new Error('FREEZE_IDENTITY_CONFLICT'); }
  const headerProcess = state.parsed.fields.PROCESS_NAME;
  if (headerProcess?.bytes && process && headerProcess.sha256 !== process) { throw new Error('FREEZE_IDENTITY_CONFLICT'); }
  for (const phase of state.parsed.phases) {
    const catcher = phase.fields['Process name'];
    if (catcher?.bytes && phase.fields.PROCESS_NAME?.bytes && catcher.sha256 !== phase.fields.PROCESS_NAME.sha256) {
      throw new Error('FREEZE_IDENTITY_CONFLICT');
    }
  }
}
function finish(state: State): FreezeParsed {
  if (state.pending || !state.current) { throw new Error('FREEZE_PHASE_TRUNCATED'); }
  endPhase(state.current); validateIdentity(state);
  const reason = state.raw.get('Reason')!;
  const phases = state.parsed.phases.map(phase => phase.event);
  const expected = reason === 'THREAD_BLOCK_6S' ? ['THREAD_BLOCK_3S', 'THREAD_BLOCK_6S'] : ['THREAD_BLOCK_3S', reason];
  if ((phases.length === 1 && phases[0] !== reason && !(reason === 'THREAD_BLOCK_6S' && phases[0] === 'THREAD_BLOCK_3S')) ||
    (phases.length === 2 && (reason.startsWith('BUS') || phases.some((event, index) => event !== expected[index])))) {
    throw new Error('FREEZE_EVENT_CONFLICT');
  }
  state.parsed.reason = reason; return state.parsed;
}
export async function parseFreezeLog(bytes: Buffer, signal: AbortSignal): Promise<FreezeParsed> {
  signal.throwIfAborted();
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > FREEZE_LIMITS.fileBytes || !Buffer.from(text).equals(bytes) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0')) { throw new Error('FREEZE_TEXT_UNSUPPORTED'); }
  const state: State = { parsed: { reason: '', fields: {}, phases: [], ignoredLines: 0 }, raw: new Map(),
    current: null, pending: null, frameCount: 0 };
  let offset = 0, lines = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, raw = bytes.subarray(offset, end);
    if (++lines > FREEZE_LIMITS.lines || raw.length > FREEZE_LIMITS.lineBytes) { throw new Error('FREEZE_LINE_LIMIT'); }
    consume(state, raw.toString('utf8').replace(/\r?\n$/, '').trim(), { line: lines, offset, bytes: raw.length, sha256: digest(raw) });
    offset = end;
    if (lines % 512 === 0) { await setImmediate(); }
  }
  signal.throwIfAborted(); return finish(state);
}
