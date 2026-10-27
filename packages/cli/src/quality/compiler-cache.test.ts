/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compilerObserverSource } from './compiler-observer-source.js';
import { collectCompilerObservations } from './compiler-observations.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-compiler-cache-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode = 'file') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), observations = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const base = join(root, 'hvigor-arkts-base/dist/src/cache/rollup');
  const modules = join(base, 'handle/modules-cache-handler.js');
  const memory = join(base, 'handle/memory-cache-handler.js');
  const store = join(root, 'hvigor/src/base/internal/pool/store/cache-store.js');
  const rollup = join(root, 'node_modules/rollup-lite/dist/shared/rollup.js');
  const unpack = join(root, 'hvigor-arkts-base/dist/src/util/msgpack/unpack.js');
  const cacheFile = join(project, '.cache/module.msgpack');
  for (const folder of [sdk, observations, dirname(job), dirname(modules), dirname(store), dirname(rollup), dirname(unpack), dirname(cacheFile)]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(cacheFile, '{"id":"Module.ets","code":"PRIVATE_CACHE_BODY_SENTINEL"}');
  await writeFile(unpack, 'exports.Unpackr=class { unpack(bytes) { return JSON.parse(bytes.toString()); } };');
  await writeFile(modules, `
    exports.ModulesCacheHandler = class {
      handlerReadResult(cache, module) { cache.modules.push(module); return module; }
    };
    if (${JSON.stringify(mode)} === 'locked') Object.freeze(exports.ModulesCacheHandler.prototype);
  `);
  await writeFile(store, `
    exports.CacheStore = class {
      constructor() { this.caches = new Map(); }
      getCache(key) { return this.caches.get(key); }
      setCache(key, value) { this.caches.set(key,value); return this; }
      loadFromFile(file) {
        if (${JSON.stringify(mode)} === 'stale-read') return;
        const body = require('node:fs').readFileSync(file, ${mode === 'decoded' ? "'utf8'" : 'undefined'});
        this.setCache(file, { modules: [JSON.parse(body.toString())] });
      }
      persistToFile(file) { return file; }
    };
  `);
  await writeFile(memory, `
    exports.MemoryCacheHandler = class {
      constructor(store) { this.store = store; }
      readCache(config) { const cache = this.store.getCache(${JSON.stringify(cacheFile)}); if(cache) config.cache=cache; }
    };
  `);
  await writeFile(rollup, `
    exports.rollupInternal = function(config) {
      const cache=config.cache;
      if (${JSON.stringify(mode)} === 'throw') throw globalThis.officialFailure;
      if (${JSON.stringify(mode)} === 'late') return new Promise(done => { globalThis.finish = () => done({ cache }); });
      globalThis.originalPromise=Promise.resolve({cache});
      return globalThis.originalPromise;
    };
  `);
  await writeFile(job, `
    const assert=require('node:assert/strict'), fs=require('node:fs'),
      modules=require(${JSON.stringify(modules)}), memory=require(${JSON.stringify(memory)}),
      store=require(${JSON.stringify(store)}), rollup=require(${JSON.stringify(rollup)}),
      unpack=require(${JSON.stringify(unpack)});
    exports.run=async config => {
      config.cache={modules:[]};
      if (['memory','decoded','stale-read'].includes(${JSON.stringify(mode)})) {
        if (${JSON.stringify(mode)} === 'stale-read') fs.readFileSync(${JSON.stringify(cacheFile)});
        const value=new store.CacheStore(); value.loadFromFile(${JSON.stringify(cacheFile)});
        new memory.MemoryCacheHandler(value).readCache(config);
        value.persistToFile(${JSON.stringify(cacheFile)});
      } else if (${JSON.stringify(mode)} !== 'unknown') {
        const body=fs.readFileSync(${JSON.stringify(cacheFile)});
        if (${JSON.stringify(mode)} === 'buffer-drift') body.fill(32,body.indexOf('PRIVATE'),body.indexOf('PRIVATE')+7);
        const module=${JSON.stringify(mode)} === 'without-decoder' ? JSON.parse(body.toString()) : new unpack.Unpackr().unpack(body);
        const result=new modules.ModulesCacheHandler().handlerReadResult(config.cache,module,${JSON.stringify(cacheFile)});
        assert.equal(result,module);
      }
      Object.defineProperty(config.cache,'plugins',{get(){throw new Error('observer must not evaluate cache getters')}});
      if (${JSON.stringify(mode)} === 'throw') {
        globalThis.officialFailure=new Error('official cache failure');
        assert.throws(()=>rollup.rollupInternal(config),error=>error===globalThis.officialFailure);return;
      }
      const result=rollup.rollupInternal(config);
      if (${JSON.stringify(mode)} === 'late') return;
      assert.equal(result,globalThis.originalPromise);
      const output=await result; assert.equal(output.cache,config.cache);
      config.cache.modules[0] && (config.cache.modules[0].code='changed after consumption');
    };
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const driver = `
    (async()=>{
      const job=require(${JSON.stringify(job)});
      const config=entryModuleName=>({entryModuleName,cachePath:${JSON.stringify(join(project, '.cache'))}});
      if(${JSON.stringify(mode)}==='overlap') await Promise.all([job.run(config('first')),job.run(config('second'))]);
      else await job.run(config('entry'));
      if(globalThis.finish) { globalThis.finish(); await Promise.resolve(); await job.run({entryModuleName:'after'}); }
    })().catch(error=>{console.error(error);process.exitCode=1});
  `;
  const child = spawn(process.execPath, ['--require', join(root, 'observer.cjs'), '-e', driver], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: observations },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
  let exit;
  try {
    exit = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally { clearTimeout(deadline); }
  expect({ exit, stdout, stderr }).toEqual({ exit: { code: 0, signal: null }, stdout: '', stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  const raw = await Promise.all((await readdir(observations)).map(async name =>
    (await readFile(join(observations, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))));
  const result = await collectCompilerObservations(observations, project, sdk);
  expect(result).toHaveProperty('cacheEvents');
  return { result, raw, observations, project, sdk };
}
it('links a decoded file module to the exact Rollup input without recording its body', async () => {
  const { result, raw } = await observe();
  const events = result.cacheEvents;
  expect(events.map(event => event.operation)).toEqual(['file-module-load', 'rollup-input', 'rollup-output']);
  expect(events[0]!.modules).toHaveLength(1);
  expect(events[1]!.modules).toEqual(events[0]!.modules);
  expect(events[0]!.reads).toEqual([expect.objectContaining({ path: '.cache/module.msgpack', binding: 'raw-filesystem-bytes' })]);
  expect(events[0]!.reads[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.missing).not.toContain('compiler-cache-decoder-unverified');
  expect(events.every(event => event.binding === 'observed-reference-only')).toBe(true);
  expect(result.missing).toContain('compiler-cache-closure-unverified');
  expect(JSON.stringify(raw)).not.toContain('PRIVATE_CACHE_BODY_SENTINEL');
  expect(JSON.stringify(raw)).not.toContain('changed after consumption');
});
it('records store loading and the returned memory object separately from file modules', async () => {
  const { result } = await observe('memory');
  const events = result.cacheEvents;
  expect(events.map(event => event.operation)).toEqual([
    'store-set', 'store-load', 'store-get', 'memory-load', 'store-persist', 'rollup-input', 'rollup-output',
  ]);
  expect(events[0]!.cacheId).toEqual(events[2]!.cacheId);
  expect(events[2]!.cacheId).toEqual(events[3]!.cacheId);
  expect(events[3]!.cacheId).toEqual(events[5]!.cacheId);
  expect(events[1]!.reads[0]!.binding).toBe('raw-filesystem-bytes');
  expect(events[1]!.storeId).toEqual(events[2]!.storeId);
});
it('does not promote decoded store text to raw byte provenance', async () => {
  const { result } = await observe('decoded');
  expect(result.cacheEvents.find(event => event.operation === 'store-load')!.reads[0]!.binding).toBe('decoded-filesystem-text');
  expect(result.missing).toContain('decoded-filesystem-read-without-raw-bytes');
});
it('keeps unobserved cache origins incomplete', async () => {
  const { result } = await observe('unknown');
  expect(result.cacheEvents.map(event => event.operation)).toEqual(['rollup-input', 'rollup-output']);
  expect(result.missing).toContain('compiler-cache-input-origin-unverified');
});
it('retains original Rollup errors and omits an output event on failure', async () => {
  const { result } = await observe('throw');
  expect(result.cacheEvents.map(event => event.operation)).toEqual(['file-module-load', 'rollup-input']);
  expect(result.missing).toContain('compiler-cache-call-failed');
});
it('retains execution when cache methods cannot be instrumented', async () => {
  const { result } = await observe('locked');
  expect(result.missing).toContain('compiler-cache-uninstrumentable');
  expect(result.cacheEvents.some(event => event.operation === 'file-module-load')).toBe(false);
});
it('keeps overlapping cache object identities in their initiating job', async () => {
  const { result, raw } = await observe('overlap');
  expect(result.cacheEvents).toHaveLength(6);
  const ids = raw.map(records => records[1].cacheEvents[1].cacheId);
  expect(new Set(ids).size).toBe(2);
  for (const records of raw) {
    expect(records[0].cacheEvents).toEqual([]);
    expect(records[1].cacheEvents[1].modules).toEqual(records[1].cacheEvents[0].modules);
  }
});
it('cuts off pending cache callbacks at job close', async () => {
  const { result } = await observe('late');
  expect(result.cacheEvents.some(event => event.operation === 'rollup-output')).toBe(false);
  expect(result.missing).toContain('pending-compiler-cache-at-close');
});
it('does not bind old file reads to a store load that performs no read', async () => {
  const { result } = await observe('stale-read');
  expect(result.cacheEvents.find(event => event.operation === 'store-load')!.reads).toEqual([]);
});
it.each(['buffer-drift', 'without-decoder'])('leaves %s cache module provenance unavailable', async mode => {
  const { result } = await observe(mode);
  expect(result.cacheEvents.find(event => event.operation === 'file-module-load')!.reads).toEqual([]);
  expect(result.missing).toContain(mode === 'buffer-drift' ? 'compiler-cache-buffer-drift' : 'compiler-cache-decoder-unverified');
});
it.each(['sequence', 'path', 'read-binding', 'start', 'entries'])('rejects forged cache %s', async mode => {
  const { observations, project, sdk } = await observe();
  const name = (await readdir(observations))[0]!;
  const file = join(observations, name);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const event = records[1].cacheEvents[0];
  if (mode === 'sequence') { event.sequence = 2; }
  if (mode === 'path') { event.path.path = join(root, '.npmrc'); }
  if (mode === 'read-binding') { event.reads[0].sha256 = 'a'.repeat(64); }
  if (mode === 'start') { records[0].cacheEvents.push(event); }
  if (mode === 'entries') { event.modules = Array.from({ length: 10000 }, () => event.modules[0]); }
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const result = await collectCompilerObservations(observations, project, sdk);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain({
    sequence: 'compiler-cache-sequence-mismatch', path: 'compiler-observation-unreadable',
    'read-binding': 'compiler-cache-read-binding-unavailable', start: 'compiler-cache-start-mismatch',
    entries: 'compiler-observation-total-budget',
  }[mode]);
});
