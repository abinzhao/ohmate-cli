/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-archive-save-'));
let api;
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/host-integration/ArchiveSaveOwner.ets', import.meta.url))],
    outfile: path.join(directory, 'owner.mjs'), bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
  });
  api = await import(pathToFileURL(path.join(directory, 'owner.mjs')));
} catch (error) { console.error('actual archive save owner unavailable:', error.errors?.[0]?.text ?? error.message); }
const subjects = [];
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
};
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
class Host {
  calls = []; selected = true; closeOkay = true; writeOkay = true;
  pickPending; writePending; closePending; copied;
  async pick(name) {
    this.calls.push(['pick', name]);
    if (this.pickPending) await this.pickPending.promise;
    return this.selected;
  }
  async write(bytes, current) {
    this.calls.push(['write']); this.copied = bytes.slice();
    if (this.writePending) await this.writePending.promise;
    if (!current()) return false;
    return this.writeOkay;
  }
  async close() {
    this.calls.push(['close']);
    if (this.closePending) await this.closePending.promise;
    return this.closeOkay;
  }
}
function subject() {
  assert(api?.ArchiveSaveOwner, 'actual ETS owner required');
  const host = new Host(), state = { now: 100, current: true };
  const owner = new api.ArchiveSaveOwner(host, () => state.now);
  const item = { host, state, owner, save: (bytes = new Uint8Array([80, 75, 3, 4]), timeout = 30000) =>
    owner.save(bytes, 'problem-1.ohmate-problem.zip', () => state.current, timeout) };
  subjects.push(item); return item;
}
after(async () => {
  for (const item of subjects) {
    item.host.closeOkay = true; item.host.pickPending?.resolve();
    item.host.writePending?.resolve(); item.host.closePending?.resolve();
    item.owner.cancel(); await settle();
    assert.equal(await item.owner.retryCleanup(), true, 'explicit cleanup must release every original host');
    assert.equal(item.owner.getState(), 'idle');
  }
  await rm(directory, { recursive: true, force: true });
});
test('construction is inert; successful save copies bytes, closes and reports only host acceptance', async () => {
  const item = subject(); assert.equal(item.host.calls.length, 0);
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const saving = item.save(bytes); bytes.fill(0);
  assert.equal(await saving, 'SAVE_HOST_REPORTED');
  assert.deepEqual([...item.host.copied], [80, 75, 3, 4]);
  assert.deepEqual(item.host.calls.map(call => call[0]), ['pick', 'write', 'close']);
  assert.equal(item.owner.getState(), 'idle');
});
test('invalid names, sizes, budgets and missing current grant never open Picker', async () => {
  const item = subject();
  for (const [bytes, name, timeout] of [
    [new Uint8Array(0), 'p.ohmate-problem.zip', 1000],
    [new Uint8Array(262145), 'p.ohmate-problem.zip', 1000],
    [new Uint8Array(1), '../p.ohmate-problem.zip', 1000],
    [new Uint8Array(1), 'p.ohmate-problem.zip', 99],
  ]) assert.equal(await item.owner.save(bytes, name, () => true, timeout), 'SAVE_INVALID');
  item.state.current = false; assert.equal(await item.save(), 'SAVE_UNAVAILABLE');
  assert.equal(item.host.calls.length, 0);
});
test('cancelled pending Picker retains original owner; late URI never starts a write or implicit cleanup', async () => {
  const item = subject(); item.host.pickPending = deferred();
  const saving = item.save(); assert.equal(item.owner.getState(), 'busy');
  item.owner.cancel(); assert.equal(await saving, 'SAVE_CANCELLED');
  assert.equal(await item.save(), 'SAVE_CLEANUP_REQUIRED');
  assert.equal(await item.owner.retryCleanup(), false, 'cannot close a pending Picker');
  item.host.pickPending.resolve(); await settle();
  assert.deepEqual(item.host.calls.map(call => call[0]), ['pick']);
  assert.equal(item.owner.getState(), 'cleanup-required');
  assert.equal(await item.owner.retryCleanup(), true);
  assert.deepEqual(item.host.calls.map(call => call[0]), ['pick', 'close']);
});
test('a background grant change while selecting cannot write or revive on foreground return', async () => {
  const item = subject(); item.host.pickPending = deferred();
  const saving = item.save(); item.state.current = false; item.owner.cancel();
  item.state.current = true; item.host.pickPending.resolve();
  assert.equal(await saving, 'SAVE_CANCELLED'); await settle();
  assert.equal(item.host.calls.filter(call => call[0] === 'write').length, 0);
  assert.equal(await item.owner.retryCleanup(), true);
});
test('cancelled pending writes remain owned and only retry close; retries never write again', async () => {
  const item = subject(); item.host.writePending = deferred();
  const saving = item.save(); await settle();
  assert.equal(item.host.calls.filter(call => call[0] === 'write').length, 1);
  item.owner.cancel(); assert.equal(await saving, 'SAVE_CANCELLED');
  assert.equal(await item.owner.retryCleanup(), false);
  item.host.writePending.resolve(); await settle();
  assert.equal(await item.owner.retryCleanup(), true);
  assert.equal(item.host.calls.filter(call => call[0] === 'write').length, 1);
});
test('failed close keeps exact owner; status and competing saves never silently retry', async () => {
  const item = subject(); item.host.closeOkay = false;
  assert.equal(await item.save(), 'SAVE_CLEANUP_REQUIRED');
  const calls = item.host.calls.length;
  assert.equal(item.owner.getState(), 'cleanup-required');
  assert.equal(await item.save(), 'SAVE_CLEANUP_REQUIRED'); assert.equal(item.host.calls.length, calls);
  assert.equal(await item.owner.retryCleanup(), false);
  item.host.closeOkay = true; assert.equal(await item.owner.retryCleanup(), true);
  assert.equal(item.host.calls.filter(call => call[0] === 'write').length, 1);
});
test('user cancellation and write failure never claim saved; failed writes are not automatically resumed', async () => {
  const cancelled = subject(); cancelled.host.selected = false;
  assert.equal(await cancelled.save(), 'SAVE_CANCELLED');
  assert.equal(cancelled.host.calls.filter(call => call[0] === 'write').length, 0);
  const failure = subject(); failure.host.writeOkay = false;
  assert.equal(await failure.save(), 'SAVE_FAILED');
  assert.equal(failure.owner.getState(), 'idle');
  assert.equal(await failure.owner.retryCleanup(), true);
  assert.equal(failure.host.calls.filter(call => call[0] === 'write').length, 1);
});
test('timeout seals the current attempt without closing pending native work or auto-resuming it', async () => {
  const item = subject(); item.host.pickPending = deferred();
  assert.equal(await item.save(undefined, 100), 'SAVE_TIMEOUT');
  assert.equal(item.owner.getState(), 'cleanup-required');
  item.host.pickPending.resolve(); await settle();
  assert.equal(item.host.calls.length, 1);
  assert.equal(await item.owner.retryCleanup(), true);
});
test('expiry observed at close completion cannot publish saved or silently discharge cancellation', async () => {
  const item = subject(); item.host.closePending = deferred();
  const saving = item.save(undefined, 1000); await settle();
  assert.equal(item.host.calls.at(-1)[0], 'close');
  item.state.now = 1100; item.host.closePending.resolve();
  assert.notEqual(await saving, 'SAVE_HOST_REPORTED');
  assert.equal(item.owner.getState(), 'cleanup-required');
  assert.equal(await item.owner.retryCleanup(), true);
});
test('explicit cleanup has a bounded wait and retains pending/late native close for another explicit retry', async () => {
  const item = subject(); item.host.closeOkay = false;
  assert.equal(await item.save(), 'SAVE_CLEANUP_REQUIRED');
  item.host.closeOkay = true; item.host.closePending = deferred();
  assert.equal(await item.owner.retryCleanup(100), false);
  assert.equal(await item.owner.retryCleanup(), false, 'pending native close is still owned');
  item.host.closePending.resolve(); await settle();
  assert.equal(item.owner.getState(), 'cleanup-required', 'late close is not a successful user retry');
  assert.equal(await item.owner.retryCleanup(), true);
});
test('backward/noninteger clocks permanently close new save grants and retain pending cleanup', async () => {
  for (const clock of [99, NaN, 1.5]) {
    const item = subject(); item.host.pickPending = deferred();
    const saving = item.save(); item.state.now = clock;
    assert.equal(item.owner.getState(), 'cleanup-required');
    assert.equal(await saving, 'SAVE_CANCELLED');
    item.state.now = 101; item.host.pickPending.resolve(); await settle();
    assert.equal(await item.owner.retryCleanup(), true);
    assert.equal(await item.save(), 'SAVE_UNAVAILABLE');
  }
});
test('lifetime attempts include failures; cleanup has a reserved lane after the save budget is exhausted', async () => {
  const item = subject(); item.host.selected = false;
  for (let index = 0; index < 256; index++) assert.equal(await item.save(), 'SAVE_CANCELLED');
  assert.equal(await item.save(), 'SAVE_QUOTA');
  assert.equal(await item.owner.retryCleanup(), true);
  assert.equal(item.host.calls.filter(call => call[0] === 'pick').length, 256);
});
