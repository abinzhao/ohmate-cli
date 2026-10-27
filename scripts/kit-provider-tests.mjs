/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Executes portable package ETS; injected adapters do not prove device API behavior.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-provider-tests-'));
after(() => rm(directory, { recursive: true, force: true }));
const timers = new Set();
const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay) => {
  const timer = nativeSet(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer); return timer;
};
globalThis.clearTimeout = timer => { timers.delete(timer); nativeClear(timer); };
let api;
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/providers/index.ets', import.meta.url))],
    outfile: path.join(directory, 'providers.mjs'), bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
  });
  api = await import(pathToFileURL(path.join(directory, 'providers.mjs')));
} catch (error) {
  test('single OHPM package provides its independent readonly Provider entry', () => {
    assert.fail(`Provider entry unavailable: ${error.errors?.[0]?.text ?? error.message}`);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const schema = {
  name: 'provider.metric',
  fields: [{ key: 'bytes', kind: 'number', minimum: 0, maximum: 100000 },
    { key: 'phase', kind: 'enum', values: ['idle', 'active'] }, { key: 'available', kind: 'boolean' }],
};
class Adapter {
  calls = 0; closes = 0; result = { bytes: 64, phase: 'active', available: true };
  pending; closePending; closeResult = true; readError = false; closeError = false;
  started = deferred(); closed = deferred();
  read() {
    this.calls++; this.started.resolve();
    if (this.readError) throw Error('private-read-error');
    return this.pending?.promise ?? Promise.resolve(this.result);
  }
  close() {
    this.closes++; this.closed.resolve();
    if (this.closeError) throw Error('private-close-error');
    return this.closePending?.promise ?? Promise.resolve(this.closeResult);
  }
}
const owners = [];
after(async () => {
  for (const owner of owners) {
    owner.adapter.pending?.resolve({ bytes: 1 });
    owner.adapter.closePending?.resolve(true);
    owner.adapter.closeResult = true; owner.adapter.closeError = false;
    await owner.registry.dispose();
  }
});
after(() => {
  globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear;
  assert.equal(timers.size, 0, 'all Provider timeout owners must settle');
});
function subject(profile = 'debug') {
  let clock = 1000;
  const registry = new api.ProviderRegistry(profile, () => clock);
  const adapter = new Adapter();
  const descriptor = { id: 'metric', schema: structuredClone(schema) };
  owners.push({ registry, adapter });
  return { registry, adapter, descriptor, advance: value => { clock = value; } };
}
function register(item) {
  assert.equal(item.registry.register(item.descriptor, item.adapter).code, 'REGISTERED');
}
function fireTimers(delay) {
  // Trigger only this operation's owned timer; leave the global runner alone.
  for (const [callback, value] of [...firedTimers.values()]) if (value === delay) callback();
}
const firedTimers = new Map();
const trackedSet = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay) => {
  const timer = trackedSet(() => { firedTimers.delete(timer); callback(); }, delay);
  firedTimers.set(timer, [() => { globalThis.clearTimeout(timer); callback(); }, delay]);
  return timer;
};
const trackedClear = globalThis.clearTimeout;
globalThis.clearTimeout = timer => { firedTimers.delete(timer); trackedClear(timer); };

if (api) {
  test('registration and status are inert; readonly output projects schema fields and defensive copies', async () => {
    const item = subject(); register(item);
    item.descriptor.schema.fields[0].maximum = 1;
    item.adapter.result = { bytes: 64, phase: 'active', available: true,
      token: 'private-value', title: 'private-text', appended: { nested: 'private-value' } };
    assert.equal(item.adapter.calls, 0); assert.equal(item.adapter.closes, 0);
    assert.equal(item.registry.status()[0].state, 'registered');
    const result = await item.registry.capture('metric');
    assert.equal(result.code, 'CAPTURED');
    assert.deepEqual(result.fields, { bytes: 64, phase: 'active', available: true });
    assert.equal(result.rejectedFields, 3);
    assert.equal(result.source, 'adapter-reported');
    assert.equal(result.verification, 'unverified');
    result.fields.bytes = 1;
    assert.equal((await item.registry.capture('metric')).fields.bytes, 64);
    const status = item.registry.status(); status[0].id = 'changed';
    assert.equal(item.registry.status()[0].id, 'metric');
    assert(!JSON.stringify(item.registry.status()).includes('private-'));
  });
  test('Release profiles do not retain or call any Provider', async () => {
    for (const profile of ['release-none', 'release-core', 'invalid']) {
      const item = subject(profile);
      assert.equal(item.registry.register(item.descriptor, item.adapter).code, 'CAPABILITY_NOT_AVAILABLE');
      assert.equal((await item.registry.capture('metric')).code, 'CAPABILITY_NOT_AVAILABLE');
      assert.deepEqual(item.registry.status(), []);
      await item.registry.dispose();
      assert.equal(item.adapter.calls + item.adapter.closes, 0);
    }
    const item = subject('test'); register(item);
    assert.equal((await item.registry.capture('metric')).code, 'CAPTURED');
  });
  test('bad descriptors, duplicate IDs, registration budget and lifetime IDs remain bounded', async () => {
    const item = subject();
    const bad = structuredClone(item.descriptor); bad.schema.fields.push({ key: 'token', kind: 'boolean' });
    assert.equal(item.registry.register(bad, item.adapter).code, 'SCHEMA_INVALID');
    register(item);
    assert.equal(item.registry.register(item.descriptor, item.adapter).code, 'PROVIDER_CONFLICT');
    assert.equal((await item.registry.unregister('metric')).code, 'UNREGISTERED');
    assert.equal(item.registry.register(item.descriptor, item.adapter).code, 'PROVIDER_CONFLICT');
    for (let i = 1; i < 32; i++) {
      const adapter = new Adapter(); owners.push({ registry: item.registry, adapter });
      assert.equal(item.registry.register({ id: `metric${i}`, schema }, adapter).code, 'REGISTERED');
    }
    const adapter = new Adapter(); owners.push({ registry: item.registry, adapter });
    assert.equal(item.registry.register({ id: 'overflow', schema }, adapter).code, 'PROVIDER_QUOTA');
  });
  test('invalid fields and Adapter errors remain isolated without error text', async () => {
    const item = subject(); register(item);
    item.adapter.result = { bytes: Infinity, phase: 'free-text', available: 1 };
    const filtered = await item.registry.capture('metric');
    assert.equal(filtered.code, 'CAPTURED'); assert.deepEqual(filtered.fields, {});
    assert.equal(filtered.rejectedFields, 3);
    item.adapter.result = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field${i}`, true]));
    assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_FIELDS_INVALID');
    item.adapter.readError = true;
    const failed = await item.registry.capture('metric');
    assert.equal(failed.code, 'PROVIDER_READ_FAILED');
    assert(!JSON.stringify(failed).includes('private-'));
    assert.equal(item.registry.status()[0].reads, 3);
  });
  test('timeout retains pending read ownership and rejects late data before another capture', async () => {
    const item = subject(); register(item);
    item.adapter.pending = deferred();
    const capture = item.registry.capture('metric', 100);
    await item.adapter.started.promise;
    fireTimers(100);
    assert.equal((await capture).code, 'PROVIDER_TIMEOUT');
    assert.equal(item.registry.status()[0].pending, true);
    assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_BUSY');
    item.adapter.pending.resolve({ bytes: 99, token: 'private-late' });
    await item.adapter.pending.promise; await Promise.resolve(); await Promise.resolve();
    assert.equal(item.registry.status()[0].pending, false);
    item.adapter.pending = undefined;
    assert.equal((await item.registry.capture('metric')).fields.bytes, 64);
    assert.equal(item.adapter.calls, 2);
  });
  test('unregister cancels waiting, closes only after the native read settles and never resurrects', async () => {
    const item = subject(); register(item);
    item.adapter.pending = deferred();
    const capture = item.registry.capture('metric');
    await item.adapter.started.promise;
    assert.equal((await item.registry.unregister('metric')).code, 'PROVIDER_PENDING');
    assert.equal((await capture).code, 'PROVIDER_CANCELLED');
    assert.equal(item.adapter.closes, 0);
    assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_UNREGISTERED');
    item.adapter.pending.resolve({ bytes: 99 });
    await item.adapter.closed.promise; await Promise.resolve(); await Promise.resolve();
    assert.equal(item.adapter.closes, 1);
    assert.equal(item.registry.status()[0].state, 'unregistered');
    assert.equal((await item.registry.unregister('metric')).code, 'UNREGISTERED');
    assert.equal(item.adapter.closes, 1);
  });
  test('failed cleanup survives status/dispose and retries only on an explicit retry', async () => {
    const item = subject(); register(item); item.adapter.closeResult = false;
    assert.equal((await item.registry.unregister('metric')).code, 'PROVIDER_CLEANUP_REQUIRED');
    assert.equal(item.registry.status()[0].state, 'cleanup-required');
    item.registry.status();
    await item.registry.dispose();
    assert.equal(item.adapter.closes, 1);
    item.adapter.closeResult = true;
    assert.equal((await item.registry.retryCleanup('metric')).code, 'UNREGISTERED');
    assert.equal(item.adapter.closes, 2);
    assert.equal((await item.registry.capture('metric')).code, 'DISPOSED');
  });
  test('cleanup timeout retains its exact owner and late success cannot certify cleanup', async () => {
    const item = subject(); register(item); item.adapter.closePending = deferred();
    const unregister = item.registry.unregister('metric', 100);
    await item.adapter.closed.promise;
    fireTimers(100);
    assert.equal((await unregister).code, 'PROVIDER_CLEANUP_REQUIRED');
    assert.equal((await item.registry.retryCleanup('metric')).code, 'PROVIDER_PENDING');
    item.adapter.closePending.resolve(true);
    await item.adapter.closePending.promise; await Promise.resolve(); await Promise.resolve();
    assert.equal(item.registry.status()[0].state, 'cleanup-required');
    assert.equal(item.registry.status()[0].pending, false);
    item.adapter.closePending = undefined;
    assert.equal((await item.registry.retryCleanup('metric')).code, 'UNREGISTERED');
  });
  test('non-integer, reversed and unsafe clocks revoke grants without resetting lifetime quotas', async () => {
    for (const value of [NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, 999]) {
      const item = subject(); register(item); item.advance(value);
      assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_CLOCK_INVALID');
      item.advance(2000);
      assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_CLOCK_INVALID');
      assert.equal(item.adapter.calls, 0);
      await item.registry.dispose();
      assert.equal(item.adapter.closes, 1);
    }
  });
  test('capture completes after deadline only as timeout even before timer delivery', async () => {
    const item = subject(); register(item); item.adapter.pending = deferred();
    const capture = item.registry.capture('metric', 100);
    await item.adapter.started.promise; item.advance(1100);
    item.adapter.pending.resolve({ bytes: 77 });
    assert.equal((await capture).code, 'PROVIDER_TIMEOUT');
    assert.equal(item.registry.status()[0].pending, false);
  });
  test('read budget includes failures and cannot be reset by queries or unregister', async () => {
    const item = subject(); register(item); item.adapter.readError = true;
    for (let i = 0; i < 256; i++) {
      assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_READ_FAILED');
    }
    assert.equal((await item.registry.capture('metric')).code, 'PROVIDER_READ_QUOTA');
    assert.equal(item.adapter.calls, 256);
    assert.equal((await item.registry.capture('missing')).code, 'PROVIDER_UNAVAILABLE');
    assert.equal((await item.registry.capture('metric', 0)).code, 'PROVIDER_TIMEOUT_INVALID');
  });
  test('one Adapter cannot be owned by multiple IDs or resurrected after cleanup', async () => {
    const item = subject(); register(item);
    assert.equal(item.registry.register({ id: 'other', schema }, item.adapter).code, 'PROVIDER_OWNER_CONFLICT');
    await item.registry.unregister('metric');
    assert.equal(item.registry.register({ id: 'other', schema }, item.adapter).code, 'PROVIDER_OWNER_CONFLICT');
    assert.equal(item.adapter.closes, 1);
  });
  test('cleanup deadline starts at cleanup dispatch rather than the last capture', async () => {
    const item = subject(); register(item);
    assert.equal((await item.registry.capture('metric')).code, 'CAPTURED');
    item.advance(10000);
    assert.equal((await item.registry.unregister('metric', 100)).code, 'UNREGISTERED');
  });
  test('query observes deadline before timer delivery while retaining the native owner', async () => {
    const item = subject(); register(item); item.adapter.pending = deferred();
    let receipt;
    const capture = item.registry.capture('metric', 100).then(result => { receipt = result; });
    await item.adapter.started.promise; item.advance(1100);
    assert.equal(item.registry.status()[0].pending, true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(receipt?.code, 'PROVIDER_TIMEOUT');
    item.adapter.pending.resolve({ bytes: 99 }); await capture;
  });
  test('deadline overflow permanently closes grants even when a shorter timeout fits', async () => {
    const item = subject(); register(item); item.advance(Number.MAX_SAFE_INTEGER - 200);
    assert.equal((await item.registry.capture('metric', 1000)).code, 'PROVIDER_CLOCK_INVALID');
    assert.equal((await item.registry.capture('metric', 100)).code, 'PROVIDER_CLOCK_INVALID');
    assert.equal(item.adapter.calls, 0);
  });
}
