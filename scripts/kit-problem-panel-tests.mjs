/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Actual panel/Core/save ETS. Private files and a save Adapter do not certify UI.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-problem-panel-'));
const root = fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/', import.meta.url));
const entry = path.join(directory, 'entry.ts'), owned = [];
await writeFile(entry, [
  `export * from ${JSON.stringify(root + 'api/core.ets')};`,
  `export * from ${JSON.stringify(root + 'host-integration/ArchiveSaveOwner.ets')};`,
  `export * from ${JSON.stringify(root + 'host-integration/ProblemPanelModel.ets')};`,
].join('\n'), { flag: 'wx', mode: 0o600 });
let api;
try {
  await build({ entryPoints: [entry], outfile: path.join(directory, 'panel.mjs'),
    bundle: true, platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
    plugins: [{ name: 'portable-observation', setup(builder) {
      builder.onLoad({ filter: /ProblemPanelModel\.ets$/ }, async args => ({
        contents: (await readFile(args.path, 'utf8')).replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, ''),
        loader: 'ts',
      }));
    } }],
  });
  api = await import(pathToFileURL(path.join(directory, 'panel.mjs')));
} catch (error) { console.error('actual panel unavailable:', error.errors?.[0]?.text ?? error.message); }
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Files {
  tick = 1000; sequence = 0; deletion = true; deletePending; calls = [];
  now() { return { clockId: 'panel-clock', bootId: 'panel-session', monotonicNs: this.tick * 1000000,
    wallTimeUtc: '2026-10-26T00:00:00.000Z' }; }
  random() { return 0; }
  sessionId() { return 'panel-session'; }
  hash(text) { return createHash('sha256').update(text).digest('hex'); }
  hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
  byteLength(text) { return Buffer.byteLength(text); }
  async recover() { return []; }
  async recoverProblems() { return []; }
  async append(text) {
    this.calls.push('append');
    await writeFile(path.join(directory, this.tag + '-' + (++this.sequence) + '.json'), text,
      { flag: 'wx', mode: 0o600 }); return 'synced';
  }
  async saveProblem(id, text) { return this.append(text); }
  async deleteProblem(id) {
    this.calls.push(['delete', id]); if (this.deletePending) await this.deletePending.promise;
    return this.deletion;
  }
}
class SaveHost {
  calls = []; pending; closeOkay = true; archive;
  async pick(name) { this.calls.push(['pick', name]); if (this.pending) await this.pending.promise; return true; }
  async write(bytes, current) {
    assert(current()); this.calls.push(['write']); this.archive = bytes.slice();
    await writeFile(path.join(directory, this.tag + '.zip'), bytes, { flag: 'wx', mode: 0o600 }); return current();
  }
  async close() { this.calls.push(['close']); return this.closeOkay; }
}
function subject() {
  assert(api?.ProblemPanelModel, 'actual problem panel ETS required');
  const files = new Files(), host = new SaveHost(), state = { live: true };
  files.tag = host.tag = 'panel-' + owned.length;
  const core = new api.OHMateCore(files), save = new api.ArchiveSaveOwner(host, () => files.tick);
  const panel = new api.ProblemPanelModel(core, save, () => files.tick, () => state.live);
  const item = { files, host, state, core, save, panel }; owned.push(item); return item;
}
async function prepare(item) {
  const options = new api.CoreOptions(); options.sampling = 1; options.flushIntervalMs = 60000;
  item.core.registerSchema({ name: 'app.metric',
    fields: [{ key: 'count', kind: 'number', minimum: 0, maximum: 100 }] });
  assert.equal((await item.core.start(options)).code, 'STARTED');
  item.core.mark('app.metric', { count: 42, token: 'private-token', path: '/private-value' });
  item.core.recordFault('freeze');
  const created = await item.core.createProblem(); assert.equal(created.code, 'PROBLEM_CREATED');
  assert.equal(item.panel.select(created.problemId), 'PANEL_SELECTED'); return created.problemId;
}
after(async () => {
  for (const item of owned) {
    item.panel.dispose(); item.host.pending?.resolve(); item.files.deletePending?.resolve();
    await settle(); item.host.closeOkay = true; await item.panel.retryCleanup(); await item.core.dispose();
    assert.equal(item.panel.getState(), 'idle', 'no original native responsibility remains');
  }
  await rm(directory, { recursive: true, force: true });
});
test('construction/select are inert, bounded and do not expose event values or paths', async () => {
  const item = subject(); assert.deepEqual(item.files.calls, []); assert.deepEqual(item.host.calls, []);
  const id = await prepare(item);
  assert.equal(item.panel.selectedId, id); assert(item.panel.eventCount >= 3);
  assert.equal(item.panel.triageFault, 'freeze'); assert.equal(item.panel.triageConfidence, 'single-reported-clue');
  const visible = JSON.stringify(Object.fromEntries(Object.entries(item.panel)
    .filter(([key]) => ['selectedId', 'eventCount', 'dropped', 'criticalDropped', 'lossFirst', 'lossLast',
      'triageFault', 'triageConfidence', 'archiveFiles', 'fieldNames', 'confirmation', 'resultCode'].includes(key))));
  assert(!visible.includes('42')); assert(!visible.includes('private-token')); assert(!visible.includes('/private-value'));
  assert.deepEqual(item.host.calls, []);
});
test('review shows file/field names; only separate confirm saves real Core ZIP', async () => {
  const item = subject(), id = await prepare(item);
  assert.equal(await item.panel.confirmExport(), 'PANEL_CONFIRM_REQUIRED'); assert.deepEqual(item.host.calls, []);
  assert.equal(item.panel.reviewExport(), 'PANEL_EXPORT_REVIEWED');
  assert.equal(item.panel.confirmation, 'export');
  assert.deepEqual(item.panel.archiveFiles, ['manifest.json', 'core-summary.json',
    'schemas/manifest.schema.json', 'schemas/core-summary.schema.json']);
  assert(item.panel.fieldNames.includes('app.metric.count')); assert(!JSON.stringify(item.panel.fieldNames).includes('42'));
  assert.deepEqual(item.host.calls, []);
  assert.equal(await item.panel.confirmExport(), 'SAVE_HOST_REPORTED');
  assert.equal(Buffer.from(item.host.archive).readUInt32LE(), 0x04034b50);
  assert(!Buffer.from(item.host.archive).includes(Buffer.from('private-token')));
  assert.deepEqual(item.host.calls.map(call => call[0]), ['pick', 'write', 'close']);
  assert.equal(item.host.calls[0][1], id + '.ohmate-problem.zip');
  assert.equal(await item.panel.confirmExport(), 'PANEL_CONFIRM_REQUIRED');
});
test('missing or changed selection clears the previous detail and export grant', async () => {
  const item = subject(); await prepare(item); item.panel.reviewExport();
  assert.equal(item.panel.select('problem-missing'), 'PANEL_UNAVAILABLE');
  assert.equal(item.panel.selectedId, ''); assert.equal(item.panel.eventCount, 0);
  assert.deepEqual(item.panel.archiveFiles, []); assert.equal(item.panel.confirmation, 'none');
  assert.equal(await item.panel.confirmExport(), 'PANEL_CONFIRM_REQUIRED'); assert.deepEqual(item.host.calls, []);
});
test('30-second expiry, rollback, unsafe clock and revoked window reject confirmation before Picker', async () => {
  for (const variant of ['expired', 'rollback', 'unsafe', 'hidden']) {
    const item = subject(); await prepare(item); item.panel.reviewExport();
    if (variant === 'expired') item.files.tick += 30000;
    if (variant === 'rollback') item.files.tick--;
    if (variant === 'unsafe') item.files.tick = Number.MAX_SAFE_INTEGER + 1;
    if (variant === 'hidden') item.state.live = false;
    assert.notEqual(await item.panel.confirmExport(), 'SAVE_HOST_REPORTED');
    assert.deepEqual(item.host.calls, [], variant);
    if (['rollback', 'unsafe'].includes(variant)) {
      item.files.tick = 1000; assert.equal(item.panel.reviewExport(), 'PANEL_UNAVAILABLE');
    }
  }
});
test('suspend/resume, cancel and dispose never restore old confirmation', async () => {
  for (const action of ['suspend', 'cancel', 'dispose']) {
    const item = subject(); await prepare(item); item.panel.reviewExport(); item.panel[action](); item.panel.resume();
    assert.equal(await item.panel.confirmExport(), 'PANEL_CONFIRM_REQUIRED'); assert.deepEqual(item.host.calls, []);
  }
});
test('Core invalidation after review and wrong exported hash never open a Picker', async () => {
  const item = subject(); const id = await prepare(item); item.panel.reviewExport();
  await item.core.deleteProblem(id); assert.notEqual(await item.panel.confirmExport(), 'SAVE_HOST_REPORTED');
  assert.deepEqual(item.host.calls, []);
  const second = subject(); await prepare(second); second.panel.reviewExport();
  const original = second.core.exportArchive.bind(second.core);
  second.core.exportArchive = (...args) => { const result = original(...args); result.reviewHash = '0'.repeat(64); return result; };
  assert.equal(await second.panel.confirmExport(), 'PANEL_UNAVAILABLE'); assert.deepEqual(second.host.calls, []);
});
test('cancel during Picker ends waiting but late URI cannot write, clean itself or release the original lane', async () => {
  const item = subject(); await prepare(item); item.panel.reviewExport(); item.host.pending = deferred();
  const operation = item.panel.confirmExport(); await settle(); assert.equal(item.host.calls[0][0], 'pick');
  item.panel.cancel(); assert.equal(await operation, 'SAVE_CANCELLED');
  assert.equal(item.panel.getState(), 'cleanup-required'); assert.equal(await item.panel.retryCleanup(), false);
  item.host.pending.resolve(); await settle(); assert.deepEqual(item.host.calls.map(call => call[0]), ['pick']);
  assert.equal(item.panel.getState(), 'cleanup-required'); assert.equal(await item.panel.retryCleanup(), true);
  assert.deepEqual(item.host.calls.map(call => call[0]), ['pick', 'close']);
});
test('confirmation cannot be shared between two current windows and busy review cannot replace pending approval', async () => {
  const item = subject(), id = await prepare(item), otherHost = new SaveHost(); otherHost.tag = 'other-window';
  const other = new api.ProblemPanelModel(item.core, new api.ArchiveSaveOwner(otherHost, () => item.files.tick),
    () => item.files.tick, () => true);
  other.select(id); item.panel.reviewExport(); assert.equal(await other.confirmExport(), 'PANEL_CONFIRM_REQUIRED');
  item.host.pending = deferred(); const operation = item.panel.confirmExport(); await settle();
  assert.equal(item.panel.reviewExport(), 'PANEL_BUSY'); assert.equal(item.panel.reviewDelete(), 'PANEL_BUSY');
  item.panel.cancel(); await operation; item.host.pending.resolve(); await settle();
  assert.deepEqual(otherHost.calls, []); other.dispose();
});
test('delete uses independent confirmation and uncertain deletion retains capacity and original retry target', async () => {
  const item = subject(), id = await prepare(item), cost = item.core.getHealth().problemBytes;
  item.panel.reviewExport(); assert.equal(await item.panel.confirmDelete(), 'PANEL_CONFIRM_REQUIRED');
  item.files.deletion = false; assert.equal(item.panel.reviewDelete(), 'PANEL_DELETE_REVIEWED');
  assert.equal(await item.panel.confirmDelete(), 'PROBLEM_DELETE_UNCERTAIN');
  assert.equal(item.core.getHealth().problemBytes, cost); assert.equal(item.panel.deleteUncertain, true);
  assert.equal(item.panel.selectedId, id); assert.deepEqual(item.host.calls, []);
  assert.equal(item.panel.select(id), 'PANEL_DELETE_UNCERTAIN');
  assert.equal(item.panel.selectedId, id); assert.equal(item.panel.deleteUncertain, true);
  item.files.deletion = true; assert.equal(item.panel.reviewDelete(), 'PANEL_DELETE_REVIEWED');
  assert.equal(await item.panel.confirmDelete(), 'PROBLEM_DELETED');
  assert.equal(item.panel.selectedId, ''); assert.equal(item.core.getHealth().problemBytes, 0);
});
test('cancelled pending deletion retains busy responsibility until its exact completion; no late success', async () => {
  const item = subject(); await prepare(item); item.panel.reviewDelete(); item.files.deletePending = deferred();
  const operation = item.panel.confirmDelete(); await settle(); item.panel.cancel();
  assert.equal(await operation, 'PANEL_CANCELLED'); assert.equal(item.panel.getState(), 'busy');
  assert.equal(item.panel.reviewExport(), 'PANEL_BUSY'); item.files.deletePending.resolve(); await settle();
  assert.notEqual(item.panel.resultCode, 'PROBLEM_DELETED'); assert.equal(item.panel.getState(), 'idle');
});
test('save expiry during Picker retains the exact cleanup owner and never starts a native write', async () => {
  const item = subject(); await prepare(item); item.panel.reviewExport(); item.host.pending = deferred();
  const operation = item.panel.confirmExport(); await settle(); item.files.tick += 30000;
  assert.equal(item.panel.getState(), 'cleanup-required'); assert.equal(await operation, 'SAVE_CANCELLED');
  item.host.pending.resolve(); await settle();
  assert.deepEqual(item.host.calls.map(call => call[0]), ['pick']);
  assert.equal(await item.panel.retryCleanup(), true);
  assert.notEqual(item.panel.resultCode, 'SAVE_HOST_REPORTED');
});
test('failed native close blocks another review; query and new actions cannot retry it', async () => {
  const item = subject(); await prepare(item); item.panel.reviewExport(); item.host.closeOkay = false;
  assert.equal(await item.panel.confirmExport(), 'SAVE_CLEANUP_REQUIRED');
  const calls = item.host.calls.length;
  assert.equal(item.panel.getState(), 'cleanup-required'); assert.equal(item.panel.reviewDelete(), 'PANEL_BUSY');
  assert.equal(item.panel.reviewExport(), 'PANEL_BUSY'); assert.equal(item.host.calls.length, calls);
  assert.equal(await item.panel.retryCleanup(), false);
  item.host.closeOkay = true; assert.equal(await item.panel.retryCleanup(), true);
});
test('deletion timeout bounds caller waiting without releasing a pending Core operation', async () => {
  const item = subject(); await prepare(item); item.panel.reviewDelete(); item.files.deletePending = deferred();
  const operation = item.panel.confirmDelete(100); await settle();
  const code = await Promise.race([operation, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('panel deletion wait not bounded')), 1000);
    operation.finally(() => clearTimeout(timer));
  })]);
  assert.equal(code, 'PANEL_CANCELLED'); assert.equal(item.panel.getState(), 'busy');
  assert.equal(await item.panel.retryCleanup(), false);
  item.files.deletePending.resolve(); await settle();
  assert.equal(item.panel.getState(), 'idle'); assert.notEqual(item.panel.resultCode, 'PROBLEM_DELETED');
});
test('malformed review cannot put free text, paths or another hash into the displayed confirmation', async () => {
  for (const variant of ['file', 'field', 'count', 'hash']) {
    const item = subject(); await prepare(item);
    const original = item.core.reviewArchive.bind(item.core);
    item.core.reviewArchive = id => {
      const result = original(id), review = JSON.parse(result.text);
      if (variant === 'file') review.files[0].path = '/private-value';
      if (variant === 'field') review.fields[0].fields[0].key = 'private-value\n';
      if (variant === 'count') review.archiveBytes = Number.MAX_SAFE_INTEGER;
      if (variant === 'hash') result.reviewHash = 'not-a-zip-hash';
      result.text = JSON.stringify(review); return result;
    };
    assert.equal(item.panel.reviewExport(), 'PANEL_UNAVAILABLE');
    assert.deepEqual(item.panel.archiveFiles, []); assert.deepEqual(item.panel.fieldNames, []);
    assert.equal(item.panel.confirmation, 'none'); assert.deepEqual(item.host.calls, []);
  }
});
test('Core deletion or revocation during Picker must prevent every native write', async () => {
  for (const action of ['delete', 'clock']) {
    const item = subject(), id = await prepare(item); item.panel.reviewExport(); item.host.pending = deferred();
    const operation = item.panel.confirmExport(); await settle();
    if (action === 'delete') await item.core.deleteProblem(id);
    else { item.core.mark('app.metric', { count: 1 }); item.files.tick--; item.core.getHealth(); item.files.tick++; }
    item.host.pending.resolve(); await operation; await settle();
    assert.deepEqual(item.host.calls.map(call => call[0]), ['pick'], action);
    assert.equal(item.panel.getState(), 'cleanup-required'); assert.equal(await item.panel.retryCleanup(), true);
  }
});
