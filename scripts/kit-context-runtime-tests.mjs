/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Actual Core/Runtime/Debug/window ETS; private file and SDK hosts are not device evidence.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-context-runtime-'));
const subjects = [], nativeInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
const intervals = new Set();
const previousCanIUse = globalThis.canIUse;
globalThis.canIUse = () => true;
globalThis.setInterval = (callback, delay) => {
  const timer = nativeInterval(callback, delay); intervals.add(timer); return timer;
};
globalThis.clearInterval = timer => { intervals.delete(timer); nativeClearInterval(timer); };
const sdkPath = path.join(directory, 'sdk.mjs');
await writeFile(sdkPath, `
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const state = { hosts: [], windows: new Map(), tick: 1000, recovery: undefined, cleanup: true,
  saveHosts: [],
  positions: { files: new Map(), caches: new Map(), calls: [], pending: undefined, fail: '' } };
export class HarmonyArchiveSaveHost {
  constructor(context,bound) { this.context=context; this.bound=bound; this.calls=[]; this.closeOkay=true;
    this.pending=undefined; state.saveHosts.push(this); }
  async pick(name) { this.calls.push('pick'); if(this.pending) await this.pending.promise; return true; }
  async write(bytes,current) {
    assertCurrent(current); this.calls.push('write'); return current();
  }
  async close() { this.calls.push('close'); return this.closeOkay; }
}
function assertCurrent(current) { if(!current()) throw Error('private-stale-save'); }
export const preferences = {
  async getPreferences(context, options) {
    const key=context.filesDir+'/'+options.name, selected=state.positions;
    selected.calls.push('open'); const cache={value:selected.files.get(key)??''}; selected.caches.set(key,cache);
    return {
      async get() {
        selected.calls.push('get'); if(selected.pending) await selected.pending.promise; return cache.value;
      },
      async put(name,value) { selected.calls.push('put'); cache.value=value; },
      async flush() {
        selected.calls.push('flush'); if(selected.fail==='flush') throw Error('private-position-flush');
        selected.files.set(key,cache.value);
      },
    };
  },
  async removePreferencesFromCache(context,options) {
    state.positions.calls.push('remove');
    if(state.positions.fail==='remove') throw Error('private-position-remove');
    state.positions.caches.delete(context.filesDir+'/'+options.name);
  },
};
export class HarmonySandboxHost {
  constructor(root) { this.root=root; this.writes=0; this.closed=false; state.hosts.push(this); }
  now() { return { clockId:'test-clock',bootId:'test-session',monotonicNs:state.tick*1000000,
    wallTimeUtc:'2026-10-26T00:00:00.000Z' }; }
  random() { return 0; }
  sessionId() { return 'test-session'; }
  hash(text) { return createHash('sha256').update(text).digest('hex'); }
  hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
  byteLength(text) { return Buffer.byteLength(text); }
  async recover() { if(state.recovery) await state.recovery.promise; return []; }
  async recoverProblems() { return []; }
  async append(text) {
    const handle=await open(path.join(this.root,'record-'+(++this.writes)+'.json'),'wx',0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    return 'synced';
  }
  async saveProblem(id,text) { return this.append(text); }
  async deleteProblem() { return true; }
  async dispose() { this.closed=state.cleanup; }
  resourcesReleased() { return this.closed; }
}
export const systemDateTime={TimeType:{STARTUP:0}, getUptime:()=>state.tick};
export const window={findWindow:name=>state.windows.get(name),WindowEventType:{WINDOW_SHOWN:1,
  WINDOW_HIDDEN:4,WINDOW_DESTROYED:7},AvoidAreaType:{TYPE_SYSTEM:0,TYPE_CUTOUT:1,
  TYPE_SYSTEM_GESTURE:2,TYPE_KEYBOARD:3,TYPE_NAVIGATION_INDICATOR:4,TYPE_FLOAT_NAVIGATION:5}};
export function makeFloating(context, model){return context.makeContent('floating',model)}
export function makePanel(context, model){return context.makeContent('panel',model)}
`, { flag: 'wx', mode: 0o600 });
const sdk = await import(pathToFileURL(sdkPath));
const kitPath = fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/api/OHMateKit.ets', import.meta.url));
const runtimePath = fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/api/runtime.ets', import.meta.url));
const entry = path.join(directory, 'entry.ts');
await writeFile(entry, `export { OHMateKit } from ${JSON.stringify(kitPath)};
export * from ${JSON.stringify(runtimePath)};\n`, { flag: 'wx' });
let sequence = 0;
async function subject() {
  const output = path.join(directory, `runtime-${sequence++}.mjs`);
  let api;
  try {
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm',
      loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
      plugins: [{ name: 'private-context-sdk', setup(builder) {
        builder.onResolve({ filter: /^@kit\.|HarmonySandboxHost$|HarmonyArchiveSaveHost$|DebugViews$/ },
          () => ({ path: sdkPath, external: true }));
        builder.onLoad({ filter: /(?:DebugViewModel|ProblemPanelModel)\.ets$/ }, async args => ({
          contents: (await readFile(args.path, 'utf8')).replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, ''),
          loader: 'ts',
        }));
      } }],
    });
    api = await import(pathToFileURL(output));
  } catch (error) { console.error('public context Runtime unavailable:', error.errors?.[0]?.text ?? error.message); }
  assert(api?.OHMateRuntime, 'single-package context Runtime must exist');
  const filesDir = await mkdtemp(path.join(directory, 'files-'));
  const item = { api, runtime: api.OHMateRuntime, kit: api.OHMateKit, context: { filesDir }, windows: [] };
  subjects.push(item); return item;
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
class Window {
  id = 1; shown = true; callbacks = new Map(); fail = '';
  getWindowProperties() { return { id: this.id, windowRect: { left: 0, top: 0, width: 720, height: 1280 } }; }
  isWindowShowing() { return this.shown; }
  getWindowAvoidArea() {
    const rect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    return { leftRect: rect(), topRect: rect(), rightRect: rect(), bottomRect: rect() };
  }
  on(type, callback) { this.callbacks.set(type, callback); }
  off(type, callback) {
    assert.equal(callback, this.callbacks.get(type));
    if (this.fail === 'off') throw Error('private-cleanup');
    this.callbacks.delete(type);
  }
  emit(event) { this.shown = event === 1; this.callbacks.get('windowEvent')?.(event); }
}
class Context {
  constructor(id) { this.id = id; this.name = 'window-' + sequence + '-' + id; }
  nodes = []; calls = []; pendingOpen = undefined; fail = '';
  getWindowId() { return this.id; }
  getWindowName() { return this.name; }
  px2vp(value) { return value / 2; }
  runScopedTask(action) { action(); }
  makeContent(kind, model) {
    const node = { kind, model, disposed: false, dispose: () => { node.disposed = true; },
      isDisposed: () => node.disposed,
      updateConfiguration: () => { assert(!node.disposed); this.calls.push('configuration'); } };
    this.nodes.push(node); return node;
  }
  getOverlayManager() {
    return { addComponentContent: () => this.calls.push('add'), showComponentContent: () => this.calls.push('show'),
      hideComponentContent: () => this.calls.push('hide'), removeComponentContent: () => this.calls.push('remove') };
  }
  getPromptAction() {
    return { openCustomDialog: async (node, options) => {
      this.calls.push('open'); this.options = options;
      if (this.pendingOpen) await this.pendingOpen.promise;
      if (this.fail === 'open') throw Error('private-opening');
    }, closeCustomDialog: async () => { this.calls.push('close'); } };
  }
}
function windowFor(item, id = 1) {
  const context = new Context(id), window = new Window(); window.id = id;
  sdk.state.windows.set(context.name, window); const result = { context, window }; item.windows.push(result); return result;
}
const schema = { name: 'app.metric', fields: [{ key: 'count', kind: 'number', minimum: 0, maximum: 100 }] };
function options(api) { const value = new api.CoreOptions(); value.sampling = 1; value.flushIntervalMs = 60000; return value; }
async function start(item, profile = 'debug') {
  assert.equal(item.runtime.registerSchema(schema).code, 'REGISTERED');
  assert.equal((await item.runtime.start(item.context, profile, options(item.api))).code, 'STARTED');
}
async function attach(item, target = windowFor(item)) {
  const result = await item.runtime.attachWindow(target.context);
  assert.equal(result.code, 'WINDOW_ATTACHED'); return target;
}
function model(target) { return target.context.nodes[0]?.model; }
after(async () => {
  sdk.state.recovery?.resolve(); sdk.state.cleanup = true;
  for (const host of sdk.state.saveHosts) { host.pending?.resolve(); host.closeOkay = true; }
  sdk.state.positions.pending?.resolve(); sdk.state.positions.pending = undefined; sdk.state.positions.fail = '';
  for (const item of subjects) {
    for (const target of item.windows) { target.context.pendingOpen?.resolve(); target.window.fail = ''; }
    await settle(); await item.runtime.dispose();
    for (const status of item.runtime.getWindows()) await item.runtime.retryWindowCleanup(status.windowId);
    await item.runtime.dispose(); await item.kit.dispose();
    for (const target of item.windows) {
      assert.equal(target.window.callbacks.size, 0);
      assert(target.context.nodes.every(node => node.disposed), 'every original node must be disposed');
    }
  }
  assert.equal(intervals.size, 0, 'one shared Core timer owner must stop');
  assert.equal(sdk.state.positions.caches.size, 0, 'all original Preferences caches must stop');
  if (previousCanIUse === undefined) delete globalThis.canIUse;
  else globalThis.canIUse = previousCanIUse;
  globalThis.setInterval = nativeInterval; globalThis.clearInterval = nativeClearInterval;
  await rm(directory, { recursive: true, force: true });
});
test('context Runtime import is inert and default/Core has no UI reverse dependency', async () => {
  const item = await subject(); assert.equal(item.runtime.getHealth().state, 'created');
  assert.deepEqual(item.runtime.getWindows(), []); assert.equal(intervals.size, 0);
  assert.equal((await item.runtime.openPanel()).code, 'NOT_ACTIVE');
  const pending = [fileURLToPath(new URL('../kit/ohmatekit/Index.ets', import.meta.url))], seen = new Set();
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    assert(!/\/(host-integration|debug|providers|testbridge)\//.test(file));
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      let next = path.resolve(path.dirname(file), match[1]);
      if (!next.endsWith('.ets')) next += '.ets'; pending.push(next);
    }
  }
  assert(seen.size >= 14, 'check the complete default Core closure');
});
test('Runtime detail confirmation binds exact context/window; pending save retains detach and logical key ownership', async () => {
  const item = await subject(); await start(item);
  const target = windowFor(item);
  assert.equal((await item.runtime.attachWindow(target.context, 1000, 'archive-main')).code, 'WINDOW_ATTACHED');
  await item.runtime.openPanel('window-1');
  const panel = model(target)?.problems; assert(panel, 'actual detail/save model must be bound');
  const host = sdk.state.saveHosts.at(-1);
  assert.equal(host.context, item.context); assert.equal(host.bound, target.window);
  const created = await item.runtime.createProblem(); assert.equal(panel.select(created.problemId), 'PANEL_SELECTED');
  assert.equal(panel.reviewExport(), 'PANEL_EXPORT_REVIEWED'); host.pending = deferred();
  const saving = panel.confirmExport(); await settle(); assert.deepEqual(host.calls, ['pick']);
  assert.equal((await item.runtime.closePanel('window-1')).code, 'PANEL_CLOSED');
  assert.equal(await saving, 'SAVE_CANCELLED');
  assert.equal((await item.runtime.detachWindow('window-1')).code, 'WINDOW_CLEANUP_REQUIRED');
  const other = windowFor(item, 2);
  assert.equal((await item.runtime.attachWindow(other.context, 1000, 'archive-main')).code, 'POSITION_KEY_CONFLICT');
  assert.equal((await item.runtime.retryArchiveSaveCleanup('window-1')).code, 'SAVE_CLEANUP_REQUIRED');
  host.pending.resolve(); await settle(); assert.deepEqual(host.calls, ['pick']);
  assert.equal((await item.runtime.retryArchiveSaveCleanup('window-1')).code, 'SAVE_CLEANED');
  assert.equal((await item.runtime.retryWindowCleanup('window-1')).code, 'WINDOW_DETACHED');
  assert.equal((await item.runtime.attachWindow(other.context, 1000, 'archive-main')).code, 'WINDOW_ATTACHED');
});
test('background/configuration failure/destroy/dispose revoke pending saves before any late write', async () => {
  for (const action of ['background', 'configuration', 'destroy', 'dispose']) {
    const item = await subject(); await start(item); const target = await attach(item);
    await item.runtime.openPanel('window-1');
    const panel = model(target)?.problems; assert(panel, 'current-window panel required');
    const created = await item.runtime.createProblem(); panel.select(created.problemId); panel.reviewExport();
    const host = sdk.state.saveHosts.at(-1); host.pending = deferred();
    const saving = panel.confirmExport(); await settle();
    if (action === 'background') target.window.emit(4);
    if (action === 'destroy') target.window.emit(7);
    if (action === 'configuration') {
      target.context.nodes[1].updateConfiguration = () => { throw Error('private-config'); };
      assert.equal(item.runtime.updateConfiguration('window-1').code, 'WINDOW_CLEANUP_REQUIRED');
    }
    if (action === 'dispose') assert.notEqual((await item.runtime.dispose()).code, 'DISPOSED');
    assert.equal(await saving, 'SAVE_CANCELLED');
    host.pending.resolve(); await settle(); assert.deepEqual(host.calls, ['pick'], action);
    host.closeOkay = false;
    assert.equal((await item.runtime.retryArchiveSaveCleanup('window-1')).code, 'SAVE_CLEANUP_REQUIRED');
    host.closeOkay = true;
    assert.equal((await item.runtime.retryArchiveSaveCleanup('window-1')).code, 'SAVE_CLEANED');
    assert.notEqual(panel.resultCode, 'SAVE_HOST_REPORTED');
  }
});
test('captured close/open/hide callbacks from a released window cannot act on its fresh same-ID owner', async () => {
  const item = await subject(); await start(item); const original = await attach(item);
  const old = model(original), actions = [old.close, old.open, old.hide];
  await item.runtime.detachWindow('window-1');
  const fresh = windowFor(item); await attach(item, fresh); await item.runtime.openPanel('window-1');
  const panel = model(fresh).problems, created = await item.runtime.createProblem();
  panel.select(created.problemId); panel.reviewExport();
  const calls = fresh.context.calls.length;
  for (const action of actions) { action(); await settle(); }
  assert.equal(fresh.context.calls.length, calls); assert.equal(panel.confirmation, 'export');
  assert.equal(item.runtime.getWindows()[0].panel, 'open');
});
test('destroy callback cannot retry an already failed save close; only explicit archive cleanup retries it', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  await item.runtime.openPanel('window-1');
  const panel = model(target).problems, created = await item.runtime.createProblem();
  panel.select(created.problemId); panel.reviewExport();
  const host = sdk.state.saveHosts.at(-1); host.closeOkay = false;
  assert.equal(await panel.confirmExport(), 'SAVE_CLEANUP_REQUIRED');
  const calls = host.calls.length; target.window.emit(7); await settle();
  assert.equal(host.calls.length, calls, 'destroy is not consent to retry a failed file close');
  assert.equal(item.runtime.getWindows()[0].state, 'cleanup-required');
  host.closeOkay = true;
  assert.equal((await item.runtime.retryArchiveSaveCleanup('window-1')).code, 'SAVE_CLEANED');
  assert.equal((await item.runtime.retryWindowCleanup('window-1')).code, 'WINDOW_DETACHED');
});
test('default singleton first and context Runtime share one actual Core, schema and file owner', async () => {
  const item = await subject(), before = sdk.state.hosts.length;
  assert.equal(item.kit.registerSchema(schema).code, 'REGISTERED');
  assert.equal((await item.kit.start(item.context, options(item.api))).code, 'STARTED');
  assert.equal((await item.runtime.start(item.context, 'debug', options(item.api))).code, 'ALREADY_STARTED');
  assert.equal(sdk.state.hosts.length, before + 1);
  assert.equal(item.runtime.mark('app.metric', { count: 1 }).code, 'RECORDED');
  assert.equal(item.kit.pause().code, 'PAUSED'); assert.equal(item.runtime.getHealth().state, 'paused');
  assert.equal(item.runtime.resume().code, 'RESUMED'); assert.equal(item.kit.getHealth().state, 'active');
  assert.equal(item.runtime.getHealth().buildVerification, 'unverified-build');
  const created = await item.runtime.createProblem();
  assert.equal(item.kit.getProblem(created.problemId).problemId, created.problemId);
  const review = item.runtime.reviewArchive(created.problemId);
  assert.equal(item.kit.exportArchive(created.problemId, review.reviewHash).archive[0], 0x50);
});
test('Runtime first and default start remain idempotent; conflicts never create another owner', async () => {
  const item = await subject(), before = sdk.state.hosts.length; await start(item);
  assert.equal((await item.kit.start(item.context, options(item.api))).code, 'ALREADY_STARTED');
  assert.equal((await item.runtime.start(item.context, 'test', options(item.api))).code, 'START_PROFILE_CONFLICT');
  const changed = options(item.api); changed.sampling = 0;
  assert.equal((await item.runtime.start(item.context, 'debug', changed)).code, 'START_OPTIONS_CONFLICT');
  assert.equal((await item.runtime.start({ filesDir: item.context.filesDir + '-other' }, 'debug', options(item.api))).code,
    'START_CONTEXT_CONFLICT');
  assert.equal(item.runtime.registerSchema(schema).code, 'SCHEMA_REGISTRATION_CLOSED');
  assert.equal(sdk.state.hosts.length, before + 1);
});
test('Release, unknown profile, invalid options and invalid context reject without I/O or window lookup', async () => {
  const item = await subject(), before = sdk.state.hosts.length;
  for (const profile of ['release-none', 'release-core', 'invalid']) {
    assert.equal((await item.runtime.start(item.context, profile)).code, 'CAPABILITY_NOT_AVAILABLE');
  }
  const invalid = options(item.api); invalid.maxRecords = 0;
  assert.equal((await item.runtime.start(item.context, 'debug', invalid)).code, 'OPTIONS_INVALID');
  assert.equal((await item.runtime.start({ filesDir: '' }, 'debug')).code, 'START_CONTEXT_INVALID');
  assert.equal(sdk.state.hosts.length, before); assert.equal(item.runtime.getHealth().state, 'created');
});
test('pending start cancellation cannot install Debug or revive Core after late recovery', async () => {
  const item = await subject(); sdk.state.recovery = deferred();
  const pending = item.runtime.start(item.context, 'test', options(item.api)); await settle();
  await item.runtime.dispose(); sdk.state.recovery.resolve();
  assert.equal((await pending).code, 'START_CANCELLED'); sdk.state.recovery = undefined;
  assert.equal((await item.runtime.attachWindow(windowFor(item).context)).code, 'DISPOSED');
  assert.equal((await item.runtime.start(item.context, 'test')).code, 'DISPOSED');
});
test('attach creates only explicit current floating entry and binds Core controls plus problem creation', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  assert.deepEqual(target.context.nodes.map(node => node.kind), ['floating']);
  const view = model(target); assert.equal(view.sessionState, 'active'); assert(view.visible);
  view.pause(); await settle(); assert.equal(item.kit.getHealth().state, 'paused');
  view.resume(); await settle(); assert.equal(item.kit.getHealth().state, 'active');
  view.mark(); await settle();
  // Wait on real file completion rather than assuming Promise turns finish I/O.
  while (view.panelBusy) await new Promise(done => setImmediate(done));
  assert.equal(view.resultCode, 'PROBLEM_CREATED'); assert.equal(view.problemIds.length, 1);
  view.open(); await settle(); assert(target.context.nodes.some(node => node.kind === 'panel'));
  target.context.options.onWillDismiss(); await settle(); assert(target.context.calls.includes('close'));
});
test('hidden clears Debug visibility cache; foreground requires a new explicit show', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  target.window.emit(4); await settle();
  assert.equal(item.runtime.getWindows()[0].floating, 'hidden'); assert.equal(model(target).visible, false);
  target.window.emit(1); await settle(); assert.equal(model(target).visible, false);
  assert.equal((await item.runtime.showFloatingButton()).code, 'FLOATING_VISIBLE');
  assert.equal(model(target).visible, true); assert(target.context.calls.includes('show'));
});
test('background during pending panel open cannot publish open or auto-restore it', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  target.context.pendingOpen = deferred(); const opening = item.runtime.openPanel();
  await settle(); target.window.emit(4); target.context.pendingOpen.resolve();
  await opening; await settle();
  assert.notEqual(item.runtime.getWindows()[0].panel, 'open');
  assert(target.context.calls.includes('close'), 'original late dialog must be closed');
  target.window.emit(1); assert.notEqual(item.runtime.getWindows()[0].panel, 'open');
});
test('destroy cancels pending UI wait, unbinds actions and cleans only after original native completion', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  const view = model(target); target.context.pendingOpen = deferred(); view.open(); await settle();
  assert.equal(view.panelBusy, true); const oldCode = view.resultCode;
  target.window.emit(7); await settle(); view.pause();
  assert.equal(item.kit.getHealth().state, 'active');
  assert(!target.context.calls.includes('close'));
  target.context.pendingOpen.resolve(); await settle();
  assert.equal(view.resultCode, oldCode, 'late completion cannot write a destroyed model');
  assert.equal(target.window.callbacks.size, 0);
  assert(target.context.nodes.every(node => node.disposed));
});
test('multiple current windows require an explicit target; detach leaves recorder active', async () => {
  const item = await subject(); await start(item); const first = await attach(item);
  await attach(item, windowFor(item, 2));
  assert.equal((await item.runtime.openPanel()).code, 'WINDOW_AMBIGUOUS');
  const id = item.runtime.getWindows()[0].windowId;
  assert.equal((await item.runtime.detachWindow(id)).code, 'WINDOW_DETACHED');
  const view = model(first); view.pause(); assert.equal(item.kit.getHealth().state, 'active');
  assert.equal(item.kit.mark('app.metric', { count: 2 }).code, 'RECORDED');
});
test('failed window and file-host disposal retain responsibility for explicit retry', async () => {
  const item = await subject(); await start(item); const target = await attach(item); target.window.fail = 'off';
  sdk.state.cleanup = false;
  assert.equal((await item.runtime.dispose()).code, 'WINDOW_CLEANUP_REQUIRED');
  target.window.fail = ''; assert.equal((await item.runtime.retryWindowCleanup(item.runtime.getWindows()[0].windowId)).code,
    'WINDOW_DETACHED');
  assert.equal((await item.runtime.dispose()).code, 'CLOSE_UNCERTAIN');
  sdk.state.cleanup = true; assert.notEqual((await item.runtime.dispose()).code, 'CLOSE_UNCERTAIN');
});
test('explicit Test profile composes readonly READY/ASSERT; Debug profile does not enable it', async () => {
  for (const profile of ['debug', 'test']) {
    const item = await subject(); await start(item, profile); let reads = 0, closes = 0;
    const adapter = { ready: async () => { reads++; return true; }, assert: async () => { reads++; return false; },
      close: async () => { closes++; return true; } };
    const result = item.runtime.registerTestAdapter(adapter, ['test.assert.marker']);
    assert.equal(result.code, profile === 'test' ? 'REGISTERED' : 'CAPABILITY_NOT_AVAILABLE');
    assert.equal(reads, 0);
    const ready = await item.runtime.ready();
    assert.equal(ready.code, profile === 'test' ? 'READY_REPORTED' : 'CAPABILITY_NOT_AVAILABLE');
    if (profile === 'test') {
      assert.equal(ready.buildVerification, 'unverified-build');
      assert.equal(ready.automation, 'unavailable');
      assert.equal((await item.runtime.assert('test.assert.marker')).passed, false);
    }
    await item.runtime.dispose(); assert.equal(closes, profile === 'test' ? 1 : 0);
  }
});
test('a rejected context start cannot reserve another Profile on the default singleton', async () => {
  const item = await subject();
  await item.kit.start(item.context, options(item.api));
  assert.equal((await item.runtime.start({ filesDir: item.context.filesDir + '-other' }, 'debug', options(item.api))).code,
    'START_CONTEXT_CONFLICT');
  assert.equal((await item.runtime.start(item.context, 'test', options(item.api))).code, 'ALREADY_STARTED');
  assert.equal(item.runtime.registerTestAdapter({ ready: async () => true, assert: async () => true,
    close: async () => true }, ['test.assert.marker']).code, 'REGISTERED');
});
test('invalid wait budgets do not consume Runtime window quota and initially hidden windows can attach', async () => {
  const item = await subject(); await start(item);
  for (let i = 0; i < 33; i++) {
    const target = windowFor(item, i + 10);
    assert.equal((await item.runtime.attachWindow(target.context, 0)).code, 'WINDOW_TIMEOUT_INVALID');
    assert.equal(target.window.callbacks.size, 0);
  }
  const target = windowFor(item); target.window.shown = false;
  assert.equal((await item.runtime.attachWindow(target.context)).code, 'WINDOW_ATTACHED'); await settle();
  assert.equal(item.runtime.getWindows()[0].floating, 'hidden');
  assert.equal((await item.runtime.showFloatingButton()).code, 'WINDOW_HIDDEN');
  target.window.emit(1); assert.equal((await item.runtime.showFloatingButton()).code, 'FLOATING_VISIBLE');
});
test('business blocked geometry clears the shared visible cache and requires explicit show after clearing', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  const id = item.runtime.getWindows()[0].windowId;
  const rect = new item.api.FloatingRect(); rect.width = 360; rect.height = 640;
  assert.equal(item.runtime.setAvoidRects(id, [rect]).code, 'AVOID_RECTS_UPDATED');
  assert.equal(model(target).visible, false); assert.equal(item.runtime.getWindows()[0].floating, 'hidden');
  assert.equal(item.runtime.setAvoidRects(id, []).code, 'AVOID_RECTS_UPDATED');
  assert.equal(model(target).visible, false);
  assert.equal((await item.runtime.showFloatingButton(id)).code, 'FLOATING_VISIBLE');
  assert.equal(model(target).visible, true);
});
test('failed UI action shows only a bounded code and old captured callbacks stay inert after detach', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  const view = model(target), oldPause = view.pause; target.context.fail = 'open';
  view.open(); await settle(); assert.equal(view.resultCode, 'WINDOW_CLEANUP_REQUIRED');
  // Observe the fields used by the panel, not private Core/native owner graphs.
  assert(!JSON.stringify({ resultCode: view.resultCode, problemIds: view.problemIds,
    sessionState: view.sessionState, selectedId: view.problems?.selectedId,
    archiveFiles: view.problems?.archiveFiles, fieldNames: view.problems?.fieldNames,
    panelResult: view.problems?.resultCode }).includes('private-opening'));
  const id = item.runtime.getWindows()[0].windowId;
  await item.runtime.retryWindowCleanup(id); oldPause(); await settle();
  assert.equal(item.kit.getHealth().state, 'active');
});
test('automatic destroyed-window cleanup releases the old context and permits a fresh same-ID owner', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  target.window.emit(7); await settle();
  assert.equal(target.window.callbacks.size, 0);
  const fresh = windowFor(item);
  assert.equal((await item.runtime.attachWindow(fresh.context)).code, 'WINDOW_ATTACHED');
  assert.equal(item.runtime.getWindows().length, 1);
  assert.equal(model(fresh).visible, true);
});
test('rejected options on a running default Core cannot reserve the Runtime Profile', async () => {
  const item = await subject(); await item.kit.start(item.context, options(item.api));
  const invalidMatch = options(item.api); invalidMatch.sampling = 0;
  assert.equal((await item.runtime.start(item.context, 'debug', invalidMatch)).code, 'START_OPTIONS_CONFLICT');
  assert.equal((await item.runtime.start(item.context, 'test', options(item.api))).code, 'ALREADY_STARTED');
});
test('Runtime configuration update requires the explicit live window and preserves hidden state', async () => {
  const item = await subject();
  assert.equal(item.runtime.updateConfiguration('window-1').code, 'NOT_ACTIVE');
  await start(item); const first = await attach(item); const second = await attach(item, windowFor(item, 2));
  assert.equal(item.runtime.updateConfiguration('').code, 'WINDOW_UNAVAILABLE');
  assert.equal(item.runtime.updateConfiguration('window-1').code, 'CONFIGURATION_UPDATED');
  assert.equal(first.context.calls.filter(call => call === 'configuration').length, 1);
  assert.equal(second.context.calls.filter(call => call === 'configuration').length, 0);
  first.window.emit(4); await settle();
  assert.equal(item.runtime.updateConfiguration('window-1').code, 'CONFIGURATION_UPDATED');
  assert.equal(model(first).visible, false);
  await item.runtime.detachWindow('window-1');
  assert.equal(item.runtime.updateConfiguration('window-1').code, 'WINDOW_UNAVAILABLE');
  await item.runtime.dispose(); assert.equal(item.runtime.updateConfiguration('window-2').code, 'DISPOSED');
});
test('Runtime configuration failure invalidates shared surface state and retains cleanup responsibility', async () => {
  const item = await subject(); await start(item); const target = await attach(item);
  target.context.nodes[0].updateConfiguration = () => { throw Error('private-config-failure'); };
  assert.equal(item.runtime.updateConfiguration('window-1').code, 'WINDOW_CLEANUP_REQUIRED');
  assert.notEqual(item.runtime.getWindows()[0].floating, 'visible');
  const calls = target.context.calls.length;
  assert.equal((await item.runtime.showFloatingButton('window-1')).code, 'WINDOW_CLEANUP_REQUIRED');
  assert.equal(target.context.calls.length, calls);
  assert.equal((await item.runtime.retryWindowCleanup('window-1')).code, 'WINDOW_DETACHED');
});
test('selecting quick-menu hide waits for disappearance and leaves the window attached', async () => {
  const item = await subject(); await start(item); const target = await attach(item); const view = model(target);
  view.requestQuickMenu(); view.menuAppearing(); view.quickAction('hide'); await settle();
  assert.equal(view.visible, true); assert.equal(item.runtime.getWindows()[0].state, 'attached');
  view.menuClosed(); await settle();
  assert.equal(view.visible, false); assert.equal(item.runtime.getWindows()[0].state, 'attached');
  assert.equal(view.resultCode, 'FLOATING_HIDDEN');
  assert.equal((await item.runtime.showFloatingButton('window-1')).code, 'FLOATING_VISIBLE');
});
test('position I/O is inert without an explicit stable key; keyed attachment restores only its bucket', async () => {
  const item = await subject(), before = sdk.state.positions.calls.length;
  await start(item); await attach(item);
  assert.equal(sdk.state.positions.calls.length, before);
  assert.equal(item.runtime.getPositionState('window-1'), 'memory-only');
  const target = windowFor(item, 2);
  sdk.state.positions.files.set(item.context.filesDir + '/ohmate-debug-position-v1',
    'ohmate-position-v1\neditor|p01|l|0.2');
  assert.equal((await item.runtime.attachWindow(target.context, 1000, 'editor')).code, 'WINDOW_ATTACHED');
  await settle();
  assert.equal(item.runtime.getPositionState('window-2'), 'restored');
  assert.equal(model(target).buttonX, 8);
  assert.equal(model(target).buttonY, 8 + 0.2 * 576);
});
test('invalid, duplicate and changed stable keys reject before acquiring window or preference owners', async () => {
  const item = await subject(); await start(item); const first = windowFor(item);
  assert.equal((await item.runtime.attachWindow(first.context, 1000, '../main')).code, 'POSITION_KEY_INVALID');
  assert.equal(first.window.callbacks.size, 0);
  assert.equal((await item.runtime.attachWindow(first.context, 1000, 'main')).code, 'WINDOW_ATTACHED');
  const second = windowFor(item, 2), calls = sdk.state.positions.calls.length;
  assert.equal((await item.runtime.attachWindow(second.context, 1000, 'main')).code, 'POSITION_KEY_CONFLICT');
  assert.equal(second.window.callbacks.size, 0); assert.equal(sdk.state.positions.calls.length, calls);
  assert.equal((await item.runtime.attachWindow(first.context, 1000, 'changed')).code, 'POSITION_KEY_CONFLICT');
});
test('Runtime disposal preserves a pending Preferences owner and late reads cannot revive old models', async () => {
  const item = await subject(); await start(item); const target = windowFor(item);
  sdk.state.positions.pending = deferred();
  assert.equal((await item.runtime.attachWindow(target.context, 1000, 'main')).code, 'WINDOW_ATTACHED');
  await settle(); const view = model(target), original = [view.buttonX, view.buttonY];
  assert.equal((await item.runtime.dispose()).code, 'POSITION_CLEANUP_REQUIRED');
  assert.equal(target.window.callbacks.size, 0); assert(target.context.nodes.every(node => node.disposed));
  sdk.state.positions.pending.resolve(); sdk.state.positions.pending = undefined; await settle();
  assert.deepEqual([view.buttonX, view.buttonY], original); assert.equal(view.visible, false);
  assert.equal(item.runtime.getPositionState('window-1'), 'unavailable');
  const count = sdk.state.positions.calls.length;
  assert.equal((await item.runtime.retryPosition('window-1')).code, 'POSITION_UNAVAILABLE');
  assert.equal(sdk.state.positions.calls.length, count);
  assert.equal((await item.runtime.dispose()).code, 'CLOSED', 'preserve the shared Core close receipt');
});
test('Runtime failed save retries its exact table only through a live foreground window', async () => {
  const item = await subject(); await start(item); const target = windowFor(item);
  assert.equal((await item.runtime.attachWindow(target.context, 1000, 'main')).code, 'WINDOW_ATTACHED');
  await settle(); const view = model(target); sdk.state.positions.fail = 'flush';
  view.beginDrag(); view.dragBy(-280, -200); view.endDrag(); await settle();
  assert.equal(view.positionState, 'save-uncertain');
  target.window.emit(4); await settle(); sdk.state.positions.fail = '';
  const count = sdk.state.positions.calls.length;
  assert.equal((await item.runtime.retryPosition('window-1')).code, 'POSITION_UNAVAILABLE');
  assert.equal(sdk.state.positions.calls.length, count);
  target.window.emit(1);
  assert.equal((await item.runtime.showFloatingButton('window-1')).code, 'FLOATING_VISIBLE');
  assert.equal((await item.runtime.retryPosition('window-1')).code, 'POSITION_UPDATED');
  assert.equal(view.positionState, 'saved');
});
test('initially hidden keyed attachment cannot start Preferences reads or retry until explicit show', async () => {
  const item = await subject(); await start(item); const target = windowFor(item); target.window.shown = false;
  const before = sdk.state.positions.calls.length;
  assert.equal((await item.runtime.attachWindow(target.context, 1000, 'main')).code, 'WINDOW_ATTACHED');
  await settle(); assert.equal(sdk.state.positions.calls.length, before);
  assert.equal((await item.runtime.retryPosition('window-1')).code, 'POSITION_UNAVAILABLE');
  target.window.emit(1); assert.equal(sdk.state.positions.calls.length, before);
  assert.equal((await item.runtime.showFloatingButton('window-1')).code, 'FLOATING_VISIBLE');
  await settle(); assert(sdk.state.positions.calls.length > before);
});
