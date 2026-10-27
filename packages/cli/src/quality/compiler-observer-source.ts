/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { compilerNativeObserverSource } from './compiler-native-observer-source.js';
import { compilerNativeDescriptionSource } from './compiler-native-description-source.js';
import { compilerNativeInputSource } from './compiler-native-input-source.js';

export const compilerConfigurationFields = [
  'projectTopDir', 'modulePath', 'entryModuleName', 'targetName', 'buildMode', 'buildId',
  'etsLoaderPath', 'aceBuildJson', 'aceModuleBuild', 'buildDir', 'cachePath', 'sourceMapDir', 'compileMode',
  'compileSdkVersion', 'compatibleSdkVersion', 'useTscResolve', 'useUnifiedAst', 'shouldEmitJs',
  'cacheDirectory', 'enableFileSystemCache', 'watchMode', 'writeRollupCache', 'useSourceHash', 'usePathPlaceholder',
  'hotReloadBuild', 'arkCompileCachePath', 'isPreview', 'nodePath', 'arkRootPath', 'es2abcPath', 'ts2abcPath',
  'js2abcPath', 'mergeAbcPath', 'aotCompilerPath', 'bcObfuscatorPath', 'isDebug', 'isBranchElimination',
  'optTryCatchFunc', 'projectRootPath', 'processTs', 'pandaMode', 'hotReload', 'coldReload', 'isFirstBuild',
  'minPlatformVersion', 'moduleName', 'cacheBytecodeHar',
] as const;
export const compilerCacheInfoFiles = [
  '.tsbuildinfo', '.tsbuildinfo.linter', '.ts_checker_cache', '.ts_checker_cache_widget',
] as const;
// This preload runs only in privately owned official build processes and workers.
export const compilerObserverSource = String.raw`
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const context = new (require('node:async_hooks').AsyncLocalStorage)(), jobs = new Set();
const { fileURLToPath } = require('node:url');
const read = fs.readFileSync, exists = fs.existsSync, stat = fs.lstatSync, real = fs.realpathSync;
const readAsync = fs.readFile, promises = require('node:fs/promises'), readPromise = promises.readFile;
const openPromise = promises.open, fstat = fs.fstatSync, handles = new WeakMap();
const createStream = fs.createReadStream;
const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
const roots = { project: process.env.OHMATE_COMPILER_PROJECT, sdk: process.env.OHMATE_COMPILER_SDK };
const out = process.env.OHMATE_COMPILER_OBSERVATIONS;
const privateName = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.ohpmrc|local\.properties|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, file) => root && (file === root || file.startsWith(root + path.sep));
let hostDepth = 0;
const wrapped = new WeakSet();
const hosts = new WeakMap(), hostReads = [];
const frontends = new WeakMap();
const current = () => { const state = context.getStore(); return state && !state.closed ? state : undefined; };
function permitted(file) {
  const active = current();
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096) return null;
  const scope = Object.keys(roots).find(key => inside(roots[key], file));
  if (!scope) return null;
  const name = path.relative(roots[scope], file);
  if (inside(out, file) || name.split(path.sep).some(part => privateName.test(part) || /[\x00-\x1f\x7f]/.test(part))) {
    if (active && hostDepth) active.missing.add('sensitive-compiler-input');
    return null;
  }
  return { scope, path: file };
}
function limit() {
  const active = current();
  if (!active) return false;
  if (++active.records > 10000) { active.missing.add('compiler-observation-budget'); return false; }
  return true;
}
function observedRead(file, value, method = 'readFileSync', fingerprint) {
  const active = current();
  if (typeof value === 'string') { observedText(file, method, value, new Set()); return; }
  if (!active || !limit()) return;
  const allowed = permitted(file);
  if (!allowed) return;
  try {
    const canonical = real(file);
    if (!permitted(canonical)) { active.missing.add('unsafe-compiler-input'); return; }
    const info = stat(canonical);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024 ||
        active.bytes + info.size > 64 * 1024 * 1024) { active.missing.add('compiler-read-budget-or-type'); return; }
    if (!fingerprint && !Buffer.isBuffer(value)) { active.missing.add('compiler-read-representation'); return; }
    const bytes = value;
    const size = fingerprint ? fingerprint.size : bytes.length;
    if (size !== info.size) { active.missing.add('compiler-read-size'); return; }
    const sha256 = fingerprint ? fingerprint.sha256 : digest(bytes), key = allowed.scope + ':' + canonical;
    const previous = active.files.get(key);
    const generated = ['cachePath', 'aceModuleBuild'].some(key => inside(active.configuration[key], canonical));
    const cacheInfo = active.configuration.cachePath && ${JSON.stringify(compilerCacheInfoFiles)}
      .some(name => canonical === path.resolve(active.configuration.cachePath, '..', name));
    const role = cacheInfo ? 'compiler-cache-read' : hostDepth || previous?.role === 'compiler-host-read' ? 'compiler-host-read' :
      generated ? 'generated-runtime-read' : 'runtime-read';
    if (previous && previous.sha256 !== sha256 && role !== 'generated-runtime-read' && role !== 'compiler-cache-read') active.drift.add(canonical);
    if (!previous) active.bytes += size;
    active.files.set(key, { scope: allowed.scope, path: canonical, size, sha256, role,
      readMethods: [...new Set([...(previous?.readMethods || []), method])] });
    active.cacheReads.set(canonical, { scope: allowed.scope, path: canonical, sha256, binding: 'raw-filesystem-bytes' });
    active.cacheReadOrders.set(canonical, active.records);
    if (bytes) active.cacheBuffers.set(bytes, active.cacheReads.get(canonical));
    for (const frame of hostReads) frame.add(key);
  } catch { active.missing.add('compiler-input-unreadable'); }
}
fs.readFileSync = function(file, ...args) {
  try { const value = Reflect.apply(read, this, [file, ...args]); observedRead(file, value); return value; }
  catch (error) {
    const active = current();
    if (active && hostDepth && limit()) {
      const allowed = permitted(file);
      if (allowed && error.code === 'ENOENT') active.probes.set(allowed.scope + ':' + file, { ...allowed, exists: false });
      else if (allowed) active.missing.add('compiler-input-unreadable');
    }
    throw error;
  }
};
fs.existsSync = function(file) {
  const active = current();
  const value = Reflect.apply(exists, this, [file]);
  if (active && hostDepth && limit()) { const allowed = permitted(file); if (allowed) active.probes.set(allowed.scope + ':' + file, { ...allowed, exists: value }); }
  return value;
};
function readFailure(file, error) {
  const active = current();
  if (!active || !limit()) return;
  const allowed = permitted(file);
  if (allowed && error.code === 'ENOENT') active.probes.set(allowed.scope + ':' + file, { ...allowed, exists: false });
  else if (allowed) active.missing.add('compiler-input-unreadable');
}
function readPath(file) {
  const state = current();
  try {
    if (file instanceof URL) file = fileURLToPath(file);
    if (typeof file !== 'string') { state?.missing.add('compiler-read-path-unavailable'); return null; }
    if (file.split(path.sep).some(part => privateName.test(part))) {
      state?.missing.add('sensitive-compiler-input'); return null;
    }
    return path.resolve(file);
  } catch { state?.missing.add('compiler-read-path-unavailable'); return null; }
}
function beginRead(file) {
  const state = current();
  if (!state) return undefined;
  if (state.pending.size >= 10000) { state.missing.add('compiler-observation-budget'); return undefined; }
  const ticket = { state, file: readPath(file) };
  state.pending.add(ticket);
  return ticket;
}
function finishRead(ticket, error, value, method) {
  if (!ticket) return;
  ticket.state.pending.delete(ticket);
  if (ticket.state.closed) return;
  context.run(ticket.state, () => { if (error) readFailure(ticket.file, error); else observedRead(ticket.file, value, method); });
}
function descriptorIdentity(handle, file) {
  const active = current();
  try {
    const canonical = real(file);
    if (!permitted(file) || !permitted(canonical)) throw new Error('Unsafe handle path');
    const descriptor = Reflect.apply(fstat, fs, [handle.fd]), named = stat(canonical);
    if (!descriptor.isFile() || descriptor.nlink !== 1 || descriptor.size > 8 * 1024 * 1024 ||
        !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => descriptor[key] === named[key])) {
      throw new Error('Handle identity mismatch');
    }
    return { canonical, descriptor };
  } catch { active?.missing.add('compiler-filehandle-identity-unavailable'); return null; }
}
function beginHandleRead(handle) {
  const active = current(), origin = handles.get(handle);
  if (!active) return undefined;
  if (!origin) active.missing.add('compiler-filehandle-origin-unavailable');
  const ticket = beginRead(origin?.file);
  if (ticket) {
    ticket.handle = handle;
    ticket.identity = origin?.file ? descriptorIdentity(handle, origin.file) : null;
  }
  return ticket;
}
function finishHandleRead(ticket, error, value, method) {
  if (!ticket) return;
  ticket.state.pending.delete(ticket);
  if (ticket.state.closed) return;
  context.run(ticket.state, () => {
    if (error) { readFailure(ticket.file, error); return; }
    if (!ticket.identity) return;
    const after = descriptorIdentity(ticket.handle, ticket.file);
    if (!after || after.canonical !== ticket.identity.canonical ||
        !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key =>
          after.descriptor[key] === ticket.identity.descriptor[key])) {
      current().missing.add('compiler-filehandle-identity-unavailable'); return;
    }
    observedRead(after.canonical, value, method);
  });
}
function handleRead(original, receiver, args, method) {
  const ticket = beginHandleRead(receiver);
  try {
    const result = Reflect.apply(original, receiver, args);
    if (!ticket) return result;
    return result.then(value => { finishHandleRead(ticket, null, value, method); return value; },
      error => { finishHandleRead(ticket, error, undefined, method); throw error; });
  } catch (error) { finishHandleRead(ticket, error, undefined, method); throw error; }
}
function dataProperty(object, name) {
  for (let depth = 0; object && depth < 10; depth++, object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor) {
      if (!('value' in descriptor)) throw new Error('Accessor is not observable');
      return descriptor;
    }
  }
  return { value: undefined };
}
function streamIdentity(ticket, stream) {
  const identity = descriptorIdentity(stream, ticket.file);
  if (!identity) { ticket.failed = true; return; }
  if (!ticket.identity) ticket.identity = identity;
  if (identity.canonical !== ticket.identity.canonical || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
    .every(key => identity.descriptor[key] === ticket.identity.descriptor[key])) {
    ticket.state.missing.add('compiler-filehandle-identity-unavailable'); ticket.failed = true;
  }
}
function streamChunk(ticket, stream, chunk) {
  if (ticket.done || ticket.state.closed || ticket.failed) return;
  context.run(ticket.state, () => {
    if (!ticket.readStarted) {
      ticket.state.missing.add('compiler-stream-read-representation'); ticket.failed = true; return;
    }
    streamIdentity(ticket, stream);
    if (ticket.failed || !limit()) { ticket.failed = true; return; }
    if (chunk === null) { ticket.eof = true; return; }
    if (!Buffer.isBuffer(chunk) || stream.bytesRead !== ticket.size + chunk.length) {
      ticket.state.missing.add('compiler-stream-read-representation'); ticket.failed = true; return;
    }
    if (ticket.size + chunk.length > 8 * 1024 * 1024 ||
        ticket.state.bytes + ticket.size + chunk.length > 64 * 1024 * 1024) {
      ticket.state.missing.add('compiler-read-budget-or-type'); ticket.failed = true; return;
    }
    ticket.hash.update(chunk); ticket.size += chunk.length;
  });
}
function finishStream(ticket, stream, event, error) {
  if (ticket.done) return;
  ticket.done = true; ticket.state.pending.delete(ticket);
  if (ticket.state.closed) return;
  context.run(ticket.state, () => {
    if (error) { readFailure(ticket.file, error); return; }
    if (event !== 'end' || !ticket.eof) { ticket.state.missing.add('compiler-stream-incomplete'); return; }
    if (ticket.failed) return;
    streamIdentity(ticket, stream);
    if (ticket.failed) return;
    observedRead(ticket.identity.canonical, undefined, ticket.method,
      { size: ticket.size, sha256: ticket.hash.digest('hex') });
  });
}
function registerStream(stream, ticket, method) {
  if (!ticket) return stream;
  if (!ticket.file || !permitted(ticket.file)) { ticket.state.pending.delete(ticket); return stream; }
  try {
    const methods = Object.fromEntries(['_read', 'push', 'emit', '_destroy'].map(name => {
      const descriptor = dataProperty(stream, name), own = Object.getOwnPropertyDescriptor(stream, name);
      if (typeof descriptor.value !== 'function' || own && !own.configurable || !Object.isExtensible(stream)) {
        throw new Error('Stream is not observable');
      }
      return [name, descriptor.value];
    }));
    Object.assign(ticket, { method, hash: crypto.createHash('sha256'), size: 0, eof: false, failed: false, done: false });
    // Observe the existing queue and dispatch; never attach a data/readable consumer.
    Object.defineProperties(stream, {
      _read: { configurable: true, writable: true, value: function(...args) {
        if (!ticket.done && !ticket.state.closed) context.run(ticket.state, () => {
          ticket.readStarted = true; streamIdentity(ticket, this);
        });
        return Reflect.apply(methods._read, this, args);
      } },
      push: { configurable: true, writable: true, value: function(chunk, ...args) {
        streamChunk(ticket, this, chunk);
        return Reflect.apply(methods.push, this, [chunk, ...args]);
      } },
      emit: { configurable: true, writable: true, value: function(event, ...args) {
        if (['end', 'error', 'close'].includes(event)) finishStream(ticket, this, event, event === 'error' ? args[0] : undefined);
        return Reflect.apply(methods.emit, this, [event, ...args]);
      } },
      _destroy: { configurable: true, writable: true, value: function(error, ...args) {
        finishStream(ticket, this, 'destroy', error);
        return Reflect.apply(methods._destroy, this, [error, ...args]);
      } },
    });
  } catch {
    ticket.state.pending.delete(ticket); ticket.state.missing.add('compiler-stream-origin-unavailable');
  }
  return stream;
}
function streamRead(original, receiver, args, file, method, handle) {
  const state = current();
  if (!state) return Reflect.apply(original, receiver, args);
  let resolved = file;
  try {
    if (resolved instanceof URL) resolved = fileURLToPath(resolved);
    if (typeof resolved === 'string') resolved = path.resolve(resolved);
  } catch { resolved = null; }
  let stream;
  try { stream = Reflect.apply(original, receiver, args); }
  catch (error) {
    context.run(state, () => finishRead(beginRead(resolved), error, undefined, method)); throw error;
  }
  try {
    const options = method === 'fs.createReadStream' ? args[1] : args[0];
    const io = options && typeof options === 'object' ? dataProperty(options, 'fs').value : undefined;
    const fd = options && typeof options === 'object' ? dataProperty(options, 'fd').value : undefined;
    if (io || fd != null && (!handles.has(fd) || handle && fd !== handle)) throw new Error('Unknown stream origin');
    if (fd != null) resolved = handles.get(fd).file;
    if (handle && !handles.has(handle)) throw new Error('Unknown handle origin');
  } catch {
    if (!state.closed) state.missing.add('compiler-stream-origin-unavailable');
    return stream;
  }
  return context.run(state, () => registerStream(stream, beginRead(resolved), method));
}
fs.createReadStream = function(file, ...args) {
  return streamRead(createStream, this, [file, ...args], file, 'fs.createReadStream');
};
function registerHandle(handle, file) {
  if (!file || !permitted(file)) return handle;
  handles.set(handle, { file });
  try {
    let owner = handle, descriptor;
    for (let depth = 0; owner && depth < 10; depth++, owner = Object.getPrototypeOf(owner)) {
      descriptor = Object.getOwnPropertyDescriptor(owner, 'readFile');
      if (descriptor) break;
    }
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('Handle method unavailable');
    const original = descriptor.value;
    Object.defineProperty(handle, 'readFile', { configurable: true, writable: true,
      enumerable: descriptor.enumerable, value: function(...args) { return handleRead(original, this, args, 'FileHandle.readFile'); } });
  } catch { current()?.missing.add('compiler-filehandle-uninstrumentable'); }
  try {
    const descriptor = dataProperty(handle, 'createReadStream'), original = descriptor.value;
    if (typeof original !== 'function') throw new Error('Handle stream unavailable');
    Object.defineProperty(handle, 'createReadStream', { configurable: true, writable: true,
      enumerable: descriptor.enumerable, value: function(...args) {
        return streamRead(original, this, args, handles.get(this)?.file, 'FileHandle.createReadStream', this);
      } });
  } catch { current()?.missing.add('compiler-stream-origin-unavailable'); }
  return handle;
}
promises.open = function(file, ...args) {
  const resolved = readPath(file), ticket = beginRead(file);
  try {
    return Reflect.apply(openPromise, this, [file, ...args]).then(handle => {
      if (ticket) ticket.state.pending.delete(ticket);
      return registerHandle(handle, resolved);
    }, error => { finishRead(ticket, error, undefined, 'fs.promises.open'); throw error; });
  } catch (error) { finishRead(ticket, error, undefined, 'fs.promises.open'); throw error; }
};
fs.readFile = function(file, ...args) {
  const callback = args.at(-1);
  if (typeof callback !== 'function') return Reflect.apply(readAsync, this, [file, ...args]);
  const ticket = beginRead(file);
  if (!ticket) return Reflect.apply(readAsync, this, [file, ...args]);
  args[args.length - 1] = function(...values) {
    finishRead(ticket, values[0], values[1], 'fs.readFile');
    return Reflect.apply(callback, this, values);
  };
  try { return Reflect.apply(readAsync, this, [file, ...args]); }
  catch (error) { finishRead(ticket, error, undefined, 'fs.readFile'); throw error; }
};
promises.readFile = function(file, ...args) {
  if (file && typeof file === 'object' && !(file instanceof URL) && !Buffer.isBuffer(file)) {
    const receiver = this;
    return handleRead(function(...options) { return Reflect.apply(readPromise, receiver, [file, ...options]); },
      file, args, 'fs.promises.readFile');
  }
  const ticket = beginRead(file);
  if (!ticket) return Reflect.apply(readPromise, this, [file, ...args]);
  try {
    return Reflect.apply(readPromise, this, [file, ...args]).then(value => {
      finishRead(ticket, null, value, 'fs.promises.readFile'); return value;
    }, error => { finishRead(ticket, error, undefined, 'fs.promises.readFile'); throw error; });
  } catch (error) { finishRead(ticket, error, undefined, 'fs.promises.readFile'); throw error; }
};
function observedText(file, method, value, reads) {
  const active = current();
  if (!active || !limit()) return;
  let allowed = permitted(file);
  if (!allowed) return;
  try {
    let canonical = file;
    try { canonical = real(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    allowed = permitted(canonical);
    if (!allowed) { active.missing.add('unsafe-compiler-input'); return; }
    let text = value;
    if (method === 'getScriptSnapshot') {
      const length = value.getLength();
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error('Snapshot budget');
      text = value.getText(0, length);
      if (typeof text !== 'string' || text.length !== length) throw new Error('Snapshot length');
    }
    if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw new Error('Host text budget');
    const size = Buffer.byteLength(text);
    if (size > 8 * 1024 * 1024 || active.bytes + size > 64 * 1024 * 1024) throw new Error('Host text budget');
    active.bytes += size;
    const readObserved = reads.has(allowed.scope + ':' + canonical);
    const filesystem = ['readFileSync', 'fs.readFile', 'fs.promises.readFile', 'FileHandle.readFile'].includes(method);
    const binding = filesystem ? 'decoded-filesystem-text' : 'host-text-only';
    active.textReads.push({ ...allowed, method, textSha256: digest(text), utf8Size: size,
      binding, readObserved });
    if (filesystem) active.cacheReads.set(canonical,
      { ...allowed, sha256: digest(text), binding: 'decoded-filesystem-text' });
    if (filesystem) active.cacheReadOrders.set(canonical, active.records);
    if (!readObserved) active.missing.add(filesystem ?
      'decoded-filesystem-read-without-raw-bytes' : 'host-text-without-observed-read');
  } catch { active.missing.add('compiler-host-text-unreadable'); }
}
function hostMethods(host, identity) {
  if (!host) return host;
  let methods = hosts.get(host);
  if (!methods) { methods = new Map(); hosts.set(host, methods); }
  for (const name of ['readFile', 'getScriptSnapshot', 'resolveModuleNames', 'resolveModuleNameLiterals', 'fileExists']) {
    const original = host[name];
    if (typeof original !== 'function' || methods.get(name) === original) continue;
    const replacement = function(...args) {
      const active = current();
      let result; const reads = new Set();
      hostDepth++; hostReads.push(reads);
      try {
        result = Reflect.apply(original, this, args);
        if ((name === 'readFile' || name === 'getScriptSnapshot') && result !== undefined) observedText(args[0], name, result, reads);
      } finally { hostDepth--; hostReads.pop(); }
      if (!active) return result;
      if (name === 'fileExists' && limit()) {
        const allowed = permitted(args[0]);
        if (allowed) active.probes.set(allowed.scope + ':' + args[0], { ...allowed, exists: Boolean(result) });
      }
      if (name.startsWith('resolveModule') && Array.isArray(result)) {
        result.forEach((value, index) => {
          if (!limit()) return;
          const containing = permitted(args[1]), resolved = permitted(value?.resolvedModule?.resolvedFileName || value?.resolvedFileName);
          if (containing && resolved) active.resolutions.push({ containingFile: containing.path, containingScope: containing.scope,
            resolvedFile: resolved.path, resolvedScope: resolved.scope });
          else if (containing && !value) active.missing.add('unresolved-compiler-module');
        });
      }
      return result;
    };
    host[name] = replacement;
    methods.set(name, replacement);
  }
  const active = current();
  if (active) active.hosts.push(identity);
  return host;
}
function patchFrontend(api, file) {
  if (!api) return api;
  if (frontends.has(api)) return frontends.get(api);
  const methods = new Map();
  for (const [name, kind] of [['createLanguageService', 'language-service'], ['createWatchCompilerHost', 'watch-compiler'],
      ['createWatchProgram', 'watch-program'], ['createCompilerHost', 'compiler'], ['createProgram', 'program']]) {
    const original = api[name], descriptor = Object.getOwnPropertyDescriptor(api, name);
    if (typeof original !== 'function') continue;
    if (descriptor && 'value' in descriptor && !descriptor.writable && !descriptor.configurable) {
      const active = current();
      if (active) active.missing.add('compiler-host-uninstrumentable'); continue;
    }
    const replacement = function(...args) {
      if (name === 'createLanguageService' || name === 'createWatchProgram') hostMethods(args[0], { kind, path: file });
      if (name === 'createProgram') {
        const host = Array.isArray(args[0]) ? args[2] : args[0]?.host;
        if (host) hostMethods(host, { kind, path: file });
      }
      const value = Reflect.apply(original, this, args);
      if (name === 'createWatchCompilerHost' || name === 'createCompilerHost') hostMethods(value, { kind, path: file });
      return value;
    };
    methods.set(name, replacement);
  }
  // SDK wildcard imports copy getters; a get-only Proxy would lose observation.
  const facade = Object.create(Object.getPrototypeOf(api));
  for (const key of Reflect.ownKeys(api)) {
    const descriptor = Object.getOwnPropertyDescriptor(api, key);
    Object.defineProperty(facade, key, { enumerable: descriptor.enumerable, configurable: descriptor.configurable,
      get: () => methods.has(key) ? methods.get(key) : Reflect.get(api, key),
      ...(descriptor.set || descriptor.writable ? { set: value => Reflect.set(api, key, value) } : {}) });
  }
  const proxy = facade;
  frontends.set(api, proxy);
  return proxy;
}
function configuration(config) {
  const result = {};
  if (!config || typeof config !== 'object') return result;
  for (const key of ${JSON.stringify(compilerConfigurationFields)}) {
    const descriptor = Object.getOwnPropertyDescriptor(config, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const value = descriptor.value;
    if (typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) ||
        typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}
function configurationStage(stage, config) {
  const active = current();
  if (!active || !limit()) return;
  try {
    const values = configuration(config), size = Buffer.byteLength(JSON.stringify(values));
    if (active.configurationStages.length >= 64 || active.configurationBytes + size > 256 * 1024 ||
        active.bytes + size > 64 * 1024 * 1024) {
      active.missing.add('compiler-configuration-budget'); return;
    }
    for (const value of Object.values(values)) {
      if (typeof value === 'string' && value.split(/[\\/]/).some(part => privateName.test(part))) {
        active.missing.add('sensitive-compiler-configuration'); return;
      }
    }
    active.configurationBytes += size; active.bytes += size;
    active.configurationStages.push({ stage, values });
  } catch { active.missing.add('compiler-configuration-unreadable'); }
}
const configurationWrappers = new WeakMap();
let blockedConfigurationHooks = false;
function patchConfiguration(api, name, before, after, returned = false) {
  if (!api || typeof api[name] !== 'function') return;
  let methods = configurationWrappers.get(api);
  if (!methods) { methods = new Map(); configurationWrappers.set(api, methods); }
  if (methods.get(name) === api[name]) return;
  const original = api[name];
  const replacement = function(...args) {
    if (before) configurationStage(before, args[0]);
    const value = Reflect.apply(original, this, args);
    if (after) configurationStage(after, returned ? value : args[0]);
    return value;
  };
  try {
    api[name] = replacement;
    if (api[name] !== replacement) throw new Error('Configuration export is not writable');
    methods.set(name, replacement);
  } catch {
    blockedConfigurationHooks = true;
    current()?.missing.add('compiler-configuration-uninstrumentable');
  }
}
${compilerNativeInputSource}
${compilerNativeDescriptionSource}
${compilerNativeObserverSource}
function persist(state, phase) {
  const data = { version: 1, phase, pid: process.pid, configuration: state.configuration,
    configurationStages: state.configurationStages,
    cacheEvents: state.cacheEvents,
    nativeCalls: state.nativeCalls, nativeDescriptions: state.nativeDescriptions, nativeInputWrites: state.nativeInputWrites,
    ...(state.watch ? { watch: state.watch } : {}),
    files: [...state.files.values()], probes: [...state.probes.values()], resolutions: state.resolutions,
    textReads: state.textReads,
    hosts: state.hosts, drift: [...state.drift], missing: [...state.missing] };
  const text = JSON.stringify(data) + '\n';
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Compiler observation exceeds budget');
  const fd = open(state.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try { write(fd, text); } finally { close(fd); }
}
let stateCount = 0, lastState, observationBudgetClosed = false, blockedWatchHooks = false;
function newState(config, watch) {
  if (stateCount >= 64) {
    if (!observationBudgetClosed) {
      observationBudgetClosed = true;
      lastState.missing.add('compiler-observation-file-budget'); persist(lastState, 'unfinished');
    }
    return undefined;
  }
  stateCount++;
  const file = path.join(out, crypto.randomUUID() + '.jsonl');
  const fd = open(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); close(fd);
  const state = { file, configuration: configuration(config), files: new Map(), probes: new Map(), textReads: [],
    configurationStages: [], configurationBytes: 0, resolutions: [], hosts: [], drift: new Set(), missing: new Set(),
    cacheEvents: [], cacheReads: new Map(), cacheIds: new WeakMap(), pendingCaches: new Set(),
    nativeCalls: [], nativeBytes: 0, pendingNative: new Set(),
    nativeDescriptions: [], descriptionDestinations: new Map(),
    descriptionBytes: 0, descriptionInputBytes: 0, descriptionRecords: 0, nativeOrder: 0,
    nativeInputWrites: [], inputBytes: 0, inputMetadataBytes: 0, inputReferenceBytes: 0,
    pendingInputs: new Set(), latestInputs: new Map(), inputAttempts: new Map(),
    inputDestinations: new Map(), inputAttemptRecords: 0,
    cacheReadOrders: new Map(), cacheBuffers: new WeakMap(), cacheSources: new WeakMap(),
    bytes: 0, records: 0, pending: new Set(), closed: false, watch };
  if (blockedConfigurationHooks) state.missing.add('compiler-configuration-uninstrumentable');
  if (blockedWatchHooks) state.missing.add('watch-uninstrumentable');
  if (blockedCacheHooks) state.missing.add('compiler-cache-uninstrumentable');
  if (blockedNativeHooks) state.missing.add('native-compiler-call-uninstrumentable');
  if (blockedDescriptionHooks) state.missing.add('native-description-uninstrumentable');
  if (blockedInputHooks) state.missing.add('native-input-uninstrumentable');
  lastState = state;
  jobs.add(state); persist(state, 'started');
  return state;
}
function endState(state) {
  if (state.pending.size) state.missing.add('pending-compiler-reads-at-close');
  if (state.pendingCaches.size) state.missing.add('pending-compiler-cache-at-close');
  if (state.pendingNative.size) state.missing.add('pending-native-compiler-at-close');
  if (state.pendingInputs.size) state.missing.add('pending-native-inputs-at-close');
  if (state.nativeCalls.some(call => call.dispatch !== 'returned')) state.missing.add('native-compiler-dispatch-unavailable');
  state.closed = true; jobs.delete(state); persist(state, 'closed');
}
function endWatchState(state) {
  try { endState(state); }
  catch { state.closed = true; jobs.delete(state); }
}
const watchTasks = new WeakMap(), watchEmitters = new WeakSet(), watchApis = new WeakSet();
const dataValue = (object, key) => {
  const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
let blockedCacheHooks = false;
const cacheWrappers = new WeakMap();
function cacheId(state, object) {
  if (!object || typeof object !== 'object') return null;
  if (!state.cacheIds.has(object)) state.cacheIds.set(object, crypto.randomUUID());
  return state.cacheIds.get(object);
}
function cacheModules(state, cache, module) {
  const result = [], modules = module ? [module] : dataValue(cache, 'modules');
  if (!Array.isArray(modules)) return result;
  const length = dataValue(modules, 'length');
  for (let index = 0; index < length; index++) {
    if (!limit()) break;
    const id = cacheId(state, dataValue(modules, String(index)));
    if (id) result.push(id);
    else state.missing.add('compiler-cache-module-unavailable');
  }
  return result;
}
function cacheEvent(operation, cache, file, store, module, minimumRead = 0) {
  const state = current();
  if (!state || !limit()) return;
  const allowed = file === undefined ? undefined : permitted(file);
  if (file !== undefined && !allowed) { state.missing.add('unsafe-compiler-cache-path'); return; }
  let read = allowed && state.cacheReadOrders.get(file) > minimumRead && state.cacheReads.get(file);
  if (operation === 'file-module-load') {
    read = module && state.cacheSources.get(module);
    if (!read || read.path !== file) { read = undefined; state.missing.add('compiler-cache-decoder-unverified'); }
  }
  const event = { sequence: state.cacheEvents.length + 1, operation, cacheId: cacheId(state, cache),
    modules: cacheModules(state, cache, module), reads: read && ['store-load', 'file-module-load'].includes(operation) ? [read] : [],
    ...(allowed ? { path: allowed } : {}), ...(store ? { storeId: cacheId(state, store) } : {}) };
  const size = Buffer.byteLength(JSON.stringify(event));
  if (state.bytes + size > 64 * 1024 * 1024) { state.missing.add('compiler-observation-budget'); return; }
  state.bytes += size; state.cacheEvents.push(event);
}
function observeCache(callback) {
  try { callback(); } catch { current()?.missing.add('compiler-cache-unreadable'); }
}
function patchCacheMethod(api, name, before, after) {
  const original = dataValue(api, name);
  if (typeof original !== 'function') return;
  let methods = cacheWrappers.get(api);
  if (!methods) { methods = new Map(); cacheWrappers.set(api, methods); }
  if (methods.get(name) === original) return;
  const replacement = function(...args) {
    const state = current();
    if (!state) return Reflect.apply(original, this, args);
    const start = state.cacheEvents.length, readStart = state.records;
    observeCache(() => before?.call(this, args));
    const finish = (error, value) => {
      if (state.closed) return;
      context.run(state, () => {
        if (error) state.missing.add('compiler-cache-call-failed');
        else observeCache(() => after?.call(this, args, value, start, readStart));
      });
    };
    try {
      const value = Reflect.apply(original, this, args);
      if (value instanceof Promise) {
        const ticket = {};
        state.pendingCaches.add(ticket);
        value.then(result => { state.pendingCaches.delete(ticket); finish(false, result); },
          () => { state.pendingCaches.delete(ticket); finish(true); });
      } else finish(false, value);
      return value;
    } catch (error) { finish(true); throw error; }
  };
  try {
    api[name] = replacement;
    if (api[name] !== replacement) throw new Error('Cache method is not writable');
    methods.set(name, replacement);
  } catch { blockedCacheHooks = true; current()?.missing.add('compiler-cache-uninstrumentable'); }
}
function patchCacheStore(api) {
  const prototype = api?.CacheStore?.prototype;
  patchCacheMethod(prototype, 'getCache', undefined, function(args, value) {
    cacheEvent('store-get', value, path.isAbsolute(args[0] || '') ? args[0] : undefined, this);
  });
  patchCacheMethod(prototype, 'setCache', undefined, function(args) {
    cacheEvent('store-set', args[1], path.isAbsolute(args[0] || '') ? args[0] : undefined, this);
  });
  for (const [name, operation] of [['loadFromFile', 'store-load'], ['persistToFile', 'store-persist']]) {
    patchCacheMethod(prototype, name, undefined, function(args, value, start, readStart) {
      cacheEvent(operation, null, args[0], this, undefined, readStart);
    });
  }
}
function patchCache(api, kind) {
  if (kind === 'store') return patchCacheStore(api);
  if (kind === 'decoder') {
    patchCacheMethod(api?.Unpackr?.prototype, 'unpack', undefined, function(args, value) {
      const state = current(), read = state.cacheBuffers.get(args[0]);
      if (!read || !value || typeof value !== 'object' || !limit()) return;
      if (digest(args[0]) !== read.sha256) { state.missing.add('compiler-cache-buffer-drift'); return; }
      state.cacheSources.set(value, read);
    });
    return;
  }
  if (kind === 'modules') {
    patchCacheMethod(api?.ModulesCacheHandler?.prototype, 'handlerReadResult', undefined, function(args) {
      cacheEvent('file-module-load', args[0], args[2], undefined, args[1]);
    });
  } else if (kind === 'memory') {
    patchCacheMethod(api?.MemoryCacheHandler?.prototype, 'readCache', undefined, function(args, value, start) {
      const state = current(), cache = dataValue(args[0], 'cache'), id = cacheId(state, cache);
      if (id && state.cacheEvents.slice(start).some(event => event.operation === 'store-get' && event.cacheId === id))
        cacheEvent('memory-load', cache);
    });
  } else {
    for (const name of ['rollup', 'rollupInternal']) {
      patchCacheMethod(api, name, args => cacheEvent('rollup-input', dataValue(args[0], 'cache')),
        (args, value) => cacheEvent('rollup-output', dataValue(value, 'cache')));
    }
  }
}
function watchPaths(state, values) {
  const result = [];
  if (!(values instanceof Map) && !(values instanceof Set)) {
    if (values !== undefined) state.missing.add('watch-input-unavailable');
    return result;
  }
  for (const file of values.keys()) {
    if (!limit() || result.length >= 10000) { state.missing.add('compiler-observation-budget'); break; }
    const allowed = permitted(file);
    if (!allowed) { state.missing.add('unsafe-watch-input'); continue; }
    const size = Buffer.byteLength(file);
    if (state.bytes + size > 64 * 1024 * 1024) { state.missing.add('compiler-observation-budget'); break; }
    state.bytes += size; result.push(file);
  }
  return result;
}
function patchWatchEmitter(emitter) {
  if (!emitter || watchEmitters.has(emitter) || typeof emitter.emit !== 'function') return;
  const original = emitter.emit;
  const replacement = function(event, value, ...args) {
    const active = current();
    if (event === 'event' && active?.watch) {
      try {
        const code = dataValue(value, 'code');
        if (['BUNDLE_START', 'BUNDLE_END', 'ERROR', 'STOP_HOT_COMPILE'].includes(code)) {
          if (!limit() || active.watch.events.length >= 8) active.missing.add('watch-event-budget');
          else active.watch.events.push(code);
          if (code === 'BUNDLE_START') active.watch.changedFiles = watchPaths(active, dataValue(value, 'lastChangedFiles'));
          if (code === 'BUNDLE_END') active.watch.reusedFiles = watchPaths(active, dataValue(value, 'lastReUsedFiles'));
        }
      } catch { active.missing.add('watch-event-unreadable'); }
    }
    return Reflect.apply(original, this, [event, value, ...args]);
  };
  watchEmitters.add(emitter);
  try {
    emitter.emit = replacement;
    if (emitter.emit !== replacement) throw new Error('Watch emitter is not writable');
  } catch {
    blockedWatchHooks = true; current()?.missing.add('watch-uninstrumentable');
  }
}
function patchWatchTask(api) {
  const prototype = api?.Task?.prototype;
  if (!prototype || watchApis.has(prototype)) return;
  watchApis.add(prototype);
  for (const operation of ['run', 'hotCompile', 'close']) {
    const original = prototype[operation];
    if (typeof original !== 'function') continue;
    const replacement = function(...args) {
      let session = watchTasks.get(this);
      if (!session) {
        const owner = context.getStore();
        if (!owner) return Reflect.apply(original, this, args);
        session = { id: crypto.randomUUID(), configuration: owner.configuration, round: 0, active: undefined, closed: false };
        watchTasks.set(this, session);
        patchWatchEmitter(this.watcher?.emitter);
      }
      if (session.active && current() === session.active && operation !== 'close') return Reflect.apply(original, this, args);
      if (session.closed || operation !== 'close' && dataValue(this, 'closed') === true) return Reflect.apply(original, this, args);
      if (session.active && operation !== 'close') {
        session.active.missing.add('watch-round-overlap'); return Reflect.apply(original, this, args);
      }
      const watch = { sessionId: session.id, round: ++session.round, operation, events: [], changedFiles: [], reusedFiles: [], taskClosed: false };
      const state = newState(session.configuration, watch);
      if (!state) return Reflect.apply(original, this, args);
      if (operation === 'close') {
        session.closed = true;
        if (session.active) {
          session.active.watch.taskClosed = true;
          if (session.active.pending.size) session.active.missing.add('pending-compiler-reads-at-close');
          if (session.active.pendingCaches.size) session.active.missing.add('pending-compiler-cache-at-close');
          session.active.closed = true;
        }
        try { return context.run(state, () => Reflect.apply(original, this, args)); }
        catch (error) { state.missing.add('watch-close-failed'); throw error; }
        finally {
          watch.taskClosed = dataValue(this, 'closed') === true;
          if (!watch.taskClosed) state.missing.add('watch-close-incomplete');
          endWatchState(state);
        }
      }
      session.active = state;
      const finish = () => {
        watch.taskClosed = session.closed || dataValue(this, 'closed') === true;
        endWatchState(state); session.active = undefined;
      };
      try {
        const result = context.run(state, () => Reflect.apply(original, this, args));
        // Attach observation before returning the original Promise to the SDK.
        if (result instanceof Promise) result.then(finish, finish);
        else finish();
        return result;
      } catch (error) { finish(); throw error; }
    };
    try {
      prototype[operation] = replacement;
      if (prototype[operation] !== replacement) throw new Error('Watch method is not writable');
    } catch {
      blockedWatchHooks = true; current()?.missing.add('watch-uninstrumentable');
    }
  }
}
function patchWatch(api) {
  if (!api || watchApis.has(api) || typeof api.watch !== 'function') return;
  watchApis.add(api);
  const original = api.watch;
  const replacement = function(config, ...args) {
    if (current()) return Reflect.apply(original, this, [config, ...args]);
    const state = newState(config);
    if (!state) return Reflect.apply(original, this, [config, ...args]);
    try {
      const result = context.run(state, () => Reflect.apply(original, this, [config, ...args]));
      if (result instanceof Promise) result.then(() => endWatchState(state), () => endWatchState(state));
      else endWatchState(state);
      return result;
    } catch (error) { endWatchState(state); throw error; }
  };
  try {
    api.watch = replacement;
    if (api.watch !== replacement) throw new Error('Watch export is not writable');
  } catch {
    blockedWatchHooks = true; current()?.missing.add('watch-uninstrumentable');
  }
}
function patchJob(api) {
  if (!api || wrapped.has(api) || typeof api.run !== 'function') return;
  wrapped.add(api);
  const original = api.run;
  api.run = async function(config, ...args) {
    if (current()) return Reflect.apply(original, this, [config, ...args]);
    const state = newState(config);
    if (!state) return Reflect.apply(original, this, [config, ...args]);
    return context.run(state, async () => {
      try { return await Reflect.apply(original, this, [config, ...args]); }
      finally { endState(state); }
    });
  };
}
const load = Module._load;
Module._load = function(request, parent, ...args) {
  const value = Reflect.apply(load, this, [request, parent, ...args]);
  let file;
  try { file = Module._resolveFilename(request, parent); } catch { return value; }
  if (typeof file === 'string' && file.endsWith(path.join('ets-loader', 'node_modules', 'typescript', 'lib', 'typescript.js'))) return patchFrontend(value, file);
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-ohos-plugin', 'src', 'tasks', 'worker', 'job.js'))) patchJob(value);
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-compose', 'dist', 'src', 'arkts-pack.js'))) patchWatch(value);
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-base', 'node_modules', 'rollup-lite', 'dist', 'shared', 'watch.js'))) patchWatchTask(value);
  if (typeof file === 'string' && file.endsWith(path.join('hvigor', 'src', 'base', 'internal', 'pool', 'store', 'cache-store.js'))) patchCache(value, 'store');
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-base', 'dist', 'src', 'util', 'msgpack', 'unpack.js'))) patchCache(value, 'decoder');
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-base', 'dist', 'src', 'cache', 'rollup', 'handle', 'modules-cache-handler.js'))) patchCache(value, 'modules');
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-base', 'dist', 'src', 'cache', 'rollup', 'handle', 'memory-cache-handler.js'))) patchCache(value, 'memory');
  if (typeof file === 'string' && ['rollup', 'rollup-lite'].some(name =>
      file.endsWith(path.join('node_modules', name, 'dist', 'shared', 'rollup.js')))) patchCache(value, 'rollup');
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-compose', 'dist', 'src', 'util', 'load-sdk-functions.js'))) {
    patchConfiguration(value, 'loadSdkFunctions', 'sdk-loader-input', 'sdk-loader-output');
  }
  if (typeof file === 'string' && file.endsWith(path.join('hvigor-arkts-base', 'dist', 'src', 'hvigor-compile.js'))) {
    patchConfiguration(value, 'runHvigorCompile', 'rollup-input');
  }
  if (typeof file === 'string' && file.endsWith(path.join('ets-loader', 'lib', 'fast_build', 'ark_compiler', 'common', 'process_ark_config.js'))) {
    patchConfiguration(value, 'initArkConfig', undefined, 'ark-config', true);
    patchConfiguration(value, 'initArkProjectConfig', undefined, 'ark-project', true);
  }
  if (typeof file === 'string' && file.endsWith(path.join('ets-loader', 'lib', 'fast_build', 'ark_compiler', 'utils.js'))) {
    patchNativeInput(value, 'writeFileContentToTempDir');
  }
  if (typeof file === 'string' && file.endsWith(path.join('ets-loader', 'lib', 'process_module_files.js'))) {
    patchNativeInput(value, 'writeFileSyncByNode');
  }
  if (typeof file === 'string' && file.endsWith(path.join('ets-loader', 'lib', 'fast_build', 'ark_compiler', 'module', 'module_mode.js'))) {
    patchNativeDescriptions(value);
    patchNativeCompiler(value);
  }
  return value;
};
process.on('exit', () => { for (const state of jobs) persist(state, 'unfinished'); });
`;
