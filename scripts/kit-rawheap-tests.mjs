/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { build } from 'esbuild';
import JSON5 from 'json5';

export async function registerRawHeapTests({ temporary }) {
  const entry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/dfx/RawHeapHost.ets', import.meta.url));
  const output = path.join(temporary, 'rawheap-host.mjs');
  let sequence = 0;
  if (existsSync(entry)) {
    await build({ entryPoints: [entry], outfile: output, bundle: true,
      platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
      plugins: [{ name: 'explicit-rawheap-platform-substitute', setup(builder) {
        builder.onResolve({ filter: /^@kit\./ }, args => ({ path: args.path, namespace: 'rawheap-platform' }));
        builder.onLoad({ filter: /.*/, namespace: 'rawheap-platform' }, args => ({
          contents: args.path === '@kit.PerformanceAnalysisKit' ?
            'export const hidebug={dumpJsRawHeapData:(...args)=>globalThis.__rawHeapTest.dump(...args)};' :
            args.path === '@kit.ArkTS' ?
            'export const process = new Proxy({}, {get:(_,key)=>globalThis.__rawHeapTest[key]});' :
            args.path === '@kit.AbilityKit' ?
            'export const bundleManager={BundleFlag:{GET_BUNDLE_INFO_WITH_APPLICATION:1},' +
            'getBundleInfoForSelfSync:()=>({appInfo:{debug:globalThis.__rawHeapTest.debug}})};' :
            'export const deviceInfo=new Proxy({}, {get:(_,key)=>globalThis.__rawHeapTest[key]});' +
            'export const systemDateTime={TimeType:{STARTUP:1},getUptime:()=>globalThis.__rawHeapTest.now};',
          loader: 'js',
        }));
      } }],
    });
  }
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  async function fixture(context, overrides = {}) {
    assert(existsSync(entry), 'missing explicit non-main-thread RawHeapHost');
    const { RawHeapHost } = await import(pathToFileURL(output).href + '?fixture=' + ++sequence);
    const keys = ['__rawHeapTest', 'canIUse', 'setInterval', 'clearInterval'];
    const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const calls = [], timers = new Map();
    const env = { now: 1000, pid: 42, tid: 43, sdkApiVersion: 26, deviceType: 'phone', debug: true,
      dump: async (...args) => { calls.push(['dump', ...args]); return ['/owned/private.rawheap']; }, ...overrides };
    const files = {
      prepare: async revision => { calls.push(['prepare', revision]); },
      adopt: (revision, paths) => { calls.push(['adopt', revision, paths]); },
      process: async revision => { calls.push(['process', revision]); },
      cleanup: async revision => { calls.push(['cleanup', revision]); return true; },
    };
    globalThis.__rawHeapTest = env; globalThis.canIUse = () => true;
    globalThis.setInterval = callback => { const id = timers.size + 1; timers.set(id, callback); return id; };
    globalThis.clearInterval = id => timers.delete(id);
    const host = new RawHeapHost();
    const grant = () => {
      host.configure(true, files);
      const plan = host.review('process');
      host.confirm(plan.revision, true, true);
      return plan;
    };
    context.after(() => {
      try {
        host.stop();
        assert.equal(host.status.pending, false, 'test must settle its own asynchronous work');
      } finally {
        for (let i = 0; i < keys.length; i++) {
          if (saved[i]) Object.defineProperty(globalThis, keys[i], saved[i]); else delete globalThis[keys[i]];
        }
      }
    });
    return { host, env, calls, files, grant, timers, RawHeapHost };
  }
  test('RawHeap configure/review/confirm are inert and require a prepared file responsibility owner', async context => {
    const { host, calls, files } = await fixture(context);
    assert.equal(host.status.phase, 'closed');
    assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/);
    host.configure(true, undefined);
    assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/);
    host.configure(true, files);
    const plan = host.review('process');
    assert.deepEqual(plan, {revision: 1, scope: 'process', expiresAt: 31000,
      waitBudgetMs: 30000, writesRawFiles: true, needGC: false, needClean: false});
    host.confirm(plan.revision, true, true);
    assert.equal(host.status.phase, 'confirmed'); assert.deepEqual(calls, []);
  });
  test('RawHeap requires independent file and Developer-options acknowledgments for the current review', async context => {
    const { host, files, calls } = await fixture(context); host.configure(true, files);
    const old = host.review('process'), plan = host.review('process');
    assert.throws(() => host.confirm(old.revision, true, true), /RAWHEAP_CONSENT_REQUIRED/);
    assert.throws(() => host.confirm(plan.revision, false, true), /RAWHEAP_RAW_FILE_CONSENT_REQUIRED/);
    assert.throws(() => host.confirm(plan.revision, true, false), /RAWHEAP_DEVELOPER_OPTIONS_REQUIRED/);
    await assert.rejects(host.collect(plan.revision), /RAWHEAP_CONSENT_REQUIRED/);
    assert.deepEqual(calls, []);
  });
  for (const [name, value] of [['debug', false], ['sdkApiVersion', 25], ['deviceType', 'tablet'], ['tid', 42], ['pid', 0]]) {
    test(`RawHeap actual ${name} mismatch cannot authorize a main-thread dump`, async context => {
      const { host, files, calls } = await fixture(context, { [name]: value });
      host.configure(true, files); assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/);
      assert.deepEqual(calls, []);
    });
  }
  test('RawHeap capability failures and unsupported VM scope perform no native or file work', async context => {
    const { host, files, calls } = await fixture(context); host.configure(true, files);
    assert.throws(() => host.review('main-vm'), /RAWHEAP_SCOPE_INVALID/);
    globalThis.canIUse = () => false;
    assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/);
    globalThis.canIUse = () => { throw Error('private system failure'); };
    assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/); assert.deepEqual(calls, []);
  });
  test('RawHeap prepares ownership before requesting whole-process capture and cleans before success', async context => {
    const { host, calls, grant, timers } = await fixture(context);
    const plan = grant(); await host.collect(plan.revision);
    assert.deepEqual(calls, [['prepare', 1], ['dump', false, false, true],
      ['adopt', 1, ['/owned/private.rawheap']], ['process', 1], ['cleanup', 1]]);
    assert.equal(host.status.outcome, 'processed'); assert.equal(host.status.owned, false);
    assert.equal(host.status.rawFiles, 'host-reported-clean'); assert.equal(host.status.capture, 'unverified');
    assert.equal(timers.size, 0); assert(!JSON.stringify(host.status).includes('/owned'));
  });
  test('RawHeap explicit file consumer can process and delete only its private output before returning', async context => {
    const { host, env, files, grant } = await fixture(context);
    const target = path.join(temporary, 'private-test-output.rawheap');
    let created = false, adopted = false, processed = false;
    env.dump = async () => { await writeFile(target, 'synthetic test heap', {flag: 'wx', mode: 0o600}); created = true; return [target]; };
    files.adopt = (_revision, paths) => { assert.deepEqual(paths, [target]); adopted = true; };
    files.process = async () => { assert(adopted); assert.equal(await readFile(target, 'utf8'), 'synthetic test heap'); processed = true; };
    files.cleanup = async () => { if (created) { await unlink(target); created = false; } return true; };
    const plan = grant(); await host.collect(plan.revision);
    assert(processed); assert.equal(existsSync(target), false); assert.equal(host.status.pending, false);
  });
  test('RawHeap cancellation during preparation never dispatches the native dump', async context => {
    const { host, files, calls, grant } = await fixture(context), ready = deferred(), pending = deferred(), cleaned = deferred();
    files.prepare = () => { ready.resolve(); return pending.promise; };
    files.cleanup = async () => { calls.push(['cleanup']); cleaned.resolve(); return true; };
    const plan = grant(), waiting = host.collect(plan.revision); await ready.promise;
    const rejected = assert.rejects(waiting, /RAWHEAP_CANCELED/);
    host.stop(); await rejected; assert.equal(host.status.pending, true); assert.equal(host.status.owned, true);
    pending.resolve(); await cleaned.promise; await Promise.resolve();
    assert.equal(calls.some(call => call[0] === 'dump'), false); assert.equal(host.status.owned, false);
  });
  test('RawHeap cancellation stops waiting but late output is adopted for cleanup without processing', async context => {
    const { host, env, files, calls, grant } = await fixture(context), native = deferred(), started = deferred(), cleaned = deferred();
    env.dump = () => { started.resolve(); return native.promise; };
    files.cleanup = async () => { calls.push(['cleanup']); cleaned.resolve(); return true; };
    const plan = grant(), waiting = host.collect(plan.revision); await started.promise;
    const rejected = assert.rejects(waiting, /RAWHEAP_CANCELED/); host.stop(); await rejected;
    assert.equal(host.status.owned, true); assert.equal(host.status.pending, true);
    assert.throws(() => host.review('process'), /RAWHEAP_BUSY/);
    native.resolve(['/owned/late.rawheap']); await cleaned.promise; await Promise.resolve();
    assert.deepEqual(calls.filter(call => call[0] === 'adopt'), [['adopt', 1, ['/owned/late.rawheap']]]);
    assert.equal(calls.some(call => call[0] === 'process'), false); assert.equal(host.status.outcome, 'canceled');
  });
  test('RawHeap exact collection deadline retains in-flight ownership and never revives late results', async context => {
    const { host, env, files, grant, timers } = await fixture(context), native = deferred(), started = deferred(), cleaned = deferred();
    env.dump = () => { started.resolve(); return native.promise; };
    files.cleanup = async () => { cleaned.resolve(); return true; };
    const plan = grant(), waiting = host.collect(plan.revision); await started.promise;
    const rejected = assert.rejects(waiting, /RAWHEAP_TIMEOUT/); env.now = 31000;
    assert.equal(host.status.outcome, 'timeout'); await rejected;
    assert.equal(host.status.pending, true); assert.equal(timers.size, 0);
    native.resolve(['/owned/late.rawheap']); await cleaned.promise; await Promise.resolve();
    assert.equal(host.status.outcome, 'timeout'); assert.equal(host.status.owned, false);
  });
  test('RawHeap delayed timer delivery cannot extend confirmation and stale revisions never dispatch', async context => {
    const { host, env, calls, grant } = await fixture(context); const plan = grant(); env.now = plan.expiresAt;
    await assert.rejects(host.collect(plan.revision), /RAWHEAP_CONSENT_REQUIRED/); assert.deepEqual(calls, []);
  });
  test('RawHeap native quota error consumes its single VM attempt and keeps only the SDK code', async context => {
    const { host, env, calls, grant, RawHeapHost, files } = await fixture(context);
    env.dump = async () => { const error = Error('private native path'); error.code = 11400106; throw error; };
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CAPTURE_FAILED/);
    assert.equal(host.status.errorCode, 11400106); assert.equal(host.status.attempts, 1);
    assert.equal(calls.filter(call => call[0] === 'cleanup').length, 1);
    assert(!JSON.stringify(host.status).includes('private'));
    host.stop(); const other = new RawHeapHost(); other.configure(true, files);
    assert.throws(() => other.review('process'), /RAWHEAP_ATTEMPT_LIMIT/);
  });
  for (const outputValue of [[], ['/owned/a.rawheap', '/owned/a.rawheap'], ['../private.rawheap'],
    ['/owned/../private.rawheap'], ['/owned/private.txt'], ['/owned/\nprivate.rawheap'], Array(17).fill('/owned/a.rawheap')]) {
    test(`RawHeap malformed output ${JSON.stringify(outputValue).slice(0, 70)} never reaches the file consumer`, async context => {
      const { host, env, calls, grant } = await fixture(context); env.dump = async () => outputValue;
      const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CAPTURE_FAILED/);
      assert.equal(calls.some(call => call[0] === 'adopt' || call[0] === 'process'), false);
      assert.equal(calls.filter(call => call[0] === 'cleanup').length, 1);
    });
  }
  for (const stage of ['prepare', 'adopt', 'process']) {
    test(`RawHeap failed ${stage} retains its original cleanup responsibility`, async context => {
      const { host, files, calls, grant } = await fixture(context);
      files[stage] = () => { throw Error('private file failure'); };
      const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CAPTURE_FAILED/);
      assert.equal(calls.filter(call => call[0] === 'cleanup').length, 1);
      assert.equal(host.status.owned, false); assert.equal(host.status.outcome, 'failed');
    });
  }
  test('RawHeap failed cleanup retains the exact owner and retries only through explicit retryCleanup', async context => {
    const { host, files, calls, grant } = await fixture(context); files.cleanup = async () => { calls.push(['failed-cleanup']); return false; };
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CLEANUP_REQUIRED/);
    assert.equal(host.status.phase, 'cleanup-failed'); assert.equal(host.status.owned, true);
    const count = calls.length; host.stop(); host.configure(true, files); host.status;
    assert.equal(calls.length, count); assert.throws(() => host.review('process'), /RAWHEAP_BUSY/);
    files.cleanup = async () => { calls.push(['explicit-cleanup']); return true; };
    await host.retryCleanup(); assert.equal(host.status.owned, false);
    assert.equal(calls.filter(call => call[0] === 'dump').length, 1);
  });
  test('RawHeap cleanup return must be literal true and cannot certify physical erasure', async context => {
    const { host, files, grant } = await fixture(context); files.cleanup = async () => 'true';
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CLEANUP_REQUIRED/);
    assert.equal(host.status.owned, true); files.cleanup = async () => true; await host.retryCleanup();
    assert.equal(host.status.rawFiles, 'host-reported-clean'); assert.equal(host.status.capture, 'unverified');
  });
  for (const bad of [999, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    test(`RawHeap invalid clock ${String(bad)} permanently invalidates grants while cleanup still settles`, async context => {
      const { host, env, files, grant } = await fixture(context), native = deferred(), started = deferred(), cleaned = deferred();
      env.dump = () => { started.resolve(); return native.promise; };
      files.cleanup = async () => { cleaned.resolve(); return true; };
      const plan = grant(), waiting = host.collect(plan.revision); await started.promise;
      const rejected = assert.rejects(waiting, /RAWHEAP_CANCELED/); env.now = bad; host.status; await rejected;
      env.now = 2000; native.resolve(['/owned/late.rawheap']); await cleaned.promise; await Promise.resolve();
      assert.equal(host.status.clockValid, false); assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/);
    });
  }
  test('RawHeap changing configuration during a pending dump keeps the original file owner', async context => {
    const { host, env, files, calls, grant } = await fixture(context), native = deferred(), started = deferred(), cleaned = deferred();
    env.dump = () => { started.resolve(); return native.promise; };
    files.cleanup = async () => { calls.push(['original-cleanup']); cleaned.resolve(); return true; };
    const plan = grant(), waiting = host.collect(plan.revision); await started.promise;
    const rejected = assert.rejects(waiting, /RAWHEAP_CANCELED/);
    host.configure(true, { ...files, cleanup: async () => { throw Error('wrong file owner'); } }); await rejected;
    native.resolve(['/owned/late.rawheap']); await cleaned.promise; await Promise.resolve();
    assert.equal(calls.filter(call => call[0] === 'original-cleanup').length, 1);
  });
  test('RawHeap wrong-thread cleanup cannot touch a different VM owner even after the original thread returns', async context => {
    const { host, env, files, calls, grant } = await fixture(context), native = deferred(), started = deferred();
    env.dump = () => { started.resolve(); return native.promise; };
    const plan = grant(), waiting = host.collect(plan.revision); await started.promise;
    const rejected = assert.rejects(waiting, /RAWHEAP_CANCELED/); env.tid = 44; host.status; await rejected;
    native.resolve(['/owned/late.rawheap']);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(host.status.phase, 'cleanup-failed'); assert.equal(host.status.pending, false);
    assert.equal(calls.some(call => call[0] === 'cleanup'), false);
    env.tid = 43; host.status; assert.equal(calls.some(call => call[0] === 'cleanup'), false);
    await host.retryCleanup(); assert.equal(host.status.owned, false);
  });
  test('RawHeap reentrant adoption/cleanup cancellation cannot restore a processed result or dispatch cleanup twice', async context => {
    const { host, files, calls, grant } = await fixture(context);
    files.adopt = () => { calls.push(['adopt-stop']); host.stop(); };
    files.cleanup = async () => { calls.push(['cleanup-stop']); host.stop(); return true; };
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CANCELED/);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(calls.some(call => call[0] === 'process'), false);
    assert.equal(calls.filter(call => call[0] === 'cleanup-stop').length, 1);
    assert.equal(host.status.outcome, 'canceled'); assert.equal(host.status.owned, false);
  });
  test('RawHeap cleanup remains inside the wait deadline and holds the owner until cleanup settles', async context => {
    const { host, env, files, grant, timers } = await fixture(context), cleanup = deferred(), entered = deferred();
    files.cleanup = () => { entered.resolve(); return cleanup.promise; };
    const plan = grant(), waiting = host.collect(plan.revision); await entered.promise;
    assert.equal(timers.size, 1, 'pending cleanup must still have its timeout observer');
    const rejected = assert.rejects(waiting, /RAWHEAP_TIMEOUT/); env.now = 31000;
    [...timers.values()][0](); await rejected;
    assert.equal(host.status.owned, true); assert.equal(host.status.pending, true);
    cleanup.resolve(true);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(host.status.owned, false); assert.equal(host.status.outcome, 'timeout');
  });
  for (const drift of ['deadline', 'debug', 'thread']) {
    test(`RawHeap ${drift} drift during cleanup cannot certify successful capture`, async context => {
      const { host, env, files, grant } = await fixture(context), cleanup = deferred(), entered = deferred();
      files.cleanup = () => { entered.resolve(); return cleanup.promise; };
      const plan = grant(), waiting = host.collect(plan.revision); await entered.promise;
      const rejected = assert.rejects(waiting, drift === 'deadline' ? /RAWHEAP_TIMEOUT/ : /RAWHEAP_CANCELED/);
      if (drift === 'deadline') env.now = 31000;
      else if (drift === 'debug') env.debug = false;
      else env.tid = 44;
      cleanup.resolve(true); await rejected;
      if (drift === 'thread') {
        assert.equal(host.status.owned, true); env.tid = 43;
        files.cleanup = async () => true; await host.retryCleanup();
      }
      assert.notEqual(host.status.outcome, 'processed'); assert.equal(host.status.pending, false);
    });
  }
  test('RawHeap path getter thread changes cannot dispatch adoption into a different VM', async context => {
    const { host, env, files, calls, grant } = await fixture(context);
    const paths = Array(1);
    Object.defineProperty(paths, 0, {get() { env.tid = 44; return '/owned/late.rawheap'; }});
    env.dump = async () => paths;
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CANCELED|RAWHEAP_CLEANUP_REQUIRED/);
    assert.equal(calls.some(call => call[0] === 'adopt' || call[0] === 'cleanup'), false);
    assert.equal(host.status.owned, true);
    env.tid = 43; files.cleanup = async () => true; await host.retryCleanup();
  });
  test('RawHeap review limit survives host replacement without native effects', async context => {
    const { host, files, calls, RawHeapHost } = await fixture(context); host.configure(true, files);
    for (let count = 0; count < 256; count++) host.review('process');
    host.stop(); const other = new RawHeapHost(); other.configure(true, files);
    assert.throws(() => other.review('process'), /RAWHEAP_REVIEW_LIMIT/); assert.deepEqual(calls, []);
  });
  test('RawHeap unsafe clock overflow cannot create a review deadline', async context => {
    const { host, env, files } = await fixture(context); host.configure(true, files);
    env.now = Number.MAX_SAFE_INTEGER - 29999;
    assert.throws(() => host.review('process'), /RAWHEAP_UNAVAILABLE/);
  });
  test('RawHeap explicit cleanup retry cancellation stops waiting and keeps exact responsibility until settlement', async context => {
    const { host, files, grant } = await fixture(context); files.cleanup = async () => false;
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CLEANUP_REQUIRED/);
    const cleanup = deferred(), entered = deferred();
    files.cleanup = () => { entered.resolve(); return cleanup.promise; };
    const waiting = host.retryCleanup(); await entered.promise;
    const rejected = assert.rejects(waiting, /RAWHEAP_CANCELED/); host.stop();
    cleanup.resolve(true); await rejected;
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(host.status.pending, false); assert.equal(host.status.owned, false);
  });
  test('RawHeap explicit cleanup retry has a bounded wait without allowing another capture', async context => {
    const { host, env, files, grant, calls, timers } = await fixture(context); files.cleanup = async () => false;
    const plan = grant(); await assert.rejects(host.collect(plan.revision), /RAWHEAP_CLEANUP_REQUIRED/);
    const cleanup = deferred(), entered = deferred();
    files.cleanup = () => { entered.resolve(); return cleanup.promise; };
    env.now = 40000; const waiting = host.retryCleanup(); await entered.promise;
    assert.equal(timers.size, 1); const rejected = assert.rejects(waiting, /RAWHEAP_TIMEOUT/);
    env.now = 70000; [...timers.values()][0](); await rejected;
    assert.equal(host.status.owned, true); assert.equal(host.status.pending, true);
    cleanup.resolve(true);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(host.status.owned, false); assert.equal(calls.filter(call => call[0] === 'dump').length, 1);
  });
  test('RawHeap independent worker source is explicitly compiled in debug and never configured for release', async () => {
    const profile = JSON5.parse(await readFile(new URL('../examples/OHMateKitProducer/entry/build-profile.json5', import.meta.url), 'utf8'));
    assert.equal(profile.buildOption.sourceOption?.workers, undefined);
    assert.deepEqual(profile.buildOptionSet.find(item => item.name === 'debug')?.sourceOption?.workers,
      ['./src/main/ets/dfx/RawHeapHost.ets']);
    assert.equal(profile.buildOptionSet.find(item => item.name === 'release')?.sourceOption?.workers, undefined);
  });
}
