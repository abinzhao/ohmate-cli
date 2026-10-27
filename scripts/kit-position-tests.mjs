/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Actual ETS models and Preferences owner. Private SDK persistence is not
// physical durability, UI paint, process locking or device evidence.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-position-'));
const root = fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/host-integration/', import.meta.url));
const sdkPath = path.join(directory, 'sdk.mjs');
await writeFile(sdkPath, `
export const state = { files: new Map(), caches: new Map(), calls: [], fail: '', pending: undefined };
export const preferences = {
  async getPreferences(context, options) {
    state.calls.push(['open', context.filesDir, options]);
    if (state.pending?.kind === 'open') await state.pending.promise;
    if (state.fail === 'open') throw Error('private-preferences-open');
    const key = context.filesDir + '/' + options.name;
    const cache = { value: state.files.get(key) ?? '' }; state.caches.set(key, cache);
    return {
      async get(name, fallback) {
        state.calls.push(['get', name]);
        if (state.pending?.kind === 'get') await state.pending.promise;
        if (state.fail === 'get') throw Error('private-preferences-get');
        return cache.value || fallback;
      },
      async put(name, value) {
        state.calls.push(['put', name, value]); cache.value = value;
        if (state.pending?.kind === 'put') await state.pending.promise;
        if (state.fail === 'put') throw Error('private-preferences-put');
      },
      async flush() {
        state.calls.push(['flush']);
        if (state.pending?.kind === 'flush') await state.pending.promise;
        if (state.fail === 'flush') throw Error('private-preferences-flush');
        state.files.set(key, cache.value);
      },
    };
  },
  async removePreferencesFromCache(context, options) {
    state.calls.push(['remove', context.filesDir, options]);
    if (state.pending?.kind === 'remove') await state.pending.promise;
    if (state.fail === 'remove') throw Error('private-preferences-remove');
    state.caches.delete(context.filesDir + '/' + options.name);
  },
};\n`, { flag: 'wx', mode: 0o600 });
const sdk = await import(pathToFileURL(sdkPath));
const previousCanIUse = globalThis.canIUse;
globalThis.canIUse = () => true;
const entry = path.join(directory, 'entry.ts');
await writeFile(entry, `export * from ${JSON.stringify(path.join(root, 'DebugViewModel.ets'))};
export * from ${JSON.stringify(path.join(root, 'HarmonyPositionPreferences.ets'))};\n`, { flag: 'wx' });
let api;
try {
  const output = path.join(directory, 'position.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
    plugins: [{ name: 'private-position-sdk', setup(builder) {
      builder.onResolve({ filter: /^@kit\./ }, () => ({ path: sdkPath, external: true }));
      builder.onLoad({ filter: /(?:DebugViewModel|ProblemPanelModel)\.ets$/ }, async args => ({
        contents: (await readFile(args.path, 'utf8')).replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, ''),
        loader: 'ts',
      }));
    } }],
  });
  api = await import(pathToFileURL(output));
} catch (error) { console.error('position implementation unavailable:', error.errors?.[0]?.text ?? error.message); }
const models = [], stores = [];
function subject() {
  assert(api?.DebugViewModel && api?.HarmonyPositionPreferences, 'actual model and Preferences implementation required');
  const model = new api.DebugViewModel(); models.push(model); return model;
}
function store() {
  assert(api?.HarmonyPositionPreferences, 'actual Preferences implementation required');
  const context = { filesDir: path.join(directory, 'sandbox-' + stores.length) };
  const value = new api.HarmonyPositionPreferences(context); stores.push(value); return { value, context };
}
function deferred(kind) {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { kind, promise, resolve };
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function drag(model, x = -280, y = -200) {
  model.beginDrag(); model.dragBy(x, y); model.endDrag();
}
function position(model) { return [model.buttonX, model.buttonY]; }
function port(value = undefined) {
  return { reads: [], writes: [], pending: undefined, fail: false,
    async read(scope, bucket) { this.reads.push([scope, bucket]); if (this.pending) await this.pending.promise; return value; },
    async write(scope, bucket, selected) {
      this.writes.push([scope, bucket, { ...selected }]); return !this.fail;
    } };
}
after(async () => {
  sdk.state.pending?.resolve(); sdk.state.pending = undefined; sdk.state.fail = '';
  for (const model of models) model.releasePosition();
  await settle();
  for (const value of stores) assert.equal(await value.close(), true);
  assert.equal(sdk.state.caches.size, 0, 'all original Preferences cache owners must be released');
  if (previousCanIUse === undefined) delete globalThis.canIUse;
  else globalThis.canIUse = previousCanIUse;
  await rm(directory, { recursive: true, force: true });
});
test('buckets isolate normalized side/ratio; returning to a bucket restores only its value', () => {
  const model = subject(); model.layout(360, 640, []); const original = position(model);
  drag(model); const portrait = position(model); assert.equal(portrait[0], 8);
  model.layout(640, 360, []); assert.equal(model.buttonX, 584);
  assert(Math.abs(model.buttonY - (8 + 0.65 * 296)) < 0.001);
  drag(model, -560, -80); const landscape = position(model);
  model.layout(360, 640, []); assert.deepEqual(position(model), portrait);
  model.layout(640, 360, []); assert.deepEqual(position(model), landscape);
  model.layout(900, 900, []); assert.equal(model.buttonX, 844);
  assert.notDeepEqual(portrait, original);
});
test('cancel, tap, invalid drag and resize during drag never commit or save', async () => {
  const model = subject(), disk = port(); model.configurePosition(disk, 'main');
  model.layout(360, 640, []); await settle();
  const before = position(model);
  model.beginDrag(); model.dragBy(-200, -100); model.cancelDrag();
  assert.deepEqual(position(model), before);
  model.beginDrag(); model.endDrag();
  model.beginDrag(); model.dragBy(NaN, 0); model.endDrag(); model.layout(360, 640, []);
  model.beginDrag(); model.dragBy(-280, -200); model.layout(640, 360, []); model.endDrag();
  await settle(); assert.equal(disk.writes.length, 0);
  model.layout(360, 640, []); assert.deepEqual(position(model), before);
});
test('late reads cannot overwrite a committed drag, changed bucket, background or released model', async () => {
  for (const action of ['drag', 'resize', 'background', 'release']) {
    const model = subject(), disk = port({ rightSide: false, edgeRatio: 0.1 });
    disk.pending = deferred('get'); model.configurePosition(disk, 'main'); model.layout(360, 640, []);
    await settle(); assert.equal(disk.reads.length, 1);
    if (action === 'drag') drag(model);
    if (action === 'resize') model.layout(640, 360, []);
    if (action === 'background') model.suspendPosition();
    if (action === 'release') model.releasePosition();
    const before = position(model); disk.pending.resolve(); await settle();
    assert.deepEqual(position(model), before, action);
    assert.equal(model.visible, false);
    if (action === 'release') {
      const calls = disk.reads.length + disk.writes.length;
      model.resumePosition(); drag(model); await settle();
      assert.equal(disk.reads.length + disk.writes.length, calls);
    }
  }
});
test('successful restore is constrained by current exclusions and never restores visibility', async () => {
  const model = subject(), disk = port({ rightSide: false, edgeRatio: 0.5 });
  model.configurePosition(disk, 'main');
  const rect = new api.FloatingRect(); rect.width = 60; rect.height = 640;
  model.layout(360, 640, [rect]); await settle();
  assert.equal(model.buttonX, 304); assert.equal(model.visible, false);
  assert.equal(model.positionState, 'restored'); assert.equal(disk.writes.length, 0);
  model.layout(360, 640, []); assert.equal(model.buttonX, 8);
});
test('failed save retains only normalized position and requires explicit retry; old callbacks stay inert', async () => {
  const model = subject(), disk = port(); disk.fail = true;
  model.configurePosition(disk, 'main'); model.layout(360, 640, []); await settle();
  drag(model); await settle(); assert.equal(model.positionState, 'save-uncertain');
  assert.equal(disk.writes.length, 1); const saved = disk.writes[0];
  assert.deepEqual(Object.keys(saved[2]).sort(), ['edgeRatio', 'rightSide']);
  model.layout(360, 640, []); await settle(); assert.equal(disk.writes.length, 1);
  disk.fail = false; assert.equal(await model.retryPosition(), true);
  assert.equal(disk.writes.length, 2); assert.deepEqual(disk.writes[1], saved);
  assert.equal(model.positionState, 'saved');
  model.releasePosition(); assert.equal(await model.retryPosition(), false);
});
test('one Preferences table serializes writes, survives a fresh owner and isolates stable window keys', async () => {
  const { value, context } = store();
  assert.equal(await value.write('main', 'p01', { rightSide: false, edgeRatio: 0.25 }), true);
  assert.equal(await value.write('dialog', 'p01', { rightSide: true, edgeRatio: 0.9 }), true);
  assert.equal(await value.close(), true);
  const fresh = new api.HarmonyPositionPreferences(context); stores.push(fresh);
  assert.deepEqual(await fresh.read('main', 'p01'), { rightSide: false, edgeRatio: 0.25 });
  assert.deepEqual(await fresh.read('dialog', 'p01'), { rightSide: true, edgeRatio: 0.9 });
  assert.equal(await fresh.read('main', 'l01'), undefined);
  const bytes = [...sdk.state.files.values()].at(-1);
  assert.equal(typeof bytes, 'string'); assert(bytes.length < 65536);
  assert(!bytes.includes(context.filesDir)); assert(!bytes.includes('buttonX'));
});
test('uncertain put/flush keeps original bytes for retry and blocks competing writes', async () => {
  for (const failure of ['put', 'flush']) {
    const { value } = store(); sdk.state.fail = failure;
    assert.equal(await value.write('main', 'p01', { rightSide: false, edgeRatio: 0.2 }), false);
    sdk.state.fail = '';
    const count = sdk.state.calls.filter(call => call[0] === 'put').length;
    assert.equal(await value.write('dialog', 'p01', { rightSide: true, edgeRatio: 0.8 }), false);
    assert.equal(sdk.state.calls.filter(call => call[0] === 'put').length, count);
    assert.equal(await value.retry(), true);
    assert.deepEqual(await value.read('main', 'p01'), { rightSide: false, edgeRatio: 0.2 });
    assert.equal(await value.read('dialog', 'p01'), undefined);
  }
});
test('pending open/read/flush/remove retains exact cache ownership until explicit close retry', async () => {
  for (const kind of ['open', 'get', 'flush', 'remove']) {
    const { value } = store();
    if (kind === 'remove') await value.read('main', 'p01');
    sdk.state.pending = deferred(kind);
    const pending = kind === 'flush' ? value.write('main', 'p01', { rightSide: true, edgeRatio: 0.1 }) :
      kind === 'remove' ? value.close() : value.read('main', 'p01');
    await settle();
    assert.equal(await value.close(), false, kind);
    const count = sdk.state.calls.length;
    assert.equal(await value.write('main', 'p01', { rightSide: false, edgeRatio: 0.9 }), false);
    assert.equal(sdk.state.calls.length, count);
    sdk.state.pending.resolve(); await pending; sdk.state.pending = undefined;
    assert.equal(await value.close(), true, kind);
  }
});
test('failed cache removal requires retry without reopening or deleting user preference data', async () => {
  const { value } = store(); await value.read('main', 'p01');
  sdk.state.fail = 'remove'; assert.equal(await value.close(), false); sdk.state.fail = '';
  const opens = sdk.state.calls.filter(call => call[0] === 'open').length;
  assert.equal(await value.read('main', 'p01'), undefined);
  assert.equal(await value.close(), true);
  assert.equal(sdk.state.calls.filter(call => call[0] === 'open').length, opens);
});
test('malformed table, missing SysCap and exhausted stable-key quota fail without silent replacement', async () => {
  for (const failure of ['open', 'get']) {
    const { value } = store(); sdk.state.fail = failure;
    assert.equal(await value.read('main', 'p01'), undefined); sdk.state.fail = '';
    const puts = sdk.state.calls.filter(call => call[0] === 'put').length;
    assert.equal(await value.write('main', 'p01', { rightSide: false, edgeRatio: 0.1 }), false);
    assert.equal(sdk.state.calls.filter(call => call[0] === 'put').length, puts);
    assert.equal(await value.close(), true, 'failed acquisition still releases the original cache responsibility');
  }
  const invalid = store();
  sdk.state.files.set(invalid.context.filesDir + '/ohmate-debug-position-v1', 'bad-data');
  const count = sdk.state.calls.filter(call => call[0] === 'put').length;
  assert.equal(await invalid.value.read('main', 'p01'), undefined);
  assert.equal(await invalid.value.write('main', 'p01', { rightSide: true, edgeRatio: 0.2 }), false);
  assert.equal(sdk.state.calls.filter(call => call[0] === 'put').length, count);
  const missing = store(); globalThis.canIUse = () => false;
  const calls = sdk.state.calls.length;
  assert.equal(await missing.value.read('main', 'p01'), undefined);
  assert.equal(sdk.state.calls.length, calls); globalThis.canIUse = () => true;
  const quota = store();
  for (let i = 0; i < 32; i++) {
    assert.equal(await quota.value.write('w-' + i, 'p01', { rightSide: true, edgeRatio: 0.2 }), true);
  }
  assert.equal(await quota.value.write('extra', 'p01', { rightSide: true, edgeRatio: 0.2 }), false);
  assert.equal(await quota.value.write('../main', 'p01', { rightSide: true, edgeRatio: 0.2 }), false);
});
test('background then foreground cannot revive an older retry into another write', async () => {
  const model = subject(), disk = port(); disk.fail = true;
  model.configurePosition(disk, 'main'); model.layout(360, 640, []); await settle(); drag(model); await settle();
  const pending = deferred('retry'); disk.getState = () => 'save-uncertain';
  disk.retry = async () => { await pending.promise; disk.fail = false; return true; };
  const operation = model.retryPosition(); await settle(); const writes = disk.writes.length;
  model.suspendPosition(); model.resumePosition(); pending.resolve();
  assert.equal(await operation, false);
  assert.equal(disk.writes.length, writes, 'old retry cannot acquire a new foreground write');
});
test('newer drag stays dirty after an older save settles; only explicit retry saves the latest position', async () => {
  const model = subject(), disk = port(); model.configurePosition(disk, 'main');
  model.layout(360, 640, []); await settle();
  const pending = deferred('write');
  disk.write = async function(scope, bucket, value) {
    this.writes.push([scope, bucket, { ...value }]);
    if (this.writes.length === 1) await pending.promise;
    return true;
  };
  drag(model); await settle(); drag(model, 280, 100);
  const selected = position(model); pending.resolve(); await settle();
  assert.equal(disk.writes.length, 1); assert.deepEqual(position(model), selected);
  assert.equal(await model.retryPosition(), true); assert.equal(disk.writes.length, 2);
  assert.equal(disk.writes[1][2].rightSide, true);
});
test('model and shared Preferences attempt budgets include failures and never reset through retry', async () => {
  const model = subject(), disk = port(); disk.fail = true;
  model.configurePosition(disk, 'main'); model.layout(360, 640, []); await settle();
  drag(model); await settle();
  for (let i = 0; i < 260; i++) await model.retryPosition();
  assert.equal(disk.reads.length + disk.writes.length, 256);
  assert.equal(model.positionState, 'quota');
  const { value } = store(); await value.read('main', 'p01');
  for (let i = 0; i < 255; i++) assert.equal(await value.write('main', 'p01', { rightSide: true, edgeRatio: 0.2 }), true);
  const puts = sdk.state.calls.filter(call => call[0] === 'put').length;
  assert.equal(await value.write('main', 'p01', { rightSide: true, edgeRatio: 0.3 }), false);
  assert.equal(sdk.state.calls.filter(call => call[0] === 'put').length, puts);
  assert.equal(value.getState(), 'quota'); assert.equal(await value.close(), true);
});
