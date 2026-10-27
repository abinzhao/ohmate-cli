/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

export async function registerLeakWatcherTests({ temporary }) {
  const entry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/dfx/LeakWatcherHost.ets', import.meta.url));
  let LeakWatcherHost;
  if (existsSync(entry)) {
    await build({ entryPoints: [entry], outfile: path.join(temporary, 'leak-host.mjs'), bundle: true,
      platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
      plugins: [{ name: 'explicit-leak-platform-substitute', setup(builder) {
        builder.onResolve({ filter: /^@kit\./ }, args => ({ path: args.path, namespace: 'leak-platform' }));
        builder.onLoad({ filter: /.*/, namespace: 'leak-platform' }, args => ({
          contents: args.path === '@kit.PerformanceAnalysisKit' ?
            'export const jsLeakWatcher = new Proxy({}, {get:(_,key)=>globalThis.__leakTest.api[key]});' :
            args.path === '@kit.ArkTS' ?
            'export const process = new Proxy({}, {get:(_,key)=>globalThis.__leakTest[key]});' :
            args.path === '@kit.AbilityKit' ?
            'export const bundleManager = {BundleFlag:{GET_BUNDLE_INFO_WITH_APPLICATION:1},' +
            'getBundleInfoForSelfSync:()=>({appInfo:{debug:globalThis.__leakTest.debug}})};' :
            'export const deviceInfo = new Proxy({}, {get:(_,key)=>globalThis.__leakTest[key]});' +
            'export const systemDateTime = {TimeType:{STARTUP:1},getUptime:()=>globalThis.__leakTest.now};',
          loader: 'js',
        }));
      } }],
    });
    ({ LeakWatcherHost } = await import(pathToFileURL(path.join(temporary, 'leak-host.mjs'))));
  }
  function fixture(context, overrides = {}) {
    assert.equal(typeof LeakWatcherHost, 'function', 'missing explicit application-local LeakWatcherHost');
    const keys = ['__leakTest', 'canIUse'];
    const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const calls = [], env = { now: 1000, pid: 42, tid: 42, sdkApiVersion: 26, deviceType: 'phone',
      debug: true, callbacks: [], api: {
        MonitorObjectType: {CUSTOM_COMPONENT: 1},
        enable: value => calls.push(['enable', value]),
        watch: (object, label) => calls.push(['watch', object, label]),
        check: () => '{"private-object":"must never escape"}',
        enableLeakWatcher: (value, config, callback) => {
          calls.push(['components', value, config]); if (value) env.callbacks.push(callback);
        },
      }, ...overrides };
    globalThis.__leakTest = env; globalThis.canIUse = () => true;
    const host = new LeakWatcherHost();
    context.after(() => {
      host.stop();
      for (let i = 0; i < keys.length; i++) {
        if (saved[i]) Object.defineProperty(globalThis, keys[i], saved[i]); else delete globalThis[keys[i]];
      }
    });
    const start = (mode = 'objects', raw = false) => {
      host.configure(true);
      const plan = host.review(mode);
      host.confirm(plan.revision, raw);
      host.start(plan.revision);
      return plan;
    };
    return { host, env, calls, start };
  }
  test('JSLeakWatcher configure and review perform no native enable or file operation', context => {
    const { host, calls } = fixture(context);
    assert.equal(host.status.phase, 'closed');
    host.configure(true); const plan = host.review('objects');
    assert.equal(plan.writesRawFiles, false); assert.equal(plan.expiresAt, 31000);
    assert.equal(host.status.phase, 'review'); assert.deepEqual(calls, []);
    host.confirm(plan.revision, false);
    assert.deepEqual(calls, []); assert.equal(host.status.phase, 'confirmed');
  });
  test('JSLeakWatcher start requires distinct current review and confirmation', context => {
    const { host, calls } = fixture(context); host.configure(true);
    assert.throws(() => host.start(1), /LEAK_CONSENT_REQUIRED/);
    const old = host.review('objects'), current = host.review('objects');
    assert.throws(() => host.confirm(old.revision, false), /LEAK_CONSENT_REQUIRED/);
    assert.throws(() => host.start(current.revision), /LEAK_CONSENT_REQUIRED/);
    host.confirm(current.revision, false); host.start(current.revision);
    assert.deepEqual(calls, [['enable', true]]);
    assert.throws(() => host.start(current.revision), /LEAK_CONSENT_REQUIRED|LEAK_BUSY/);
  });
  for (const [name, value] of [['debug', false], ['sdkApiVersion', 25], ['deviceType', 'tablet'], ['tid', 43]]) {
    test(`JSLeakWatcher rejects actual ${name} mismatch without native effects`, context => {
      const { host, calls } = fixture(context, { [name]: value }); host.configure(true);
      assert.throws(() => host.review('objects'), /LEAK_UNAVAILABLE/); assert.deepEqual(calls, []);
    });
  }
  test('JSLeakWatcher host and system capability denial cannot opt in', context => {
    const { host, calls } = fixture(context); host.configure(false);
    assert.throws(() => host.review('objects'), /LEAK_UNAVAILABLE/);
    host.configure(true); globalThis.canIUse = () => false;
    assert.throws(() => host.review('objects'), /LEAK_UNAVAILABLE/); assert.deepEqual(calls, []);
  });
  test('JSLeakWatcher object registration preserves exact object with fixed nonprivate label', context => {
    const { host, calls, start } = fixture(context); start();
    const object = Object.defineProperty({}, 'secret', { get() { throw Error('must not inspect watched object'); } });
    host.watch(object); assert.equal(calls[1][1], object); assert.equal(calls[1][2], 'OHMateObject');
    assert.equal(host.status.watched, 1); assert(!JSON.stringify(host.status).includes('secret'));
    for (const value of [null, undefined, 1, 'private', true, () => {}]) {
      assert.throws(() => host.watch(value), /LEAK_OBJECT_INVALID/);
    }
  });
  test('JSLeakWatcher registration and check budgets count failures and survive stop', context => {
    const { host, env, calls, start } = fixture(context); start();
    for (let i = 0; i < 32; i++) host.watch({});
    assert.throws(() => host.watch({}), /LEAK_WATCH_LIMIT/);
    assert.equal(calls.filter(call => call[0] === 'watch').length, 32);
    host.check(); assert.equal(host.status.checkStatus, 'returned-nonempty');
    assert.throws(() => host.check(), /LEAK_CHECK_RATE/);
    env.now += 90000; host.check(); env.now += 90000; host.check();
    env.now += 90000; assert.throws(() => host.check(), /LEAK_CHECK_LIMIT/);
    assert(!JSON.stringify(host.status).includes('private-object'));
    host.stop(); start(); assert.throws(() => host.watch({}), /LEAK_WATCH_LIMIT/);
    assert.throws(() => host.check(), /LEAK_CHECK_LIMIT/);
  });
  test('JSLeakWatcher empty and oversized check output cannot become a leak diagnosis', context => {
    const { host, env, start } = fixture(context); start();
    env.api.check = () => ''; host.check(); assert.equal(host.status.checkStatus, 'empty-or-failed');
    env.now += 90000; env.api.check = () => 'x'.repeat(16385);
    assert.throws(() => host.check(), /LEAK_CHECK_INVALID/);
    assert.equal(host.status.checkStatus, 'empty-or-failed');
  });
  test('JSLeakWatcher native watch failure consumes its attempt without storing object or error', context => {
    const { host, env, start } = fixture(context); start();
    env.api.watch = () => { throw Error('private raw error'); };
    for (let i = 0; i < 32; i++) assert.throws(() => host.watch({}), /LEAK_WATCH_FAILED/);
    assert.equal(host.status.watched, 0); assert.equal(host.status.watchAttempts, 32);
    assert.throws(() => host.watch({}), /LEAK_WATCH_LIMIT/);
    assert(!JSON.stringify(host.status).includes('private'));
  });
  test('JSLeakWatcher automatic components require explicit raw-file consent and narrow fixed config', context => {
    const { host, calls } = fixture(context); host.configure(true);
    const plan = host.review('components'); assert.equal(plan.writesRawFiles, true);
    assert.throws(() => host.confirm(plan.revision, false), /LEAK_RAW_FILE_CONSENT_REQUIRED/);
    host.confirm(plan.revision, true); host.start(plan.revision);
    assert.deepEqual(calls[0], ['components', true, {monitorObjectTypes: 1, checkInterval: 90000,
      fgLeakCountThreshold: 5, bgLeakCountThreshold: 1, maxStoredHeapDumps: 1, dumpHeapWaitTimeMs: 5000}]);
    assert.equal(host.status.rawFiles, 'may-exist');
    assert.throws(() => host.watch({}), /LEAK_MODE_INVALID/);
    assert.throws(() => host.check(), /LEAK_MODE_INVALID/);
  });
  test('JSLeakWatcher automatic callback never reads filenames and only reports bounded shape', context => {
    const { host, env, start } = fixture(context); start('components', true);
    const values = Array(2); Object.defineProperty(values, 0, {get() { throw Error('private path read'); }});
    Object.defineProperty(values, 1, {get() { throw Error('private heap read'); }});
    env.callbacks[0](values); assert.equal(host.status.callbacks, 1);
    assert.equal(host.status.filePairReported, true);
    env.callbacks[0](['unexpected']); assert.equal(host.status.dropped, 1);
    for (let i = 0; i < 40; i++) env.callbacks[0](values);
    assert.equal(host.status.callbacks, 32); assert.equal(host.status.dropped, 10);
    host.stop(); env.callbacks[0](values);
    assert.equal(host.status.filePairReported, false); assert.equal(host.status.callbacks, 0);
    assert.equal(host.status.rawFiles, 'may-exist', 'stop does not prove raw-file removal');
  });
  test('JSLeakWatcher synchronous acquire callback cannot be reported or revive stopped owner', context => {
    const { host, env, calls } = fixture(context);
    env.api.enableLeakWatcher = (value, config, callback) => {
      calls.push(['components', value]); if (value) { callback(Array(2)); host.stop(); }
    };
    host.configure(true); const plan = host.review('components');
    host.confirm(plan.revision, true); host.start(plan.revision);
    assert.deepEqual(calls, [['components', true], ['components', false]]);
    assert.equal(host.status.phase, 'closed'); assert.equal(host.status.callbacks, 0);
  });
  test('JSLeakWatcher failed disable retains exact owner until explicit stop retry', context => {
    const { host, env, calls, start } = fixture(context); start();
    env.api.enable = value => { calls.push(['enable', value]); if (!value) throw Error('private disable failure'); };
    host.stop(); assert.equal(host.status.phase, 'cleanup-failed'); assert.equal(host.status.owned, true);
    const count = calls.length; host.status; host.configure(true);
    assert.equal(calls.length, count, 'configure/status never retry failed cleanup');
    assert.throws(() => host.review('objects'), /LEAK_BUSY/);
    env.api.enable = value => calls.push(['enable', value]); host.stop();
    assert.equal(host.status.phase, 'closed'); assert.equal(host.status.owned, false);
  });
  test('JSLeakWatcher failed acquisition attempts cleanup and never grants callback admission', context => {
    const { host, env, calls } = fixture(context); host.configure(true);
    env.api.enableLeakWatcher = (value, config, callback) => {
      calls.push(['components', value]); if (value) { env.callbacks.push(callback); throw Error('private acquire failure'); }
    };
    const plan = host.review('components'); host.confirm(plan.revision, true);
    assert.throws(() => host.start(plan.revision), /LEAK_START_FAILED/);
    assert.deepEqual(calls, [['components', true], ['components', false]]);
    env.callbacks[0](Array(2)); assert.equal(host.status.callbacks, 0); assert.equal(host.status.owned, false);
  });
  test('JSLeakWatcher exact review deadline and source drift invalidate without automatic restart', context => {
    const { host, env, calls } = fixture(context); host.configure(true);
    const plan = host.review('objects'); host.confirm(plan.revision, false); env.now = plan.expiresAt;
    assert.throws(() => host.start(plan.revision), /LEAK_CONSENT_REQUIRED/); assert.deepEqual(calls, []);
    env.now++; const current = host.review('objects'); host.confirm(current.revision, false); host.start(current.revision);
    env.debug = false; assert.equal(host.status.phase, 'closed');
    assert.deepEqual(calls, [['enable', true], ['enable', false]]);
    env.debug = true; assert.throws(() => host.watch({}), /LEAK_CONSENT_REQUIRED/);
  });
  for (const invalid of [999, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    test(`JSLeakWatcher clock ${String(invalid)} permanently invalidates and disables owned collection`, context => {
      const { host, env, calls, start } = fixture(context); start();
      env.now = invalid; assert.equal(host.status.phase, 'closed'); assert.equal(host.status.clockValid, false);
      env.now = 2000; host.configure(true); assert.throws(() => host.review('objects'), /LEAK_UNAVAILABLE/);
      assert.deepEqual(calls, [['enable', true], ['enable', false]]);
    });
  }
  test('JSLeakWatcher active deadline is fixed and cannot be extended by status or confirmation', context => {
    const { host, env, calls, start } = fixture(context); const plan = start();
    assert.equal(host.status.deadline, 601000);
    assert.throws(() => host.confirm(plan.revision, false), /LEAK_CONSENT_REQUIRED/);
    env.now = 601000; assert.equal(host.status.phase, 'closed'); assert.equal(host.status.owned, false);
    assert.deepEqual(calls, [['enable', true], ['enable', false]]);
  });
  test('JSLeakWatcher concurrent local host cannot take over another owner', context => {
    const { host, calls, start } = fixture(context); start();
    const contender = new LeakWatcherHost(); contender.configure(true);
    assert.throws(() => contender.review('objects'), /LEAK_BUSY/);
    contender.stop(); assert.deepEqual(calls, [['enable', true]]);
    host.stop(); const plan = contender.review('objects');
    contender.confirm(plan.revision, false); contender.start(plan.revision); contender.stop();
    assert.deepEqual(calls, [['enable', true], ['enable', false], ['enable', true], ['enable', false]]);
  });
  test('JSLeakWatcher thread drift never disables a different VM and retains original cleanup responsibility', context => {
    const { host, env, calls, start } = fixture(context); start(); env.tid = 43;
    assert.equal(host.status.phase, 'cleanup-failed'); assert.equal(host.status.owned, true);
    assert.deepEqual(calls, [['enable', true]]);
    env.tid = 42; assert.equal(host.status.phase, 'cleanup-failed');
    host.stop(); assert.deepEqual(calls, [['enable', true], ['enable', false]]);
  });
  test('JSLeakWatcher malformed platform process IDs do not authorize a main-thread claim', context => {
    const { host, env, calls } = fixture(context); host.configure(true); env.pid = 0; env.tid = 0;
    assert.throws(() => host.review('objects'), /LEAK_UNAVAILABLE/); assert.deepEqual(calls, []);
  });
  test('JSLeakWatcher check reentrant stop cannot restore old raw-result observation', context => {
    const { host, env, start } = fixture(context); start();
    env.api.check = () => { host.stop(); return '{"private":"late"}'; };
    host.check(); assert.equal(host.status.phase, 'closed'); assert.equal(host.status.checkStatus, 'not-run');
  });
  test('JSLeakWatcher confirmed source-clock overflow cannot produce an unsafe deadline', context => {
    const { host, env, calls } = fixture(context); host.configure(true); env.now = Number.MAX_SAFE_INTEGER - 30000;
    assert.throws(() => host.review('objects'), /LEAK_UNAVAILABLE/); assert.deepEqual(calls, []);
  });
  test('JSLeakWatcher reentrant native disable dispatches only one cleanup call', context => {
    const { host, env, calls, start } = fixture(context); start();
    env.api.enable = value => {
      calls.push(['enable', value]);
      if (!value && calls.length === 2) host.stop();
    };
    host.stop(); assert.deepEqual(calls, [['enable', true], ['enable', false]]);
    assert.equal(host.status.owned, false);
  });
  test('JSLeakWatcher reference Ability configures only and closes every exit path without Wants or Core registration', () => {
    const ability = readFileSync(new URL('../examples/OHMateKitProducer/entry/src/main/ets/entryability/EntryAbility.ets', import.meta.url), 'utf8');
    assert.match(ability, /import \{ leakWatcherHost \} from '\.\.\/dfx\/LeakWatcherHost'/);
    assert.match(ability, /leakWatcherHost\.configure\(this\.context\.applicationInfo\.debug === true\)/);
    for (const name of ['onDestroy', 'onWindowStageDestroy', 'onBackground']) {
      const body = ability.slice(ability.indexOf(name + '('), ability.indexOf('\n  }', ability.indexOf(name + '(')));
      assert.match(body, /leakWatcherHost\.stop\(\)/, name + ' must close explicit monitoring');
    }
    assert.doesNotMatch(ability, /leakWatcherHost\.(?:start|confirm|review|watch|check)\(/);
  });
}
