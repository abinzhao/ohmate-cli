/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Executes the actual window host and geometry. SDK/node builders are shims,
// so calls and resource ownership are observable, but paint is not certified.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-window-test-'));
const instances = [];
let api;
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/host-integration/HarmonyDebugWindowHost.ets', import.meta.url))],
    outfile: path.join(directory, 'host.mjs'), bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
    plugins: [{
      name: 'private-window-sdk',
      setup(builder) {
        builder.onResolve({ filter: /^@kit\./ }, () => ({ path: 'sdk', namespace: 'shim' }));
        builder.onResolve({ filter: /DebugViews$/ }, () => ({ path: 'views', namespace: 'shim' }));
        builder.onLoad({ filter: /.*/, namespace: 'shim' }, args => ({
          contents: args.path === 'sdk' ?
            'export const window={findWindow(name){return globalThis.__ohmateTestWindows.get(name)},' +
            'WindowEventType:{WINDOW_SHOWN:1,WINDOW_HIDDEN:4,WINDOW_DESTROYED:7},' +
            'AvoidAreaType:{TYPE_SYSTEM:0,TYPE_CUTOUT:1,TYPE_SYSTEM_GESTURE:2,TYPE_KEYBOARD:3,' +
            'TYPE_NAVIGATION_INDICATOR:4,TYPE_FLOAT_NAVIGATION:5}};' +
            'export const picker={}; export const fileIo={};' :
            'export function makeFloating(context, model){return context.makeContent("floating",model)}' +
            'export function makePanel(context, model){return context.makeContent("panel",model)}',
          loader: 'js',
        }));
        builder.onLoad({ filter: /(?:DebugViewModel|ProblemPanelModel)\.ets$/ }, async args => ({
          contents: (await readFile(args.path, 'utf8')).replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, ''),
          loader: 'ts',
        }));
      },
    }],
  });
  api = await import(pathToFileURL(path.join(directory, 'host.mjs')));
} catch (error) { console.error('public window host unavailable:', error.errors?.[0]?.text ?? error.message); }
globalThis.__ohmateTestWindows = new Map();
const empty = () => ({ left: 0, top: 0, width: 0, height: 0 });
class Window {
  callbacks = new Map(); log = []; fail = ''; id = 1; shown = true;
  bounds = { left: 0, top: 0, width: 720, height: 1280 };
  areas = new Map();
  getWindowProperties() { return { id: this.id, windowRect: this.bounds }; }
  isWindowShowing() { return this.shown; }
  getWindowAvoidArea(type) {
    return { visible: true, leftRect: empty(), topRect: empty(), rightRect: empty(),
      bottomRect: this.areas.get(type) ?? empty() };
  }
  on(type, callback) {
    this.log.push(['on', type, callback]); this.callbacks.set(type, callback);
    if (this.fail === 'on:' + type) throw Error('private-partial-subscription');
  }
  off(type, callback) {
    this.log.push(['off', type, callback]);
    assert.equal(callback, this.callbacks.get(type), 'must remove only the original callback');
    if (this.fail === 'off:' + type) throw Error('private-cleanup-error');
    this.callbacks.delete(type);
  }
  emit(type, value) { this.callbacks.get(type)?.(value); }
}
class Context {
  id = 1; name = 'test-window'; calls = []; contents = []; fail = '';
  dialog = undefined; pendingOpen = undefined; pendingClose = undefined;
  getWindowId() { return this.id; }
  getWindowName() { return this.name; }
  px2vp(value) { return value / 2; }
  runScopedTask(action) { this.calls.push('scope'); action(); }
  makeContent(kind, model) {
    const node = { kind, model, disposed: false, removed: false, added: false,
      dispose: () => {
        this.calls.push('dispose:' + kind);
        if (this.fail === 'dispose:' + kind) throw Error('private-dispose-error');
        node.disposed = true;
      },
      isDisposed: () => node.disposed,
      updateConfiguration: () => { this.calls.push('configuration:' + kind); },
    };
    this.contents.push(node); return node;
  }
  getOverlayManager() {
    return {
      addComponentContent: node => {
        assert(!node.disposed); this.calls.push('add'); node.added = true;
        if (this.fail === 'add') throw Error('private-partial-add');
      },
      removeComponentContent: node => {
        assert(!node.disposed); this.calls.push('remove');
        if (this.fail === 'remove') throw Error('private-remove-error');
        node.removed = true;
      },
      showComponentContent: node => { assert(!node.disposed); this.calls.push('show'); },
      hideComponentContent: node => { assert(!node.disposed); this.calls.push('hide'); },
    };
  }
  getPromptAction() {
    return {
      openCustomDialog: async (node, options) => {
        this.calls.push('open'); this.dialog = { node, options };
        if (this.pendingOpen) await this.pendingOpen.promise;
        if (this.fail === 'open') throw Error('private-partial-open');
      },
      closeCustomDialog: async node => {
        this.calls.push('close'); assert.equal(node, this.dialog.node);
        if (this.pendingClose) await this.pendingClose.promise;
        if (this.fail === 'close') throw Error('private-close-error');
        this.dialog = undefined;
      },
    };
  }
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function subject() {
  assert(api?.HarmonyDebugWindowHost && api?.DebugViewModel && api?.FloatingRect, 'actual host/model exports required');
  const context = new Context(), window = new Window();
  context.name += '-' + instances.length;
  globalThis.__ohmateTestWindows.set(context.name, window);
  const model = new api.DebugViewModel();
  const host = new api.HarmonyDebugWindowHost(context, model);
  const item = { context, window, model, host }; instances.push(item); return item;
}
after(async () => {
  for (const item of instances) {
    item.window.fail = ''; item.context.fail = '';
    item.context.pendingOpen?.resolve(); item.context.pendingClose?.resolve();
    item.model.menuClosed(); // Release the test's simulated native menu before teardown.
    await item.host.detach();
    assert.equal(item.window.callbacks.size, 0, 'native listeners must be released');
    assert(item.context.contents.every(node => node.disposed), 'all created nodes must be released');
  }
  delete globalThis.__ohmateTestWindows;
  await rm(directory, { recursive: true, force: true });
});
test('construct/attach does not construct surfaces; show/open create only on demand', async () => {
  const item = subject(); assert.equal(item.context.calls.length, 0); assert.equal(item.window.log.length, 0);
  assert.equal(await item.host.attach(), true); assert.equal(item.context.contents.length, 0);
  assert.equal(await item.host.showFloatingButton(), true);
  assert.deepEqual(item.context.contents.map(n => n.kind), ['floating']);
  assert.equal(await item.host.openPanel(), true);
  assert.deepEqual(item.context.contents.map(n => n.kind), ['floating', 'panel']);
  assert.equal(await item.host.openPanel(), true); assert.equal(item.context.contents.length, 2);
  assert.equal(await item.host.closePanel(), true); assert(item.context.contents[1].disposed);
});
test('exact UIContext identity: no missing or mismatched window fallback', async () => {
  for (const variant of ['missing', 'mismatch', 'no-id']) {
    const item = subject();
    if (variant === 'missing') globalThis.__ohmateTestWindows.delete(item.context.name);
    if (variant === 'mismatch') item.window.id = 9;
    if (variant === 'no-id') item.context.id = undefined;
    assert.equal(await item.host.attach(), false); assert.equal(item.window.log.length, 0);
    assert.equal(item.context.contents.length, 0);
  }
});
test('partial registration retains exact callbacks until explicit cleanup retry', async () => {
  const item = subject(); item.window.fail = 'on:avoidAreaChange';
  assert.equal(await item.host.attach(), false);
  assert.equal(await item.host.attach(), false, 'failed host cannot re-register');
  item.window.fail = 'off:avoidAreaChange';
  assert.equal(await item.host.detach(), false);
  assert.equal(item.window.callbacks.size, 1);
  item.window.fail = ''; assert.equal(await item.host.detach(), true);
  assert.equal(item.window.callbacks.size, 0);
});
test('partial overlay add and failed remove retain node; queries never retry', async () => {
  const item = subject(); await item.host.attach(); item.context.fail = 'add';
  assert.equal(await item.host.showFloatingButton(), false);
  const node = item.context.contents[0]; assert(node.added);
  item.context.fail = 'remove'; assert.equal(await item.host.detach(), false);
  assert(!node.disposed, 'never dispose a node that could still be attached');
  const calls = item.context.calls.length;
  assert.equal(await item.host.showFloatingButton(), false); assert.equal(item.context.calls.length, calls);
  item.context.fail = ''; assert.equal(await item.host.detach(), true); assert(node.removed && node.disposed);
});
test('dispose failure retries original node without double remove', async () => {
  const item = subject(); await item.host.attach(); await item.host.showFloatingButton();
  item.context.fail = 'dispose:floating'; assert.equal(await item.host.detach(), false);
  const removes = item.context.calls.filter(c => c === 'remove').length;
  item.context.fail = ''; assert.equal(await item.host.detach(), true);
  assert.equal(item.context.calls.filter(c => c === 'remove').length, removes);
});
test('late dialog completion stays owned after detach; no resurrection', async () => {
  const item = subject(); await item.host.attach(); item.context.pendingOpen = deferred();
  const opening = item.host.openPanel(); assert.equal(await item.host.detach(), false);
  assert(!item.context.contents[0].disposed);
  item.context.pendingOpen.resolve(); assert.equal(await opening, false);
  assert(!item.context.contents[0].disposed, 'late callbacks do not pretend cleanup happened');
  assert.equal(await item.host.openPanel(), false);
  assert.equal(await item.host.detach(), true); assert(item.context.contents[0].disposed);
});
test('close failure retains dialog/node and rejects fresh effects until retry', async () => {
  const item = subject(); await item.host.attach(); await item.host.openPanel();
  item.context.fail = 'close'; assert.equal(await item.host.closePanel(), false);
  assert(!item.context.contents[0].disposed); const opens = item.context.calls.filter(c => c === 'open').length;
  assert.equal(await item.host.openPanel(), false);
  assert.equal(item.context.calls.filter(c => c === 'open').length, opens);
  item.context.fail = ''; assert.equal(await item.host.detach(), true);
});
test('context drift and destroyed-window callback permanently close grants', async () => {
  const item = subject(); await item.host.attach(); await item.host.showFloatingButton();
  item.context.id = 9; assert.equal(await item.host.showFloatingButton(), false);
  item.context.id = 1; assert.equal(await item.host.showFloatingButton(), false);
  assert.equal(item.model.visible, false); await item.host.detach();
  const destroyed = subject(); await destroyed.host.attach(); destroyed.window.emit('windowEvent', 7);
  assert.equal(await destroyed.host.openPanel(), false);
});
test('background hides without automatic restore; current-window events constrain geometry', async () => {
  const item = subject(); await item.host.attach(); await item.host.showFloatingButton();
  assert(item.model.visible); item.window.emit('windowEvent', 4); assert(!item.model.visible);
  item.window.emit('windowEvent', 1); assert(!item.model.visible);
  assert.equal(await item.host.showFloatingButton(), true); assert(item.model.visible);
  item.window.areas.set(3, { left: 0, top: 640, width: 720, height: 640 });
  item.window.emit('avoidAreaChange', { type: 3 });
  assert(item.model.buttonY + 48 <= 320);
  item.window.bounds.width = NaN; item.window.emit('windowSizeChange', {});
  assert(!item.model.visible, 'bad geometry cannot retain a visible button');
});
test('actual geometry separates drag/click, snaps and bounds relative position', () => {
  const item = subject(); item.model.layout(360, 640, []);
  assert.equal(item.model.buttonX, 304); assert(item.model.buttonY > 320 && item.model.buttonY < 560);
  let clicks = 0; item.model.open = () => { clicks++; };
  item.model.beginDrag(); item.model.dragBy(-280, -200); item.model.endDrag(); item.model.activate();
  assert.equal(clicks, 0); assert.equal(item.model.buttonX, 8);
  item.model.activate(); assert.equal(clicks, 1);
  // A different orientation/size bucket starts at its own default.
  item.model.layout(720, 400, []); assert.equal(item.model.buttonX, 664);
  assert(item.model.buttonY >= 8 && item.model.buttonY <= 344);
  item.model.beginDrag(); item.model.dragBy(NaN, 0); item.model.endDrag();
  assert.equal(item.model.placeable, false);
});
test('blocked/invalid rectangles hide; business exclusion is copied and bounded', async () => {
  const item = subject(); await item.host.attach();
  const rect = new api.FloatingRect(); rect.left = 0; rect.top = 0; rect.width = 360; rect.height = 640;
  assert.equal(item.host.setAvoidRects([rect]), true); rect.width = 0;
  assert.equal(await item.host.showFloatingButton(), false, 'blocked copy must remain blocked');
  assert.equal(item.host.setAvoidRects(Array(17).fill(rect)), false);
  assert.equal(item.host.setAvoidRects([]), true); assert.equal(await item.host.showFloatingButton(), true);
});
test('native interactive dismiss delegates to the same owner close action', async () => {
  const item = subject(); let closed = 0; item.model.close = () => { closed++; };
  await item.host.attach(); await item.host.openPanel();
  item.context.dialog.options.onWillDismiss({ dismiss() { assert.fail('must not bypass lifecycle owner'); } });
  assert.equal(closed, 1); await item.host.closePanel();
});
test('cancelled drag restores the previous normalized position and suppresses its click', () => {
  const item = subject(); item.model.layout(360, 640, []);
  const before = [item.model.buttonX, item.model.buttonY]; let opened = 0;
  item.model.open = () => { opened++; };
  item.model.beginDrag(); item.model.dragBy(-280, -200);
  item.model.cancelDrag(); item.model.activate(); assert.equal(opened, 0);
  assert.deepEqual([item.model.buttonX, item.model.buttonY], before);
  item.model.layout(360, 640, []); assert.deepEqual([item.model.buttonX, item.model.buttonY], before);
  item.model.beginInteraction(); item.model.activate(); assert.equal(opened, 1);
});
test('quick menu dispatches only safe actions and rechecks visible/busy/drag gates', () => {
  const item = subject(); item.model.layout(360, 640, []); item.model.visible = true;
  const actions = []; for (const name of ['pause', 'resume', 'mark', 'hide']) item.model[name] = () => actions.push(name);
  for (const name of ['pause', 'resume', 'mark', 'hide']) {
    assert.equal(item.model.requestQuickMenu(), true); item.model.menuAppearing();
    assert.equal(item.model.quickAction(name), true); item.model.menuClosed();
  }
  assert.deepEqual(actions, ['pause', 'resume', 'mark', 'hide']);
  assert.equal(item.model.requestQuickMenu(), true); assert.equal(item.model.quickAction('export'), false);
  item.model.panelBusy = true; assert.equal(item.model.quickAction('mark'), false);
  item.model.panelBusy = false; item.model.visible = false; assert.equal(item.model.quickAction('mark'), false);
  assert.equal(item.model.requestQuickMenu(), false); item.model.visible = true;
  item.model.beginDrag(); assert.equal(item.model.requestQuickMenu(), false); item.model.cancelDrag();
  item.model.clearActions(); assert.equal(item.model.quickAction('hide'), false); assert.equal(actions.length, 4);
});
test('menu appearance suppresses click; late appearance stays closed after hide', () => {
  const item = subject(); item.model.layout(360, 640, []); item.model.visible = true; let opened = 0;
  item.model.open = () => opened++;
  assert.equal(item.model.requestQuickMenu(), true); item.model.menuAppearing();
  item.model.activate(); assert.equal(opened, 0); item.model.closeQuickMenu(); item.model.menuClosed();
  item.model.beginInteraction(); item.model.activate(); assert.equal(opened, 1);
  item.model.visible = false; item.model.menuAppearing(); assert.equal(item.model.quickMenuShown, false);
  assert.equal(item.model.quickAction('mark'), false); item.model.menuClosed();
});
test('menu native disappearance retains exact floating node until explicit detach retry', async () => {
  const item = subject(); await item.host.attach(); await item.host.showFloatingButton();
  item.model.requestQuickMenu(); item.model.menuAppearing();
  const node = item.context.contents[0];
  assert.equal(await item.host.hideFloatingButton(), false); assert.equal(item.model.quickMenuShown, false);
  assert.equal(await item.host.detach(), false); assert(!node.removed && !node.disposed);
  item.model.menuClosed(); assert(!node.disposed, 'late menu callback must not retry detach');
  assert.equal(await item.host.detach(), true); assert(node.removed && node.disposed);
});
test('configuration update uses original scoped nodes and never creates or revives surfaces', async () => {
  const item = subject(); await item.host.attach();
  assert.equal(item.host.updateConfiguration(), true); assert.equal(item.context.contents.length, 0);
  await item.host.showFloatingButton(); await item.host.openPanel();
  assert.equal(item.host.updateConfiguration(), true);
  assert.equal(item.context.calls.filter(c => c === 'configuration:floating').length, 1);
  assert.equal(item.context.calls.filter(c => c === 'configuration:panel').length, 1);
  item.window.emit('windowEvent', 4); assert.equal(item.host.updateConfiguration(), true);
  assert.equal(item.model.visible, false); assert.equal(item.context.contents.length, 2);
  await item.host.closePanel(); assert.equal(item.host.updateConfiguration(), true);
  assert.equal(item.context.calls.filter(c => c === 'configuration:panel').length, 2, 'disposed panel must not update');
  await item.host.detach(); assert.equal(item.host.updateConfiguration(), false);
});
test('configuration failure closes display grants while retaining exact cleanup owners', async () => {
  const item = subject(); await item.host.attach(); await item.host.showFloatingButton(); await item.host.openPanel();
  item.context.contents[1].updateConfiguration = () => { throw Error('private-configuration-error'); };
  assert.equal(item.host.updateConfiguration(), false); assert.equal(item.model.visible, false);
  const calls = item.context.calls.length;
  assert.equal(item.host.updateConfiguration(), false); assert.equal(item.context.calls.length, calls);
  assert.equal(await item.host.showFloatingButton(), false);
  assert.equal(await item.host.detach(), true); assert(item.context.contents.every(node => node.disposed));
});
test('keyboard menu and cancel consume only their keys; Enter/Space delegate native button click', () => {
  const item = subject(); item.model.layout(360, 640, []); item.model.visible = true;
  assert.equal(item.model.keyAction(2067, false), false);
  assert.equal(item.model.keyAction(2067, true), true); assert.equal(item.model.quickMenuShown, true);
  assert.equal(item.model.keyAction(2070, true), true); assert.equal(item.model.quickMenuShown, false);
  assert.equal(item.model.keyAction(2070, true), false);
  let opened = 0; item.model.open = () => opened++;
  for (const key of [2050, 2054]) {
    item.model.beginDrag(); item.model.dragBy(10, 10); item.model.cancelDrag();
    assert.equal(item.model.keyAction(key, true), false); item.model.activate();
  }
  assert.equal(opened, 2); assert.equal(item.model.keyAction(2099, true), false);
  item.model.visible = false; assert.equal(item.model.keyAction(2067, true), false);
});
test('a requested but not yet appearing native menu retains the floating owner during detach', async () => {
  const item = subject(); await item.host.attach(); await item.host.showFloatingButton();
  assert.equal(item.model.requestQuickMenu(), true);
  const node = item.context.contents[0];
  assert.equal(await item.host.detach(), false); assert(!node.disposed);
  item.model.menuAppearing(); assert.equal(item.model.quickMenuShown, false);
  assert.equal(item.model.quickAction('mark'), false);
  item.model.menuClosed(); assert.equal(await item.host.detach(), true); assert(node.disposed);
});
test('blocked or invalid geometry closes the requested menu without discarding native ownership', async () => {
  for (const invalid of [false, true]) {
    const item = subject(); await item.host.attach(); await item.host.showFloatingButton();
    item.model.requestQuickMenu(); item.model.menuAppearing();
    const rect = new api.FloatingRect(); rect.width = 360; rect.height = 640;
    assert.equal(item.host.setAvoidRects(invalid ? Array(17).fill(rect) : [rect]), !invalid);
    assert.equal(item.model.quickMenuShown, false); assert.equal(item.model.quickAction('mark'), false);
    assert.equal(await item.host.detach(), false); assert(!item.context.contents[0].disposed);
    item.model.menuClosed(); assert.equal(await item.host.detach(), true);
  }
});
test('quick hide waits for native menu disappearance; cancellation never dispatches the late action', () => {
  const item = subject(); item.model.layout(360, 640, []); item.model.visible = true; let hides = 0;
  item.model.hide = () => hides++;
  item.model.requestQuickMenu(); item.model.menuAppearing();
  assert.equal(item.model.quickAction('hide'), true); assert.equal(hides, 0);
  item.model.menuClosed(); assert.equal(hides, 1);
  item.model.menuClosed(); assert.equal(hides, 1, 'duplicate disappearance cannot re-dispatch');
  item.model.requestQuickMenu(); item.model.menuAppearing(); item.model.quickAction('hide');
  item.model.closeQuickMenu(); item.model.menuClosed(); assert.equal(hides, 1);
  item.model.requestQuickMenu(); item.model.menuAppearing(); item.model.quickAction('hide');
  item.model.visible = false; item.model.menuClosed(); assert.equal(hides, 1);
});
test('late position reads cannot mutate a host after invalid geometry, configuration or close failure', async () => {
  for (const failure of ['business', 'configuration', 'close']) {
    const item = subject(), pending = deferred();
    item.model.configurePosition({ read: async () => {
      await pending.promise; return { rightSide: false, edgeRatio: 0.1 };
    }, write: async () => true }, 'main');
    await item.host.attach(); await item.host.showFloatingButton();
    const original = [item.model.buttonX, item.model.buttonY];
    if (failure === 'business') assert.equal(item.host.setAvoidRects(Array(17).fill(new api.FloatingRect())), false);
    else if (failure === 'configuration') {
      item.context.contents[0].updateConfiguration = () => { throw Error('private-config'); };
      assert.equal(item.host.updateConfiguration(), false);
    } else {
      await item.host.openPanel(); item.context.fail = 'close';
      assert.equal(await item.host.closePanel(), false); item.context.fail = '';
    }
    pending.resolve(); for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual([item.model.buttonX, item.model.buttonY], original, failure);
    assert.equal(item.model.visible, false);
  }
});
