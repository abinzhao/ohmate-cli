/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const buildOutputObserverSource = String.raw`
(() => {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const directory = process.env.OHMATE_BUILD_OUTPUT_OBSERVATIONS;
  if (!directory) return;
  const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
  const file = path.join(directory, require('node:crypto').randomUUID() + '.jsonl');
  const paths = new Map(), missing = new Set(), patched = new WeakSet();
  const querying = new WeakSet(), queryMetadata = process.env.OHMATE_QUERY_OUTPUT_METADATA === '1';
  const privateName = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.ohpmrc|local\.properties|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
  const root = process.env.OHMATE_COMPILER_PROJECT;
  let calls = 0, created = false, lastText;
  function permitted(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value !== path.resolve(value) || value.length > 4096) return false;
    const relative = path.relative(root, value);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) &&
      !relative.split(path.sep).some(part => privateName.test(part) || /[\x00-\x1f\x7f]/.test(part));
  }
  function field(object, key) { return Object.getOwnPropertyDescriptor(object, key)?.value; }
  function observe(object, scope, value, kind) {
    try {
      if (++calls > 10000 || paths.size >= 128) { missing.add('build-output-observation-budget'); return; }
      if (!permitted(value)) { missing.add('unsafe-build-output-path'); return; }
      const product = field(object, '_productName');
      if (typeof product !== 'string' || !/^[A-Za-z0-9_-]+$/.test(product)) throw new Error('Product unavailable');
      let item = { scope, product, path: value };
      if (scope !== 'product') {
        const modulePath = field(object, '_modulePath'), target = field(object, '_targetName');
        if (!permitted(modulePath) || typeof target !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Module unavailable');
        item = { ...item, modulePath, target };
        if (scope === 'module-metadata') item.kind = kind;
      }
      paths.set(JSON.stringify(item), item);
    } catch { missing.add('build-output-observation-unreadable'); }
    finally { try { persist(); } catch { missing.add('build-output-observation-unreadable'); } }
  }
  function patch(api, className, method, scope, kind) {
    const prototype = api?.[className]?.prototype;
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (!descriptor && scope === 'module-metadata') return;
    if (typeof descriptor?.value === 'function' && patched.has(descriptor.value)) return;
    if (typeof descriptor?.value !== 'function' || !descriptor.writable) {
      missing.add('build-output-path-uninstrumentable'); return;
    }
    const original = descriptor.value;
    const wrapped = function(...args) {
      const value = Reflect.apply(original, this, args);
      observe(this, scope, value, kind);
      // tasks creates path objects but does not naturally request package metadata.
      if (scope === 'module' && queryMetadata && !querying.has(this)) {
        querying.add(this);
        try {
          for (const name of ['getIntermediatesOutputMetadata', 'getIntermediatesHspOutputMetadata']) {
            const probe = Object.getOwnPropertyDescriptor(prototype, name)?.value;
            if (typeof probe === 'function' && patched.has(probe)) Reflect.apply(probe, this, []);
          }
        } catch { missing.add('build-output-metadata-query-failed'); }
        finally {
          querying.delete(this);
          try { persist(); } catch { missing.add('build-output-observation-unreadable'); }
        }
      }
      return value;
    };
    patched.add(wrapped);
    Object.defineProperty(prototype, method, { ...descriptor, value: wrapped });
  }
  function persist() {
    const started = { version: 1, completion: 'path-method-return', phase: 'started', pid: process.pid, paths: [], missing: [] };
    const closed = { ...started, phase: 'closed', paths: [...paths.values()], missing: [...missing] };
    const text = JSON.stringify(started) + '\n' + JSON.stringify(closed) + '\n';
    if (text === lastText) return;
    const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | (created ? fs.constants.O_TRUNC : fs.constants.O_CREAT | fs.constants.O_EXCL);
    const fd = open(file, flags, 0o600); created = true;
    try { if (write(fd, text) !== Buffer.byteLength(text)) throw new Error('Incomplete output observation'); }
    finally { close(fd); }
    lastText = text;
  }
  const load = Module._load;
  Module._load = function(request, parent, ...args) {
    const value = Reflect.apply(load, this, [request, parent, ...args]);
    let resolved;
    try { resolved = Module._resolveFilename(request, parent); } catch { return value; }
    if (typeof resolved === 'string' && resolved.endsWith(path.join('hvigor-ohos-plugin', 'src', 'common', 'iml', 'module-path-info-iml.js'))) {
      patch(value, 'ModulePathInfoIml', 'getModuleBuildOutputPath', 'module');
      patch(value, 'ModulePathInfoIml', 'getIntermediatesOutputMetadata', 'module-metadata', 'hap');
      patch(value, 'ModulePathInfoIml', 'getIntermediatesHspOutputMetadata', 'module-metadata', 'hsp');
    }
    if (typeof resolved === 'string' && resolved.endsWith(path.join('hvigor-ohos-plugin', 'src', 'common', 'iml', 'project-path-info-iml.js')))
      patch(value, 'ProjectPathInfoIml', 'getProjectOutputPath', 'product');
    return value;
  };
})();
`;
