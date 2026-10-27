/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

export async function registerFaultLogTests({ temporary }) {
  const directory = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/faultlogextension/', import.meta.url));
  let FaultLogHost, OHMateFaultLogExtension, EntryAbility, faultLogHost;
  if (existsSync(path.join(directory, 'FaultLogHost.ets'))) {
    await build({
      stdin: { contents: 'export {FaultLogHost,faultLogHost} from "./FaultLogHost"; export {default as OHMateFaultLogExtension} from "./OHMateFaultLogExtension";' +
        'export {default as EntryAbility} from "../entryability/EntryAbility";',
        resolveDir: directory, loader: 'ts' },
      outfile: path.join(temporary, 'faultlog.mjs'), bundle: true, platform: 'node', format: 'esm',
      loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
      plugins: [{ name: 'explicit-faultlog-platform-substitute', setup(builder) {
        builder.onResolve({ filter: /\/ProducerController$/ }, args => ({ path: args.path, namespace: 'faultlog-producer-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'faultlog-producer-test' }, () => ({
          contents: 'export const producer={stop:async()=>{}};', loader: 'js'
        }));
        builder.onResolve({ filter: /^@kit\./ }, args => ({ path: args.path, namespace: 'faultlog-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'faultlog-test' }, () => ({
          contents: 'export class FaultLogExtensionAbility {};' +
            'export const jsLeakWatcher = {};' +
            'export const process = {pid:42,tid:42}; export const deviceInfo = {sdkApiVersion:26,deviceType:"phone"};' +
            'export const bundleManager = {BundleFlag:{GET_BUNDLE_INFO_WITH_APPLICATION:1},getBundleInfoForSelfSync:()=>({appInfo:{debug:true}})};' +
            'export const hiAppEvent = {domain:{OS:"OS"},event:{APP_CRASH:"APP_CRASH",APP_FREEZE:"APP_FREEZE"},' +
            'EventType:{FAULT:1,STATISTIC:2,SECURITY:4,BEHAVIOR:8},' +
            'addWatcher:w=>globalThis.__faultLogTest.add(w),removeWatcher:w=>globalThis.__faultLogTest.remove(w)};' +
            'export const systemDateTime={TimeType:{STARTUP:1},getUptime:()=>globalThis.__faultLogTest.now};' +
            'export class UIAbility {};' +
            'export const ConfigurationConstant={ColorMode:{COLOR_MODE_NOT_SET:0}};' +
            'export const hilog={info:()=>{},error:()=>{}};',
          loader: 'js'
        }));
      } }]
    });
    ({ FaultLogHost, OHMateFaultLogExtension, EntryAbility, faultLogHost } = await import(pathToFileURL(path.join(temporary, 'faultlog.mjs'))));
  }
  function fixture(context) {
    const beforeCan = globalThis.canIUse, beforePort = globalThis.__faultLogTest;
    const beforeSet = globalThis.setTimeout, beforeClear = globalThis.clearTimeout;
    const added = [], removed = [], timers = new Map();
    let sequence = 0;
    const port = { now: 100, added, removed, timers, capable: true,
      add(watcher) { added.push(watcher); return {}; },
      remove(watcher) { removed.push(watcher); },
    };
    globalThis.__faultLogTest = port;
    globalThis.canIUse = () => port.capable;
    globalThis.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    context.after(() => {
      globalThis.canIUse = beforeCan; globalThis.__faultLogTest = beforePort;
      globalThis.setTimeout = beforeSet; globalThis.clearTimeout = beforeClear;
    });
    return port;
  }
  function event(name = 'APP_CRASH') {
    const info = { domain: 'OS', name, eventType: 1 };
    Object.defineProperty(info, 'params', { get() { throw Error('private fault params queried'); } });
    return [{ name, appEventInfos: [info] }];
  }
  function host(port) { assert(FaultLogHost, 'FaultLogHost must exist'); return new FaultLogHost(); }
  function extension(port, debug = true) {
    assert(OHMateFaultLogExtension, 'Extension template must exist');
    const instance = new OHMateFaultLogExtension();
    instance.context = { applicationInfo: { debug } };
    return instance;
  }
  test('FaultLog construction, host configure and Extension creation perform no registration or timer work', context => {
    const port = fixture(context), owner = host(port);
    owner.configure(true); extension(port);
    assert.equal(port.added.length, 0); assert.equal(port.timers.size, 0);
    assert.equal(owner.status().phase, 'unconfirmed');
  });
  for (const debug of [false, undefined, true]) {
    test(`FaultLog host requires both explicit confirmation and literal debug true (${debug})`, context => {
      const port = fixture(context), owner = host(port); owner.configure(debug);
      assert.equal(owner.confirm(false), false); assert.equal(port.added.length, 0);
      assert.equal(owner.confirm(true), debug === true);
      assert.equal(port.added.length, debug === true ? 2 : 0);
    });
  }
  test('FaultLog absent Syscap rejects host and Extension without native work', context => {
    const port = fixture(context); port.capable = false;
    const owner = host(port); owner.configure(true); assert.equal(owner.confirm(true), false);
    const instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
    assert.equal(port.added.length, 0); assert.equal(port.timers.size, 0);
  });
  test('FaultLog A has a real summary callback; host B is empty and exactly matches Extension B', context => {
    const port = fixture(context), owner = host(port); owner.configure(true); owner.confirm(true);
    const [a, b] = port.added;
    assert.notEqual(a.name, b.name);
    for (const watcher of [a, b]) assert.deepEqual(watcher.appEventFilters, [{ domain: 'OS', names: ['APP_CRASH', 'APP_FREEZE'] }]);
    a.onReceive('OS', event()); b.onReceive('OS', event('APP_FREEZE'));
    assert.deepEqual(owner.status().recent.map(item => item.eventName), ['APP_CRASH']);
    const instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
    assert.equal(port.added[2].name, b.name);
    port.added[2].onReceive('OS', event('APP_FREEZE'));
    assert.deepEqual(instance.report().recent.map(item => item.eventName), ['APP_FREEZE']);
    assert.equal(instance.report().buildIdentity, 'unverified');
    assert.equal(instance.report().delayedSystemLaunch, 'not-verified');
  });
  test('FaultLog successful synchronous add callbacks never become evidence before complete acquisition', context => {
    const port = fixture(context), add = port.add;
    port.add = watcher => { watcher.onReceive('OS', event()); return add(watcher); };
    const owner = host(port); owner.configure(true); assert.equal(owner.confirm(true), true);
    assert.equal(owner.status().recent.length, 0);
    const instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
    assert.equal(instance.report().recent.length, 0);
  });
  for (const failure of ['null', 'throw']) {
    for (const index of [1, 2]) {
      test(`FaultLog host failed ${failure} registration ${index} removes each exact attempted owner`, context => {
        const port = fixture(context);
        port.add = watcher => {
          port.added.push(watcher); watcher.onReceive('OS', event());
          if (port.added.length === index) { if (failure === 'throw') throw Error('native failure'); return null; }
          return {};
        };
        const owner = host(port); owner.configure(true); assert.equal(owner.confirm(true), false);
        assert.equal(port.removed.length, index);
        assert.deepEqual(new Set(port.removed), new Set(port.added));
        assert.equal(owner.status().recent.length, 0); assert.equal(owner.status().pendingCleanup, 0);
      });
    }
  }
  test('FaultLog failed native removal invalidates callbacks, retains owners and retries only on explicit revoke', context => {
    const port = fixture(context), owner = host(port); owner.configure(true); owner.confirm(true);
    port.remove = watcher => { port.removed.push(watcher); throw Error('cannot remove'); };
    assert.equal(owner.revoke(), false);
    const count = port.removed.length;
    for (let index = 0; index < 3; index++) { owner.status(); owner.confirm(true); owner.configure(true); }
    assert.equal(port.removed.length, count); assert.equal(port.added.length, 2);
    port.added[0].onReceive('OS', event()); assert.equal(owner.status().recent.length, 0);
    assert.equal(owner.status().pendingCleanup, 2);
    port.remove = watcher => port.removed.push(watcher);
    assert.equal(owner.revoke(), true); assert.equal(owner.status().pendingCleanup, 0);
    assert.equal(owner.confirm(true), true);
  });
  test('FaultLog configure or detach stops acceptance and preserves persisted filters until explicit revoke', context => {
    const port = fixture(context), owner = host(port); owner.configure(true); owner.confirm(true);
    owner.detach(); port.added[0].onReceive('OS', event());
    assert.equal(owner.status().recent.length, 0); assert.equal(port.removed.length, 0);
    assert.equal(owner.confirm(true), false);
    owner.configure(true); assert.equal(owner.confirm(true), false);
    assert.equal(port.added.length, 2);
    assert.equal(owner.revoke(), true); assert.equal(port.removed.length, 2);
  });
  test('FaultLog repeated host confirmation and ready/connect callbacks never replace names or reset the budget', context => {
    const port = fixture(context), owner = host(port); owner.configure(true); owner.confirm(true); owner.confirm(true);
    assert.equal(port.added.length, 2);
    const instance = extension(port); instance.onConnect();
    assert.equal([...port.timers.values()][0].delay, 9000);
    port.now = 200; instance.onConnect(); instance.onFaultReportReady(); instance.onFaultReportReady();
    assert.equal(port.added.length, 3); assert.equal(port.timers.size, 1);
    port.now = 9100;
    assert.equal(instance.report().phase, 'expired');
    port.added[2].onReceive('OS', event()); assert.equal(instance.report().recent.length, 0);
    assert.equal(port.timers.size, 0); assert.equal(port.removed.length, 0);
    instance.onConnect(); instance.onFaultReportReady(); assert.equal(port.added.length, 3);
  });
  test('FaultLog ready before connect, Release and unavailable context stay inactive', context => {
    const port = fixture(context), instance = extension(port);
    instance.onFaultReportReady(); assert.equal(port.added.length, 0);
    for (const debug of [false, undefined]) {
      const denied = extension(port); denied.context.applicationInfo.debug = debug;
      denied.onConnect(); denied.onFaultReportReady();
    }
    const missing = extension(port); missing.context = undefined; missing.onConnect(); missing.onFaultReportReady();
    assert.equal(port.added.length, 0); assert.equal(port.timers.size, 0);
  });
  for (const bad of [99, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(`FaultLog invalid or regressing uptime closes the Extension permanently (${bad})`, context => {
      const port = fixture(context), instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
      port.now = bad; port.added[0].onReceive('OS', event());
      assert.equal(instance.report().recent.length, 0); assert.equal(instance.report().phase, 'clock-invalid');
      port.now = 101; instance.onConnect(); instance.onFaultReportReady();
      port.added[0].onReceive('OS', event());
      assert.equal(port.added.length, 1); assert.equal(port.timers.size, 0);
    });
  }
  test('FaultLog delayed timer delivery does not extend callback acceptance; timer and disconnect clear memory only', context => {
    const port = fixture(context), instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
    port.added[0].onReceive('OS', event());
    assert.equal(instance.report().recent.length, 1);
    const timer = [...port.timers.values()][0]; timer.callback();
    assert.equal(instance.report().recent.length, 0); assert.equal(port.timers.size, 0);
    instance.onDisconnect(); port.added[0].onReceive('OS', event());
    assert.equal(instance.report().recent.length, 0); assert.equal(port.removed.length, 0);
  });
  for (const failure of ['null', 'throw']) {
    test(`FaultLog Extension failed ${failure} acquisition is terminal and retains failed cleanup`, context => {
      const port = fixture(context);
      port.add = watcher => { port.added.push(watcher); watcher.onReceive('OS', event()); if (failure === 'throw') throw Error('native'); return null; };
      port.remove = () => { throw Error('remove'); };
      const instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
      assert.equal(instance.report().phase, 'cleanup-failed');
      assert.equal(instance.report().pendingCleanup, 1); assert.equal(instance.report().recent.length, 0);
      instance.onFaultReportReady(); instance.onDisconnect(); assert.equal(port.added.length, 1);
      port.remove = watcher => port.removed.push(watcher);
      assert.equal(instance.revoke(), true); assert.equal(instance.report().pendingCleanup, 0);
    });
  }
  test('FaultLog events and reports are bounded detached summaries with no raw parameters, files or native ids', context => {
    const port = fixture(context), instance = extension(port); instance.onConnect(); instance.onFaultReportReady();
    const watcher = port.added[0];
    watcher.onReceive('PRIVATE', event()); watcher.onReceive('OS', event('UNKNOWN'));
    watcher.onReceive('OS', [{ name: 'APP_CRASH', appEventInfos: Array.from({ length: 1000 }, () => event()[0].appEventInfos[0]) }]);
    const result = instance.report();
    assert.equal(result.recent.length, 32); assert(result.dropped >= 968);
    assert.deepEqual(Object.keys(result.recent[0]).sort(), ['eventName', 'observedUptimeMs']);
    result.recent[0].eventName = 'changed'; result.recent.length = 0;
    assert.equal(instance.report().recent.length, 32); assert.equal(instance.report().recent[0].eventName, 'APP_CRASH');
  });
  for (const action of ['revoke', 'configure']) {
    test(`FaultLog host ${action} during synchronous native registration cannot revive consent`, context => {
      const port = fixture(context), owner = host(port); owner.configure(true);
      port.add = watcher => {
        port.added.push(watcher);
        if (action === 'revoke') owner.revoke(); else owner.configure(true);
        return {};
      };
      assert.equal(owner.confirm(true), false);
      assert.equal(port.added.length, 1); assert.equal(port.removed.length, 1);
      assert.equal(port.added[0], port.removed[0]);
      port.added[0].onReceive('OS', event()); assert.equal(owner.status().recent.length, 0);
    });
  }
  test('FaultLog host regressing clock clears evidence and requires explicit filter revoke before rearm', context => {
    const port = fixture(context), owner = host(port); owner.configure(true); owner.confirm(true);
    port.added[0].onReceive('OS', event());
    port.now = 99; port.added[0].onReceive('OS', event());
    assert.equal(owner.status().recent.length, 0);
    port.now = 101; assert.equal(owner.confirm(true), false); assert.equal(port.added.length, 2);
    assert.equal(port.removed.length, 0);
  });
  test('FaultLog host capability lookup failure returns denial without platform work', context => {
    const port = fixture(context), owner = host(port); owner.configure(true);
    globalThis.canIUse = () => { throw Error('lookup'); };
    assert.equal(owner.confirm(true), false); assert.equal(port.added.length, 0);
  });
  test('FaultLog disconnect or elapsed clock during synchronous Extension add never revives callbacks', context => {
    const port = fixture(context), instance = extension(port); instance.onConnect();
    port.add = watcher => { port.added.push(watcher); instance.onDisconnect(); return {}; };
    instance.onFaultReportReady(); port.added[0].onReceive('OS', event());
    assert.equal(instance.report().phase, 'disconnected'); assert.equal(instance.report().recent.length, 0);
    assert.equal(port.timers.size, 0); assert.equal(port.removed.length, 0);
  });
  test('FaultLog real EntryAbility wiring configures debug but does not accept forged Want consent', context => {
    const port = fixture(context);
    assert(EntryAbility); const ability = new EntryAbility();
    ability.context = { applicationInfo: { debug: true },
      getApplicationContext: () => ({ setColorMode: () => {} }) };
    ability.onCreate({ parameters: { faultLogConsent: true } }, {});
    assert.equal(port.added.length, 0); assert.equal(port.timers.size, 0);
    assert.equal(faultLogHost.confirm(true), true); assert.equal(port.added.length, 2);
    ability.onDestroy(); port.added[0].onReceive('OS', event());
    assert.equal(faultLogHost.status().recent.length, 0);
    assert.equal(port.removed.length, 0); assert.equal(faultLogHost.revoke(), true);
  });
}
