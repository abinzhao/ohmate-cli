/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Write-call fingerprints deliberately do not certify disk contents or native reads.
export const compilerNativeDescriptionSource = String.raw`
const descriptionContext = new (require('node:async_hooks').AsyncLocalStorage)();
const descriptionOwners = new WeakMap(), descriptionPrototypes = new WeakSet(), descriptionWrite = fs.writeFileSync;
let blockedDescriptionHooks = false;
function descriptionOwner(receiver, state) {
  let owner = descriptionOwners.get(receiver);
  if (owner && owner.state !== state) { state.missing.add('native-description-owner-mismatch'); return; }
  if (!owner) { owner = { state, id: crypto.randomUUID(), latest: new Map(), attempts: new Map() }; descriptionOwners.set(receiver, owner); }
  return owner;
}
function descriptionFingerprint(ticket, file, value, options) {
  const state = ticket.owner.state;
  if (state.closed || !limit()) return;
  try {
    const allowed = permitted(file);
    if (!allowed || (ticket.file ? file !== ticket.file : !inside(ticket.cachePath, file))) {
      throw new Error('Unknown description destination');
    }
    state.descriptionDestinations.delete(inputKey(allowed));
    const encoding = typeof options === 'string' ? options : options === undefined ? 'utf8' :
      dataProperty(options, 'encoding').value ?? 'utf8';
    if (typeof value !== 'string' && !Buffer.isBuffer(value) ||
        typeof value === 'string' && !['utf8', 'utf-8'].includes(encoding)) {
      throw new Error('Unknown description representation');
    }
    const size = Buffer.byteLength(value);
    if (size > 8 * 1024 * 1024 || state.descriptionRecords >= 64 ||
        state.descriptionInputBytes + size > 16 * 1024 * 1024 ||
        state.bytes + size + 8192 > 64 * 1024 * 1024) {
      ticket.incomplete = true; state.missing.add('native-description-budget'); return;
    }
    const record = { sequence: 0, observationOrder: ++state.nativeOrder, ownerId: ticket.owner.id,
      operation: ticket.method, role: ticket.role, ...allowed, size, sha256: digest(value),
      write: 'threw', generation: 'threw', binding: 'sdk-write-call-only',
      inputReferences: descriptionInputReferences(ticket, value) };
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 16;
    if (state.descriptionBytes + bytes > 256 * 1024) {
      ticket.incomplete = true; state.missing.add('native-description-budget'); return;
    }
    state.descriptionRecords++;
    state.descriptionBytes += bytes; state.descriptionInputBytes += size; state.bytes += size + bytes;
    state.descriptionDestinations.set(inputKey(allowed), record);
    ticket.records.push(record); return record;
  } catch {
    ticket.incomplete = true; state.descriptionDestinations.clear(); state.missing.add('native-description-unobservable');
  }
}
const descriptionWriteWrapper = function(file, value, ...args) {
  const inputTicket = nativeInputContext.getStore();
  const inputRecord = inputTicket && !inputTicket.closed ? inputFingerprint(inputTicket, file, value, args[0]) : undefined;
  const ticket = descriptionContext.getStore();
  const record = ticket && !ticket.closed ? descriptionFingerprint(ticket, file, value, args[0]) : undefined;
  const result = Reflect.apply(descriptionWrite, this, [file, value, ...args]);
  if (record) record.write = 'returned';
  if (inputRecord) inputRecord.write = 'returned';
  return result;
};
try {
  fs.writeFileSync = descriptionWriteWrapper;
  if (fs.writeFileSync !== descriptionWriteWrapper) throw new Error('Unknown description write hook');
} catch {
  blockedDescriptionHooks = true; blockedInputHooks = true;
  current()?.missing.add('native-description-uninstrumentable');
  current()?.missing.add('native-input-uninstrumentable');
}
function finishDescription(ticket, returned, value) {
  ticket.closed = true;
  const state = ticket.owner.state;
  if (state.closed) return;
  try {
    const target = ticket.file ?? value;
    if (!permitted(target)) throw new Error('Unknown description return');
    const records = ticket.records.filter(record => record.path === target);
    const latestAttempt = ticket.owner.attempts.get(ticket.role) === ticket;
    ticket.owner.latest.delete(ticket.role);
    const unique = records.length === 1 && ticket.records.length === 1 && !ticket.incomplete && latestAttempt;
    if (!unique) { state.missing.add('native-description-write-unavailable'); }
    for (const record of records) {
      record.sequence = state.nativeDescriptions.length + 1;
      record.generation = returned ? 'returned' : 'threw';
      state.nativeDescriptions.push(record);
      // A later failed attempt must never fall back to an earlier successful generation.
      if (unique) ticket.owner.latest.set(ticket.role, record);
      if (record.write !== 'returned' || !returned) state.missing.add('native-description-generation-failed');
    }
  } catch { state.missing.add('native-description-unobservable'); }
}
function patchNativeDescriptions(api) {
  let prototype;
  try {
    prototype = dataProperty(dataProperty(api, 'ModuleMode').value, 'prototype').value;
    if (!prototype || descriptionPrototypes.has(prototype)) return;
    for (const [method, role, key] of [
      ['generateCompileFilesInfo', 'files-info', 'filesInfoPath'],
      ['generateNpmEntriesInfo', 'npm-entries', 'npmEntriesInfoPath'],
      ['generateAbcCacheFilesInfo', 'cache-info', 'cacheFilePath'],
      ['generateCompileContextInfo', 'compile-context', undefined],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method), original = descriptor?.value;
      if (typeof original !== 'function') continue;
      const replacement = function(...args) {
        const state = current();
        if (!state) return Reflect.apply(original, this, args);
        let ticket;
        try {
          const owner = descriptionOwner(this, state);
          if (owner) {
            owner.latest.delete(role);
            owner.attempts.set(role, undefined);
            const file = key ? dataProperty(this, key).value : undefined;
            const cachePath = key ? undefined : dataProperty(dataProperty(this, 'projectConfig').value, 'cachePath').value;
            if (!permitted(key ? file : cachePath)) throw new Error('Unknown description path');
            if (key) state.descriptionDestinations.delete(inputKey(permitted(file)));
            ticket = { owner, method, role, file, cachePath, records: [], closed: false, incomplete: false };
            owner.attempts.set(role, ticket);
          }
        } catch { state.descriptionDestinations.clear(); state.missing.add('native-description-unobservable'); }
        if (!ticket) return Reflect.apply(original, this, args);
        return descriptionContext.run(ticket, () => {
          let value, returned = false;
          try { value = Reflect.apply(original, this, args); returned = true; return value; }
          finally { finishDescription(ticket, returned, value); }
        });
      };
      try { Object.defineProperty(prototype, method, { ...descriptor, value: replacement }); }
      catch { blockedDescriptionHooks = true; current()?.missing.add('native-description-uninstrumentable'); }
    }
    descriptionPrototypes.add(prototype);
  } catch { blockedDescriptionHooks = true; current()?.missing.add('native-description-uninstrumentable'); }
}
function nativeDescriptionReferences(receiver, state, paths) {
  const owner = descriptionOwner(receiver, state), sequences = [];
  if (owner) {
    for (const file of paths) {
      const record = owner.latest.get(file.role);
      if (record && record.write === 'returned' && record.generation === 'returned' &&
          record.scope === file.scope && record.path === file.path) sequences.push(record.sequence);
    }
  }
  return { ownerId: owner?.id, observationOrder: ++state.nativeOrder, descriptionSequences: sequences.sort((a, b) => a - b) };
}
`;
