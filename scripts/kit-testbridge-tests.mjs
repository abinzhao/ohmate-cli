/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Local read-only READY/ASSERT contracts, never automated actions or device proof.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-testbridge-'));
const owned = [], timers = new Map();
const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay) => {
  const timer = nativeSet(() => { timers.delete(timer); callback(); }, delay);
  timers.set(timer, { callback, delay }); return timer;
};
globalThis.clearTimeout = timer => { timers.delete(timer); nativeClear(timer); };
function fire(delay) {
  for (const [timer, item] of [...timers]) if (item.delay === delay) {
    globalThis.clearTimeout(timer); item.callback();
  }
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function settled() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
let api;
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/api/test.ets', import.meta.url))],
    outfile: path.join(directory, 'test.mjs'), bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
  });
  api = await import(pathToFileURL(path.join(directory, 'test.mjs')));
} catch (error) { console.error('public Test entry unavailable:', error.errors?.[0]?.text ?? error.message); }
class Adapter {
  calls = []; result = true; pending; closePending; closeResult = true;
  started = deferred(); closed = deferred();
  ready() { this.calls.push('ready'); this.started.resolve(); return this.pending?.promise ?? Promise.resolve(this.result); }
  assert(id) { this.calls.push(id); this.started.resolve(); return this.pending?.promise ?? Promise.resolve(this.result); }
  close() { this.calls.push('close'); this.closed.resolve(); return this.closePending?.promise ?? Promise.resolve(this.closeResult); }
}
function subject(profile = 'test') {
  assert(api?.OHMateTestBridge, 'single package public Test Bridge must exist');
  let clock = 1000;
  const bridge = new api.OHMateTestBridge(profile, () => clock);
  const adapter = new Adapter();
  const item = { bridge, adapter, advance: value => { clock = value; } };
  owned.push(item); return item;
}
function register(item, ids = ['test.assert.ready']) {
  assert.equal(item.bridge.registerAdapter(item.adapter, ids).code, 'REGISTERED');
}
after(async () => {
  for (const item of owned) {
    item.adapter.pending?.resolve(true); item.adapter.closePending?.resolve(true);
    await settled(); item.adapter.closeResult = true;
    await item.bridge.dispose(); await item.bridge.retryCleanup();
  }
  assert.equal(timers.size, 0, 'all Test Bridge waits must settle');
  globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear;
  await rm(directory, { recursive: true, force: true });
});
test('Test entry and registration do not read, connect, start Core or acquire a surface', () => {
  const item = subject(); register(item); assert.deepEqual(item.adapter.calls, []);
  assert.equal(timers.size, 0);
});
test('missing application Adapter keeps READY and ASSERT unavailable', async () => {
  const item = subject();
  assert.equal((await item.bridge.ready()).code, 'TEST_ADAPTER_UNAVAILABLE');
  assert.equal((await item.bridge.assert('test.assert.ready')).code, 'TEST_ADAPTER_UNAVAILABLE');
});
test('Debug, Release and unknown Profiles never invoke a Test Adapter', async () => {
  for (const profile of ['debug', 'release-core', 'release-none', 'invalid']) {
    const item = subject(profile);
    assert.equal(item.bridge.registerAdapter(item.adapter, ['test.assert.ready']).code, 'CAPABILITY_NOT_AVAILABLE');
    assert.equal((await item.bridge.ready()).code, 'CAPABILITY_NOT_AVAILABLE');
    await item.bridge.dispose(); assert.deepEqual(item.adapter.calls, []);
  }
});
test('READY is an application-reported observation with no automation or authenticated build', async () => {
  const item = subject(); register(item);
  const result = await item.bridge.ready();
  assert.equal(result.code, 'READY_REPORTED'); assert.equal(result.event, 'READY');
  assert.equal(result.passed, true);
  assert.equal(result.execution, 'manual-only'); assert.equal(result.automation, 'unavailable');
  assert.equal(result.buildVerification, 'unverified-build'); assert.equal(result.verification, 'unverified');
  item.adapter.result = false;
  assert.equal((await item.bridge.ready()).passed, false);
});
test('ASSERT dispatches only a registered bounded test identifier and returns a boolean summary', async () => {
  const item = subject(); const ids = ['test.assert.ready']; register(item, ids);
  ids[0] = 'test.assert.changed';
  assert.equal((await item.bridge.assert('test.assert.changed')).code, 'TEST_ASSERTION_UNREGISTERED');
  assert.equal((await item.bridge.assert('../private')).code, 'TEST_ASSERTION_UNREGISTERED');
  const result = await item.bridge.assert('test.assert.ready');
  assert.equal(result.code, 'ASSERT_REPORTED'); assert.equal(result.event, 'ASSERT');
  assert.equal(result.assertionId, 'test.assert.ready'); assert.equal(result.passed, true);
  assert.deepEqual(item.adapter.calls, ['test.assert.ready']);
});
test('assertion registration rejects duplicates, non-test references and excessive IDs without effects', () => {
  for (const ids of [[], ['test.assert.same', 'test.assert.same'], ['system.permission'],
    Array.from({ length: 33 }, (_, i) => 'test.assert.' + i)]) {
    const item = subject();
    assert.equal(item.bridge.registerAdapter(item.adapter, ids).code, 'TEST_ASSERTIONS_INVALID');
    assert.deepEqual(item.adapter.calls, []);
  }
  const item = subject(); register(item);
  assert.equal(item.bridge.registerAdapter(new Adapter(), ['test.assert.other']).code, 'TEST_ADAPTER_CONFLICT');
});
test('nonboolean and appended authentication claims cannot become assertions or leak into results', async () => {
  const item = subject(); register(item);
  item.adapter.result = { passed: true, verified: true, token: 'private-value', authenticated: true };
  const result = await item.bridge.assert('test.assert.ready');
  assert.equal(result.code, 'TEST_RESULT_INVALID');
  assert(!JSON.stringify(result).includes('private-value'));
  assert.equal(result.verification, 'unverified');
});
test('READY timeout retains its exact read owner and a late result cannot satisfy a later ASSERT', async () => {
  const item = subject(); register(item); item.adapter.pending = deferred();
  const operation = item.bridge.ready(100); await item.adapter.started.promise; fire(100);
  assert.equal((await operation).code, 'PROVIDER_TIMEOUT');
  assert.equal((await item.bridge.assert('test.assert.ready')).code, 'PROVIDER_BUSY');
  item.adapter.pending.resolve(true); await settled(); item.adapter.pending = undefined;
  assert.equal((await item.bridge.assert('test.assert.ready')).code, 'ASSERT_REPORTED');
  assert.deepEqual(item.adapter.calls, ['ready', 'test.assert.ready']);
});
test('disposal cancels waiting and only closes the Adapter after the pending native read settles', async () => {
  const item = subject(); register(item); item.adapter.pending = deferred();
  const operation = item.bridge.ready(); await item.adapter.started.promise; await item.bridge.dispose();
  assert.equal((await operation).code, 'PROVIDER_CANCELLED');
  assert.deepEqual(item.adapter.calls, ['ready']);
  item.adapter.pending.resolve(true); await item.adapter.closed.promise; await settled();
  assert.deepEqual(item.adapter.calls, ['ready', 'close']);
  assert.equal((await item.bridge.ready()).code, 'DISPOSED');
});
test('failed and timed-out cleanup only retries explicitly after disposal', async () => {
  const item = subject(); register(item); item.adapter.closeResult = false;
  assert.equal((await item.bridge.dispose()).code, 'PROVIDER_CLEANUP_REQUIRED');
  item.bridge.getStatus(); await item.bridge.dispose();
  assert.deepEqual(item.adapter.calls, ['close']);
  item.adapter.closeResult = true; assert.equal((await item.bridge.retryCleanup()).code, 'UNREGISTERED');
});
test('clock drift permanently closes Test observations without discarding cleanup ownership', async () => {
  const item = subject(); register(item); item.advance(999);
  assert.equal((await item.bridge.ready()).code, 'PROVIDER_CLOCK_INVALID');
  item.advance(2000);
  assert.equal((await item.bridge.ready()).code, 'PROVIDER_CLOCK_INVALID');
  assert.deepEqual(item.adapter.calls, []);
});
test('read quotas include invalid results and cannot be renewed by readiness or status queries', async () => {
  const item = subject(); register(item); item.adapter.result = 'private-value';
  for (let i = 0; i < 256; i++) assert.equal((await item.bridge.ready()).code, 'TEST_RESULT_INVALID');
  item.bridge.getStatus();
  assert.equal((await item.bridge.ready()).code, 'PROVIDER_READ_QUOTA');
  assert.equal(item.adapter.calls.length, 256);
});
