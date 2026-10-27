/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Source arguments and write-call bytes do not certify subsequent filesystem or native reads.
export const compilerNativeInputSource = String.raw`
const nativeInputContext = new (require('node:async_hooks').AsyncLocalStorage)();
const nativeInputApis = new WeakMap();
let blockedInputHooks = false;
const inputKey = file => file.scope + ':' + file.path;
function invalidateInputSource(state, source) {
  for (const [key, record] of state.latestInputs) {
    if (inputKey(record.source) === inputKey(source)) state.latestInputs.delete(key);
  }
}
function inputWritePath(file) {
  if (!permitted(file)) throw new Error('Unknown input path');
  const allowed = permitted(path.resolve(file));
  if (!allowed) throw new Error('Unsafe input path');
  return allowed;
}
function inputFingerprint(ticket, file, value, options) {
  const state = ticket.state;
  if (state.closed || ticket.closed || !limit()) return;
  try {
    const destination = inputWritePath(file);
    state.latestInputs.delete(inputKey(destination));
    state.inputDestinations.delete(inputKey(destination));
    state.descriptionDestinations.delete(inputKey(destination));
    const encoding = typeof options === 'string' ? options : options === undefined ? 'utf8' :
      dataProperty(options, 'encoding').value ?? 'utf8';
    if (typeof value !== 'string' && !Buffer.isBuffer(value) ||
        typeof value === 'string' && !['utf8', 'utf-8'].includes(encoding)) {
      throw new Error('Unknown input representation');
    }
    const size = Buffer.byteLength(value);
    if (size > 8 * 1024 * 1024 || state.nativeInputWrites.length >= 512 ||
        state.inputBytes + size > 16 * 1024 * 1024 || state.bytes + size + 8192 > 64 * 1024 * 1024) {
      state.missing.add('native-input-budget'); ticket.incomplete = true; return;
    }
    const record = { sequence: state.nativeInputWrites.length + 1, observationOrder: ++state.nativeOrder,
      generationId: ticket.id, operation: ticket.operation, source: ticket.source, destination, size,
      sha256: digest(value), write: 'threw', generation: 'pending', binding: 'sdk-source-write-call-only' };
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 128;
    if (state.inputMetadataBytes + bytes > 512 * 1024) {
      state.missing.add('native-input-budget'); ticket.incomplete = true; return;
    }
    state.inputBytes += size; state.inputMetadataBytes += bytes; state.bytes += size + bytes;
    state.nativeInputWrites.push(record); state.inputDestinations.set(inputKey(destination), record);
    ticket.records.push(record); return record;
  } catch { ticket.incomplete = true; state.missing.add('native-input-unobservable'); }
}
function finishInput(ticket, returned) {
  ticket.closed = true;
  const state = ticket.state;
  state.pendingInputs.delete(ticket);
  if (state.closed) return;
  const generationOrder = ++state.nativeOrder;
  for (const record of ticket.records) {
    record.generation = returned ? 'returned' : 'threw'; record.generationOrder = generationOrder;
  }
  const record = ticket.records[0];
  if (!returned || ticket.incomplete || ticket.records.length !== 1 || record.write !== 'returned') {
    state.missing.add('native-input-generation-unavailable'); return;
  }
  if (state.inputAttempts.get(inputKey(ticket.source)) === ticket.id &&
      state.inputDestinations.get(inputKey(record.destination)) === record) {
    state.latestInputs.set(inputKey(record.destination), record);
  }
}
function patchNativeInput(api, operation) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(api, operation), original = descriptor?.value;
    if (typeof original !== 'function') return;
    let methods = nativeInputApis.get(api);
    if (!methods) { methods = new Map(); nativeInputApis.set(api, methods); }
    if (methods.get(operation) === original) return;
    const replacement = function(...args) {
      const state = current();
      if (!state) return Reflect.apply(original, this, args);
      let ticket;
      try {
        const file = operation === 'writeFileSyncByNode' ? args[3] ||
          Object.getOwnPropertyDescriptor(args[0], 'fileName')?.value : args[0];
        const source = inputWritePath(file);
        invalidateInputSource(state, source);
        if (++state.inputAttemptRecords > 512 || state.pendingInputs.size >= 512 || !limit()) {
          state.missing.add('native-input-budget'); throw new Error('Input attempt budget');
        }
        const id = crypto.randomUUID();
        state.inputAttempts.set(inputKey(source), id);
        ticket = { state, source, operation, id, records: [], closed: false, incomplete: false };
        state.pendingInputs.add(ticket);
      } catch {
        state.latestInputs.clear(); state.descriptionDestinations.clear(); state.missing.add('native-input-unobservable');
      }
      if (!ticket) return nativeInputContext.run(undefined, () => Reflect.apply(original, this, args));
      return nativeInputContext.run(ticket, () => {
        let value;
        try { value = Reflect.apply(original, this, args); }
        catch (error) { finishInput(ticket, false); throw error; }
        if (value instanceof Promise) {
          // Observe settlement without replacing the SDK's Promise or consulting a user getter.
          Promise.prototype.then.call(value, () => { finishInput(ticket, true); },
            () => { finishInput(ticket, false); });
        } else finishInput(ticket, true);
        return value;
      });
    };
    Object.defineProperty(api, operation, { ...descriptor, value: replacement });
    methods.set(operation, replacement);
  } catch { blockedInputHooks = true; current()?.missing.add('native-input-uninstrumentable'); }
}
function inputReferencePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Unknown reference path');
  }
  if (value.split(path.sep).some(part => privateName.test(part))) throw new Error('Sensitive reference path');
  const file = path.resolve(roots.project, value);
  const allowed = permitted(file);
  if (!allowed) throw new Error('Unsafe reference path');
  return allowed;
}
function cacheDescriptionOrigin(ticket, input) {
  const owner = ticket.owner, state = owner.state, origin = owner.latest.get('npm-entries');
  if (!origin || origin.write !== 'returned' || origin.generation !== 'returned' ||
      inputKey(origin) !== inputKey(input) || state.descriptionDestinations.get(inputKey(input)) !== origin) return;
  if (state.nativeDescriptions.some(other => other.observationOrder > origin.observationOrder &&
      (inputKey(other) === inputKey(input) || other.ownerId === owner.id && other.role === origin.role)) ||
      state.nativeInputWrites.some(other => other.observationOrder > origin.observationOrder &&
        inputKey(other.destination) === inputKey(input))) return;
  return origin.sequence;
}
function descriptionInputReferences(ticket, value) {
  const state = ticket.owner.state, references = [];
  if (!['files-info', 'cache-info'].includes(ticket.role)) return references;
  try {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    if (Buffer.isBuffer(value) && !Buffer.from(text).equals(value)) throw new Error('Unknown reference encoding');
    let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start), stop = end === -1 ? text.length : end;
      if (references.length >= 512) { state.missing.add('native-input-reference-budget'); break; }
      if (stop - start > 32 * 1024) throw new Error('Reference line budget');
      const line = text.slice(start, stop).replace(/\r$/, '');
      start = stop + 1;
      const fields = line.split(';');
      const format = ticket.role === 'cache-info' && fields.length === 2 ? 'cache-pair' :
        ticket.role === 'files-info' && fields.length === 7 ? 'module' :
          ticket.role === 'files-info' && fields.length === 6 && fields.slice(1, 4).every(field => !field) &&
            !fields[5] ? 'bytecode' : undefined;
      if (!format) throw new Error('Unknown description row');
      const input = inputReferencePath(fields[0]), reference = { ordinal: references.length + 1, format, input,
        ...(format === 'cache-pair' ? { output: inputReferencePath(fields[1]) } : {}),
        fieldSha256: fields.slice(1).map(digest) };
      const write = state.latestInputs.get(inputKey(input));
      const description = format === 'cache-pair' ? cacheDescriptionOrigin(ticket, input) : undefined;
      if (description !== undefined) reference.sourceDescriptionSequence = description;
      else if (format !== 'bytecode' && write) reference.sourceWriteSequence = write.sequence;
      const bytes = Buffer.byteLength(JSON.stringify(reference)) + 16;
      if (state.inputReferenceBytes + bytes > 256 * 1024 || state.bytes + bytes > 64 * 1024 * 1024 || !limit()) {
        state.missing.add('native-input-reference-budget'); break;
      }
      state.inputReferenceBytes += bytes; state.bytes += bytes; references.push(reference);
    }
  } catch { state.missing.add('native-input-description-unobservable'); }
  return references;
}
`;
