/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Executes actual portable ETS with private files and explicit surface Adapters.
// Adapter acceptance is not evidence of HarmonyOS window rendering.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-debug-test-'));
const owned = [];
const timers = new Map(), intervals = new Set();
const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
const nativeInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
globalThis.setTimeout = (callback, delay) => {
  const timer = nativeSet(() => { timers.delete(timer); callback(); }, delay);
  timers.set(timer, { callback, delay }); return timer;
};
globalThis.clearTimeout = timer => { timers.delete(timer); nativeClear(timer); };
globalThis.setInterval = (callback, delay) => {
  const timer = nativeInterval(callback, delay); intervals.add(timer); return timer;
};
globalThis.clearInterval = timer => { intervals.delete(timer); nativeClearInterval(timer); };
function fire(delay) {
  for (const [timer, item] of [...timers]) if (item.delay === delay) {
    globalThis.clearTimeout(timer); item.callback();
  }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function settled() {
  // Promise dispatch only, never a timing assumption about a native completion.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
let api;
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/api/debug.ets', import.meta.url))],
    outfile: path.join(directory, 'debug.mjs'), bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
  });
  api = await import(pathToFileURL(path.join(directory, 'debug.mjs')));
} catch (error) {
  console.error('public Debug entry unavailable:', error.errors?.[0]?.text ?? error.message);
}
class Files {
  sequence = 0; reads = 0; writes = 0; tick = 1000;
  now() { return { clockId: 'test-clock', bootId: 'test-boot', monotonicNs: this.tick * 1000000,
    wallTimeUtc: '2026-10-26T00:00:00.000Z' }; }
  random() { return 0; }
  sessionId() { return 'test-session'; }
  hash(text) { return createHash('sha256').update(text).digest('hex'); }
  hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
  byteLength(text) { return Buffer.byteLength(text); }
  async recover() { this.reads++; return []; }
  async recoverProblems() { this.reads++; return []; }
  async write(text) {
    const handle = await open(path.join(directory, `record-${++this.sequence}-${this.tag}.json`), 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    this.writes++;
  }
  async append(text) { await this.write(text); return 'synced'; }
  async saveProblem(id, text) { await this.write(text); return 'synced'; }
  async deleteProblem() { return true; }
}
class Surface {
  calls = []; outcomes = {}; pending = {}; started = new Map();
  call(name) {
    this.calls.push(name); this.started.get(name)?.resolve();
    if (this.outcomes[name] === 'throw') throw Error('private-surface-exception');
    return this.pending[name]?.promise ?? Promise.resolve(this.outcomes[name] ?? true);
  }
  attach() { return this.call('attach'); }
  openPanel() { return this.call('open'); }
  closePanel() { return this.call('close'); }
  showFloatingButton() { return this.call('show'); }
  hideFloatingButton() { return this.call('hide'); }
  detach() { return this.call('detach'); }
  defer(name) { this.pending[name] = deferred(); this.started.set(name, deferred()); return this.started.get(name).promise; }
}
const schema = { name: 'app.metric', fields: [{ key: 'count', kind: 'number', minimum: 0, maximum: 100 }] };
function subject(profile = 'debug') {
  assert(api?.OHMateDebug && api?.OHMateCore, 'single-package public Debug API must exist');
  const files = new Files(); files.tag = owned.length;
  const core = new api.OHMateCore(files);
  const runtime = new api.OHMateDebug(core, profile, () => files.tick);
  const surface = new Surface();
  const options = Object.assign(new api.CoreOptions(), { sampling: 1, flushIntervalMs: 60000 });
  const item = { files, core, runtime, surface, options, surfaces: [surface], providers: [] };
  owned.push(item); return item;
}
async function attach(item, id = 'main', surface = item.surface) {
  assert.equal((await item.runtime.attachWindow(id, surface)).code, 'WINDOW_ATTACHED');
}
after(async () => {
  for (const item of owned) {
    for (const surface of item.surfaces) {
      for (const pending of Object.values(surface.pending)) pending.resolve(true);
      surface.outcomes.detach = true;
    }
    await settled();
    for (const status of item.runtime.getWindows()) await item.runtime.retryWindowCleanup(status.windowId);
    for (const provider of item.providers) provider.pending?.resolve({});
    await item.runtime.dispose(); await item.core.dispose();
  }
  assert.equal(timers.size, 0, 'all Debug timeout owners must settle');
  assert.equal(intervals.size, 0, 'all composed Core heartbeat owners must settle');
  globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear;
  globalThis.setInterval = nativeInterval; globalThis.clearInterval = nativeClearInterval;
  await rm(directory, { recursive: true, force: true });
});
test('public Debug import and construction have no timers, windows or files', () => {
  const item = subject();
  assert.equal(item.files.reads + item.files.writes, 0);
  assert.deepEqual(item.runtime.getWindows(), []);
  assert.equal(item.surface.calls.length, 0);
  assert.equal(timers.size + intervals.size, 0);
});
test('start composes actual Core idempotently and never acquires a window', async () => {
  const item = subject();
  assert.equal(item.core.registerSchema(schema).code, 'REGISTERED');
  assert.equal((await item.runtime.start(item.options)).code, 'STARTED');
  const writes = item.files.writes;
  assert.equal((await item.runtime.start(item.options)).code, 'ALREADY_STARTED');
  assert.equal((await item.runtime.start(Object.assign(new api.CoreOptions(), { sampling: 0 }))).code,
    'START_OPTIONS_CONFLICT');
  assert.equal(item.files.writes, writes); assert.deepEqual(item.surface.calls, []);
});
test('Release and unknown profiles neither start Core nor dispatch surface or Provider effects', async () => {
  for (const profile of ['release-none', 'release-core', 'invalid']) {
    const item = subject(profile);
    assert.equal((await item.runtime.start()).code, 'CAPABILITY_NOT_AVAILABLE');
    assert.equal((await item.runtime.attachWindow('main', item.surface)).code, 'CAPABILITY_NOT_AVAILABLE');
    assert.equal((await item.runtime.openPanel('main')).code, 'CAPABILITY_NOT_AVAILABLE');
    assert.deepEqual(item.runtime.getWindows(), []);
    assert.equal(item.files.writes + item.files.reads + item.surface.calls.length, 0);
  }
});
test('facade records, creates, reviews and exports actual schema-redacted Core ZIP bytes', async () => {
  const item = subject('test'); item.core.registerSchema(schema); await item.runtime.start(item.options);
  assert.equal(item.runtime.mark('app.metric', { count: 42, token: 'private-value' }).code, 'RECORDED');
  const created = await item.runtime.createProblem(); assert.equal(created.code, 'PROBLEM_CREATED');
  assert.equal(item.runtime.listProblems().length, 1);
  assert.equal(item.runtime.getHealth().buildVerification, 'unverified-build');
  const review = item.runtime.reviewArchive(created.problemId); assert.equal(review.code, 'ARCHIVE_REVIEWED');
  const result = item.runtime.exportArchive(created.problemId, review.reviewHash);
  assert.equal(result.code, 'ARCHIVE_EXPORTED');
  assert.equal(Buffer.from(result.archive).readUInt32LE(), 0x04034b50);
  assert(!Buffer.from(result.archive).includes(Buffer.from('private-value')));
  result.archive.fill(0);
  assert.equal(item.runtime.exportArchive(created.problemId, review.reviewHash).archive[0], 0x50);
});
test('window attach is explicit and idempotent; same-window and shared-host conflicts stay inert', async () => {
  const item = subject(); await attach(item); await attach(item);
  assert.deepEqual(item.surface.calls, ['attach']);
  const other = new Surface(); item.surfaces.push(other);
  assert.equal((await item.runtime.attachWindow('main', other)).code, 'WINDOW_CONFLICT');
  assert.equal((await item.runtime.attachWindow('other', item.surface)).code, 'WINDOW_OWNER_CONFLICT');
  assert.deepEqual(other.calls, []);
});
test('panel and floating controls are idempotent and detach clears the exact surface only', async () => {
  const item = subject(); await attach(item);
  for (let i = 0; i < 2; i++) assert.equal((await item.runtime.openPanel('main')).code, 'PANEL_OPEN');
  for (let i = 0; i < 2; i++) assert.equal((await item.runtime.closePanel('main')).code, 'PANEL_CLOSED');
  for (let i = 0; i < 2; i++) assert.equal((await item.runtime.showFloatingButton('main')).code, 'FLOATING_VISIBLE');
  for (let i = 0; i < 2; i++) assert.equal((await item.runtime.hideFloatingButton('main')).code, 'FLOATING_HIDDEN');
  assert.equal((await item.runtime.detachWindow('main')).code, 'WINDOW_DETACHED');
  assert.equal((await item.runtime.detachWindow('main')).code, 'WINDOW_DETACHED');
  assert.deepEqual(item.surface.calls, ['attach', 'open', 'close', 'show', 'hide', 'detach']);
  assert.equal((await item.runtime.openPanel('main')).code, 'WINDOW_UNAVAILABLE');
});
test('multiple windows need an explicit target and a detach does not stop Core', async () => {
  const item = subject(); item.core.registerSchema(schema); await item.runtime.start(item.options);
  await attach(item); const second = new Surface(); item.surfaces.push(second); await attach(item, 'second', second);
  assert.equal((await item.runtime.openPanel()).code, 'WINDOW_AMBIGUOUS');
  await item.runtime.openPanel('second'); await item.runtime.detachWindow('main');
  assert.deepEqual(second.calls, ['attach', 'open']);
  assert.equal(item.runtime.mark('app.metric', { count: 1 }).code, 'RECORDED');
});
test('surface failures do not stop Core or publish exception text or claim a rendered panel', async () => {
  const item = subject(); item.core.registerSchema(schema); await item.runtime.start(item.options); await attach(item);
  item.surface.outcomes.open = 'throw';
  const failed = await item.runtime.openPanel('main');
  assert.equal(failed.code, 'WINDOW_CLEANUP_REQUIRED');
  assert.equal(item.runtime.getWindows()[0].state, 'cleanup-required');
  assert(!JSON.stringify(failed).includes('private-'));
  assert(!JSON.stringify(item.runtime.getWindows()).includes('private-'));
  assert.equal(item.runtime.mark('app.metric', { count: 2 }).code, 'RECORDED');
});
test('detach cancels an in-flight attach and waits for its native owner before cleanup', async () => {
  const item = subject(); const started = item.surface.defer('attach');
  const operation = item.runtime.attachWindow('main', item.surface); await started;
  assert.equal((await item.runtime.detachWindow('main')).code, 'WINDOW_PENDING');
  assert.equal((await operation).code, 'WINDOW_CANCELLED');
  assert.deepEqual(item.surface.calls, ['attach']);
  item.surface.pending.attach.resolve(true); await settled();
  assert.deepEqual(item.surface.calls, ['attach', 'detach']);
  assert.equal(item.runtime.getWindows()[0].state, 'detached');
});
test('timeout retains the native surface and late success cannot revive attachment', async () => {
  const item = subject(); const started = item.surface.defer('attach');
  const operation = item.runtime.attachWindow('main', item.surface, 100); await started;
  fire(100); assert.equal((await operation).code, 'WINDOW_TIMEOUT');
  assert.equal(item.runtime.getWindows()[0].pending, true);
  assert.equal((await item.runtime.retryWindowCleanup('main')).code, 'WINDOW_PENDING');
  item.surface.pending.attach.resolve(true); await settled();
  assert.equal(item.runtime.getWindows()[0].state, 'cleanup-required');
  assert.equal((await item.runtime.openPanel('main')).code, 'WINDOW_CLEANUP_REQUIRED');
  assert.equal((await item.runtime.retryWindowCleanup('main')).code, 'WINDOW_DETACHED');
});
test('failed cleanup only retries explicitly, including after disposal', async () => {
  const item = subject(); await attach(item); item.surface.outcomes.detach = false;
  assert.equal((await item.runtime.detachWindow('main')).code, 'WINDOW_CLEANUP_REQUIRED');
  item.runtime.getWindows(); item.runtime.getWindows(); await item.runtime.dispose();
  assert.equal(item.surface.calls.filter(name => name === 'detach').length, 1);
  item.surface.outcomes.detach = true;
  assert.equal((await item.runtime.retryWindowCleanup('main')).code, 'WINDOW_DETACHED');
  assert.equal((await item.runtime.attachWindow('main', item.surface)).code, 'DISPOSED');
});
test('cleanup timeout and late acceptance retain responsibility until a fresh explicit cleanup', async () => {
  const item = subject(); await attach(item); const started = item.surface.defer('detach');
  const close = item.runtime.detachWindow('main', 100); await started; fire(100);
  assert.equal((await close).code, 'WINDOW_CLEANUP_REQUIRED');
  item.surface.pending.detach.resolve(true); await settled();
  assert.equal(item.runtime.getWindows()[0].state, 'cleanup-required');
  assert.equal(item.runtime.getWindows()[0].pending, false);
  delete item.surface.pending.detach;
  assert.equal((await item.runtime.retryWindowCleanup('main')).code, 'WINDOW_DETACHED');
});
test('queries observe deadlines before timer delivery without releasing native ownership', async () => {
  const item = subject(); await attach(item); const started = item.surface.defer('open');
  let receipt;
  const operation = item.runtime.openPanel('main', 100).then(value => { receipt = value; });
  await started; item.files.tick += 100;
  assert.equal(item.runtime.getWindows()[0].pending, true); await settled();
  assert.equal(receipt.code, 'WINDOW_TIMEOUT');
  item.surface.pending.open.resolve(true); await operation;
});
test('clock rollback and deadline overflow permanently close window grants', async () => {
  for (const clock of [999, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER - 10]) {
    const item = subject(); await attach(item); item.files.tick = clock;
    assert.equal((await item.runtime.openPanel('main', 100)).code, 'WINDOW_CLOCK_INVALID');
    item.files.tick = 2000;
    assert.equal((await item.runtime.openPanel('main', 100)).code, 'WINDOW_CLOCK_INVALID');
    assert.deepEqual(item.surface.calls, ['attach']);
    assert.equal((await item.runtime.retryWindowCleanup('main')).code, 'WINDOW_DETACHED');
  }
});
test('readonly Providers use the same package registry and dispose cancels pending capture', async () => {
  const item = subject(); let reads = 0, closes = 0; const pending = deferred();
  const provider = { pending, read() { reads++; return pending.promise; }, close() { closes++; return Promise.resolve(true); } };
  item.providers.push(provider);
  assert.equal(item.runtime.registerProvider({ id: 'metric', schema }, provider).code, 'REGISTERED');
  assert.equal(reads, 0);
  const capture = item.runtime.captureProvider('metric'); await settled();
  await item.runtime.dispose(); assert.equal((await capture).code, 'PROVIDER_CANCELLED');
  assert.equal(closes, 0); pending.resolve({ count: 4, token: 'private-value' }); await settled();
  assert.equal(closes, 1); assert.equal((await item.runtime.captureProvider('metric')).code, 'DISPOSED');
});
test('window limits, invalid IDs and wait budgets do not acquire rejected hosts', async () => {
  const item = subject();
  assert.equal((await item.runtime.attachWindow('../private', item.surface)).code, 'WINDOW_ID_INVALID');
  assert.equal((await item.runtime.attachWindow('main', item.surface, 0)).code, 'WINDOW_TIMEOUT_INVALID');
  for (let i = 0; i < 32; i++) {
    const surface = new Surface(); item.surfaces.push(surface); await attach(item, 'window' + i, surface);
  }
  assert.equal((await item.runtime.attachWindow('overflow', item.surface)).code, 'WINDOW_QUOTA');
  assert.equal(item.surface.calls.length, 0);
  const statuses = item.runtime.getWindows(); statuses[0].windowId = 'changed';
  assert.equal(item.runtime.getWindows()[0].windowId, 'window0');
});
test('Core controls, pruning and problem deletion delegate through the same instance', async () => {
  const item = subject(); item.core.registerSchema(schema); await item.runtime.start(item.options);
  assert.equal(item.runtime.pause().code, 'PAUSED');
  assert.equal(item.runtime.mark('app.metric', { count: 1 }).code, 'PAUSED');
  assert.equal(item.runtime.recordFault('oom').code, 'RECORDED');
  assert.equal(item.runtime.resume().code, 'RESUMED');
  assert.equal((await item.runtime.flush()).code, 'FLUSHED');
  const created = await item.runtime.createProblem();
  assert.equal(item.runtime.getProblem(created.problemId).replay, 'manual-only');
  assert.equal((await item.runtime.deleteProblem(created.problemId)).code, 'PROBLEM_DELETED');
  assert.equal(item.runtime.listProblems().length, 0);
  assert.equal((await item.runtime.prune()).code, 'PRUNE_UNAVAILABLE');
  assert.equal((await item.runtime.stopNormally()).code, 'CLOSED');
});
test('Provider cleanup remains explicitly accessible through Debug after disposal', async () => {
  const item = subject(); let closeResult = false, closes = 0;
  const provider = { read() { return Promise.resolve({ count: 1 }); },
    close() { closes++; return Promise.resolve(closeResult); } };
  item.providers.push(provider);
  item.runtime.registerProvider({ id: 'metric', schema }, provider);
  assert.equal(item.runtime.getProviders()[0].state, 'registered');
  assert.equal((await item.runtime.unregisterProvider('metric')).code, 'PROVIDER_CLEANUP_REQUIRED');
  await item.runtime.dispose(); assert.equal(closes, 1);
  closeResult = true;
  assert.equal((await item.runtime.retryProviderCleanup('metric')).code, 'UNREGISTERED');
  assert.equal(closes, 2);
});
test('a detached window may be explicitly reacquired by a fresh owner without resetting lifetime quota', async () => {
  const item = subject(); await attach(item); await item.runtime.detachWindow('main');
  const fresh = new Surface(); item.surfaces.push(fresh); await attach(item, 'main', fresh);
  assert.equal(item.runtime.getWindows().length, 1);
  assert.equal(item.runtime.getWindows()[0].state, 'attached');
  await item.runtime.openPanel('main');
  assert.deepEqual(item.surface.calls, ['attach', 'detach']);
  assert.deepEqual(fresh.calls, ['attach', 'open']);
});
test('window attempt limits cannot be reset by controls or status and never block cleanup', async () => {
  const item = subject(); await attach(item);
  for (let i = 0; i < 255; i++) {
    assert.equal((await (i % 2 ? item.runtime.closePanel('main') : item.runtime.openPanel('main'))).code,
      i % 2 ? 'PANEL_CLOSED' : 'PANEL_OPEN');
  }
  item.runtime.getWindows();
  assert.equal((await item.runtime.closePanel('main')).code, 'WINDOW_ACTION_QUOTA');
  assert.equal(item.surface.calls.length, 256);
  assert.equal((await item.runtime.detachWindow('main')).code, 'WINDOW_DETACHED');
});
test('configuration updates share lifetime effect quotas and unsupported Adapters stay inert', async () => {
  const item = subject(); await attach(item);
  assert.equal(item.runtime.updateConfiguration('main').code, 'CAPABILITY_NOT_AVAILABLE');
  assert.equal(item.runtime.getWindows()[0].attempts, 1);
  let updates = 0; item.surface.updateConfiguration = () => { updates++; return true; };
  for (let i = 0; i < 255; i++) assert.equal(item.runtime.updateConfiguration('main').code, 'CONFIGURATION_UPDATED');
  assert.equal(item.runtime.updateConfiguration('main').code, 'WINDOW_ACTION_QUOTA');
  assert.equal(updates, 255); assert.equal(item.runtime.getWindows()[0].attempts, 256);
  assert.equal((await item.runtime.detachWindow('main')).code, 'WINDOW_DETACHED');
});
test('reentrant configuration cannot overlap or detach its original native node before return', async () => {
  const item = subject(); await attach(item); const calls = [];
  item.surface.updateConfiguration = () => {
    calls.push('start');
    assert.equal(item.runtime.updateConfiguration('main').code, 'WINDOW_BUSY');
    item.runtime.detachWindow('main').then(result => calls.push(result.code));
    assert(!item.surface.calls.includes('detach'), 'native update still owns the node');
    calls.push('end'); return true;
  };
  assert.equal(item.runtime.updateConfiguration('main').code, 'WINDOW_CLEANUP_REQUIRED');
  await settled();
  assert.deepEqual(calls, ['start', 'end', 'WINDOW_PENDING']);
  assert.equal(item.runtime.getWindows()[0].state, 'detached');
});
