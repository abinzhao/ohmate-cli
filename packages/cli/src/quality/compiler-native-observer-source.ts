/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Shares only the private preload's bounded job state; no process-table or native file tracing.
export const compilerNativeObserverSource = String.raw`
const nativeContext = new (require('node:async_hooks').AsyncLocalStorage)();
const nativePrototypes = new WeakSet(), childProcess = require('node:child_process'), nativeExec = childProcess.exec;
let blockedNativeHooks = false;
function nativeConfiguration(object) {
  const values = configuration(object);
  if (Object.values(values).some(value => typeof value === 'string' &&
      value.split(/[\\/]/).some(part => privateName.test(part)))) throw new Error('Unsafe native configuration');
  return values;
}
function nativeCommand(receiver) {
  const args = dataProperty(receiver, 'cmdArgs').value;
  const length = args && dataProperty(args, 'length').value;
  if (!Array.isArray(args) || !Number.isInteger(length) || length < 1) throw new Error('Unknown native arguments');
  if (length > 256) { current().missing.add('native-compiler-call-budget'); return; }
  const values = [];
  let bytes = 0;
  for (let index = 0; index < length; index++) {
    const value = dataProperty(args, String(index)).value;
    if (typeof value !== 'string') throw new Error('Unknown native argument');
    bytes += Buffer.byteLength(value) + (index ? 1 : 0);
    if (value.length > 4096 || bytes > 64 * 1024) {
      current().missing.add('native-compiler-call-budget'); return;
    }
    values.push(value);
  }
  return { commandSha256: digest(values.join(' ')), commandBytes: bytes, argumentCount: length };
}
function beginNativeCall(receiver) {
  const state = current();
  if (!state || !limit()) return;
  if (state.nativeCalls.length >= 64) { state.missing.add('native-compiler-call-budget'); return; }
  try {
    const command = nativeCommand(receiver);
    if (!command) return;
    const paths = [];
    for (const [role, key] of [['files-info', 'filesInfoPath'], ['npm-entries', 'npmEntriesInfoPath'],
        ['cache-info', 'cacheFilePath'], ['compile-context', 'compileContextInfoPath'], ['output', 'moduleAbcPath']]) {
      const file = dataProperty(receiver, key).value;
      if (file === undefined) continue;
      const allowed = permitted(file);
      if (!allowed) throw new Error('Unknown native reference');
      paths.push({ role, ...allowed });
    }
    const record = { sequence: state.nativeCalls.length + 1, kind: 'sdk-es2abc-shell-call', ...command,
      projectConfiguration: nativeConfiguration(dataProperty(receiver, 'projectConfig').value),
      arkConfiguration: nativeConfiguration(dataProperty(receiver, 'arkConfig').value),
      ...nativeDescriptionReferences(receiver, state, paths),
      paths, dispatch: 'not-observed', pid: null, close: null };
    // Reserve the bounded terminal metadata before dispatch, so late events cannot exceed the quota.
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 128;
    if (state.nativeBytes + bytes > 256 * 1024 || state.bytes + bytes > 64 * 1024 * 1024) {
      state.missing.add('native-compiler-call-budget'); return;
    }
    state.nativeBytes += bytes; state.bytes += bytes; state.nativeCalls.push(record);
    return { state, record, dispatched: false };
  } catch { state.missing.add('native-compiler-call-unobservable'); }
}
function observeNativeChild(ticket, child) {
  const { state, record } = ticket;
  try {
    const pid = dataProperty(child, 'pid').value;
    if (!Number.isSafeInteger(pid) || pid < 1) state.missing.add('native-compiler-process-identity-unavailable');
    else record.pid = pid;
    const original = dataProperty(child, 'emit').value;
    if (typeof original !== 'function') throw new Error('Unknown native event dispatch');
    state.pendingNative.add(ticket);
    const replacement = function(event, ...args) {
      if (!state.closed) {
        if (event === 'close') {
          const [code, signal] = args;
          if ((code === null || Number.isSafeInteger(code)) &&
              (signal === null || typeof signal === 'string' && /^[A-Z0-9_-]{1,40}$/.test(signal))) {
            if (record.close) state.missing.add('native-compiler-close-duplicate');
            else record.close = { code, signal };
            state.pendingNative.delete(ticket);
          } else state.missing.add('native-compiler-close-unobservable');
        } else if (event === 'error') state.missing.add('native-compiler-process-error');
      }
      return Reflect.apply(original, this, [event, ...args]);
    };
    Object.defineProperty(child, 'emit', { value: replacement, writable: true, configurable: true });
  } catch { state.missing.add('native-compiler-process-uninstrumentable'); state.pendingNative.add(ticket); }
}
childProcess.exec = function(command, ...args) {
  const ticket = nativeContext.getStore();
  if (!ticket || ticket.state.closed) return Reflect.apply(nativeExec, this, [command, ...args]);
  let matched = false;
  try {
    if (ticket.dispatched) ticket.state.missing.add('native-compiler-multiple-dispatch');
    else if (typeof command !== 'string' || Buffer.byteLength(command) !== ticket.record.commandBytes ||
        digest(command) !== ticket.record.commandSha256) ticket.state.missing.add('native-compiler-command-mismatch');
    else { matched = true; ticket.dispatched = true; }
  } catch { ticket.state.missing.add('native-compiler-call-unobservable'); }
  let child;
  try { child = Reflect.apply(nativeExec, this, [command, ...args]); }
  catch (error) { if (matched) ticket.record.dispatch = 'threw'; throw error; }
  if (matched) { ticket.record.dispatch = 'returned'; observeNativeChild(ticket, child); }
  return child;
};
function patchNativeCompiler(api) {
  let prototype, original;
  try {
    prototype = dataProperty(dataProperty(api, 'ModuleMode').value, 'prototype').value;
    if (!prototype || nativePrototypes.has(prototype)) return;
    original = dataProperty(prototype, 'generateMergedAbcOfEs2Abc').value;
    if (typeof original !== 'function') return;
    const replacement = function(...args) {
      const ticket = beginNativeCall(this);
      if (!ticket) return Reflect.apply(original, this, args);
      return nativeContext.run(ticket, () => Reflect.apply(original, this, args));
    };
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'generateMergedAbcOfEs2Abc');
    Object.defineProperty(prototype, 'generateMergedAbcOfEs2Abc', { ...descriptor, value: replacement });
    nativePrototypes.add(prototype);
  } catch { blockedNativeHooks = true; current()?.missing.add('native-compiler-call-uninstrumentable'); }
}
`;
