/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Runs the actual platform-independent .ets sources on Node. This is not a
// HarmonyOS crypto, transport, UI or device test.
import assert from 'node:assert/strict';
import { test, after, describe } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes, createHash, createHmac, generateKeyPairSync, createPublicKey, diffieHellman,
  hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { build } from 'esbuild';
import { PairingAuthority } from '../packages/cli/src/debug-protocol/pairing-authority.ts';
import { canonicalJson } from '../packages/cli/src/debug-protocol/canonical-hash.ts';
import { EventEnvelopeSchema } from '../packages/cli/src/debug-protocol/envelopes.ts';
import { buildKitProfile } from '../packages/cli/src/problem-package/kit-profile.ts';
import { verifyProblemPackage, verifyProblemArchive } from '../packages/cli/src/problem-package/package.ts';
import { readProblemZip, readProblemZipAt } from '../packages/cli/src/problem-package/zip.ts';
import { validateMockRules } from '../packages/cli/src/debug-protocol/network-mock.ts';
import { registerSemanticReplayTests, registerSemanticReplayControllerTests, registerSemanticReplayPageTests } from './kit-semantic-replay-tests.mjs';
import { registerResourceFileTests } from './kit-resource-file-tests.mjs';
import { registerResourceStreamTests } from './kit-resource-stream-tests.mjs';
import { registerM3ClockTests } from './kit-m3-clock-tests.mjs';
import { registerM3ConsentTests, registerM3ControllerConsentTests } from './kit-m3-consent-tests.mjs';
import { registerFaultLogTests } from './kit-faultlog-tests.mjs';
import { registerLeakWatcherTests } from './kit-leak-watcher-tests.mjs';
import { registerRawHeapTests } from './kit-rawheap-tests.mjs';

// The suite waits for all asynchronous source builds before fixtures or cleanup run.
await describe('actual portable Kit with explicit platform substitutes', async () => {
const temporary = await mkdtemp(path.join(tmpdir(), 'ohmate-arkts-core-'));
after(() => rm(temporary, { recursive: true, force: true }));
await registerFaultLogTests({ temporary });
await registerLeakWatcherTests({ temporary });
await registerRawHeapTests({ temporary });
const entry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/PairingSession.ets', import.meta.url));
try {
  await build({ entryPoints: [entry], outfile: path.join(temporary, 'core.mjs'), bundle: true,
    platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
const { PairingSession, parsePairing, canonical, makeMetricEvent } = await import(pathToFileURL(path.join(temporary, 'core.mjs')));

class NodePort {
  cleared = false;
  encode(text) { return new TextEncoder().encode(text); }
  decode(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  base64(bytes) { return Buffer.from(bytes).toString('base64'); }
  unbase64(text) { return new Uint8Array(Buffer.from(text, 'base64')); }
  random(size) { return new Uint8Array(randomBytes(size)); }
  hash(text) { return createHash('sha256').update(text).digest('hex'); }
  proof(code, text) { return createHmac('sha256', code).update(text).digest('hex'); }
  ephemeral() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }
  derive(remote, transcript) {
    const secret = diffieHellman({ privateKey: this.privateKey,
      publicKey: createPublicKey({ key: Buffer.from(remote, 'base64'), type: 'spki', format: 'der' }) });
    this.sendKey = Buffer.from(hkdfSync('sha256', secret, Buffer.from(transcript, 'hex'), 'ohmate/debug/1/kit-to-cli', 32));
    this.receiveKey = Buffer.from(hkdfSync('sha256', secret, Buffer.from(transcript, 'hex'), 'ohmate/debug/1/cli-to-kit', 32));
    secret.fill(0); this.privateKey = undefined;
  }
  encrypt(bytes, iv, aad) {
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv);
    cipher.setAAD(aad);
    return new Uint8Array(Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]));
  }
  decrypt(bytes, tag, iv, aad) {
    const cipher = createDecipheriv('aes-256-gcm', this.receiveKey, iv);
    cipher.setAAD(aad); cipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([cipher.update(bytes), cipher.final()]));
  }
  clear() {
    this.sendKey?.fill(0); this.receiveKey?.fill(0);
    this.privateKey = undefined; this.cleared = true;
  }
}
globalThis.ObservedV2 = (target) => target;
globalThis.Trace = () => {};
globalThis.canIUse = () => true;
globalThis.__kitTest = { Port: NodePort };
const controllerEntry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/ProducerController.ets', import.meta.url));
await build({
  entryPoints: [controllerEntry], outfile: path.join(temporary, 'controller.mjs'), bundle: true,
  platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  plugins: [{
    name: 'explicit-platform-test-double',
    setup(builder) {
      builder.onResolve({ filter: /^@kit\.|\/PlatformCrypto$|\/PlatformMetrics$/ }, (args) => ({ path: args.path, namespace: 'kit-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'kit-test' }, (args) => ({
        contents: args.path.endsWith('/PlatformCrypto') ? 'export class PlatformCrypto extends globalThis.__kitTest.Port {}' :
          args.path.endsWith('/PlatformMetrics') ? 'export const PSS_SOURCE_API = "hidebug.getPss"; export const CPU_SOURCE_API = "hidebug.getCpuUsage"; export function readPssBytes() { throw Error("must execute via taskpool"); } export function readCpuPercent() { throw Error("must execute via taskpool"); }' :
            'export const webSocket = { createWebSocket: () => globalThis.__kitTest.socketFactory() };' +
            'export const http = { RequestMethod:{ GET:"GET" }, HttpDataType:{ STRING:0, OBJECT:1, ARRAY_BUFFER:2 } };' +
            'export const WebNetErrorList = {ERR_ABORTED:-3};' +
            'export const webview = { JsMessageType:{ NOT_SUPPORT:0, STRING:1, NUMBER:2, BOOLEAN:3, ARRAY_BUFFER:4, ARRAY:5 },' +
            'WebResourceType:{STYLE_SHEET:2,XHR:13},' +
            'WebSchemeHandler:class {constructor(){return new globalThis.__kitTest.resourceStreamWebview.WebSchemeHandler();}},' +
            'WebSchemeHandlerResponse:class {constructor(){return new globalThis.__kitTest.resourceStreamWebview.WebSchemeHandlerResponse();}},' +
            'WebCookieManager:{fetchCookie:(...args)=>globalThis.__kitTest.cookies(...args)} };' +
            'export const url = { URL: { parseURL: (text) => new globalThis.URL(text) } };' +
            'export const bundleManager = { BundleFlag: { GET_BUNDLE_INFO_WITH_APPLICATION: 1 },' +
            'getBundleInfoForSelfSync: () => ({ name:"dev.ohmate.kitproducer", versionCode:1, appInfo:{debug:globalThis.__kitTest.debug} }) };' +
            'export const process = { pid:1234 }; export const taskpool = { execute: (fn) => fn.name === "readCpuPercent" ? globalThis.__kitTest.cpu() : globalThis.__kitTest.sample() };' +
            'export const hiAppEvent = { domain:{OS:"OS"}, event:{APP_CRASH:"APP_CRASH",APP_FREEZE:"APP_FREEZE"},' +
            'EventType:{FAULT:1,STATISTIC:2,SECURITY:4,BEHAVIOR:8}, addWatcher:(watcher)=>globalThis.__kitTest.addWatcher(watcher), removeWatcher:(watcher)=>globalThis.__kitTest.removeWatcher(watcher) };' +
            'export const ChildrenCountMode = { ONLY_EXPANDED:1 }; export const ExpandMode = { NOT_EXPAND:0 };' +
            'export const image = { createImagePacker: () => globalThis.__kitTest.packer() };' +
            'export const systemDateTime = { TimeType:{ STARTUP:1 }, getUptime: () => 100 };' +
            'export const picker = { DocumentViewPicker: class { save(options) { return globalThis.__kitTest.save(options); } } };' +
            'export const fileIo = new Proxy({}, { get: (_, key) => globalThis.__kitTest.fileIo[key] });',
        loader: 'js',
      }));
    },
  }],
});
const { ProducerController } = await import(pathToFileURL(path.join(temporary, 'controller.mjs')));
await build({
  entryPoints: [fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/WebResourceFiles.ets', import.meta.url))],
  outfile: path.join(temporary, 'resource-files.mjs'), bundle: true, platform: 'node', format: 'esm',
  loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
  plugins: [{ name: 'explicit-resource-file-substitute', setup(builder) {
    builder.onResolve({ filter: /^@kit\./ }, (args) => ({ path: args.path, namespace: 'resource-file-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'resource-file-test' }, () => ({
      contents: 'export const url = {URL:{parseURL:(value)=>new globalThis.URL(value)}};' +
        'export const webview = {};' +
        'export const fileIo = new Proxy({}, {get:(_,key)=>globalThis.__kitTest.resourceFileIo[key]});',
      loader: 'js',
    }));
  } }],
});
const { WebResourceFiles } = await import(pathToFileURL(path.join(temporary, 'resource-files.mjs')));
registerResourceFileTests({ WebResourceFiles, NodePort });
const streamDirectory = path.dirname(controllerEntry);
await build({
  stdin: { contents: 'export {WebResourceStream} from "./WebResourceStream"; export {WebResourceOverride} from "./WebResourceOverride"; export {NetworkMock} from "./NetworkMock"; export {WebConsoleSession} from "./WebConsoleSession"; export {NetworkBodyCapture} from "./NetworkBodyCapture";',
    resolveDir: streamDirectory, loader: 'ts' },
  outfile: path.join(temporary, 'resource-stream.mjs'), bundle: true, platform: 'node', format: 'esm',
  loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
  plugins: [{ name: 'explicit-resource-stream-substitute', setup(builder) {
    builder.onResolve({ filter: /^@kit\./ }, (args) => ({ path: args.path, namespace: 'resource-stream-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'resource-stream-test' }, () => ({
      contents: 'export const url = {URL:{parseURL:(value)=>new globalThis.URL(value)}};' +
        'export const http = {RequestMethod:{GET:"GET"},HttpDataType:{STRING:0}};' +
        'export const WebNetErrorList = {ERR_ABORTED:-3};' +
        'export const webview = new Proxy({}, {get:(_,key)=>key==="JsMessageType"?' +
          '{NOT_SUPPORT:0,STRING:1,NUMBER:2,BOOLEAN:3,ARRAY_BUFFER:4,ARRAY:5}:' +
          'globalThis.__kitTest.resourceStreamWebview[key]});',
      loader: 'js',
    }));
  } }],
});
const { WebResourceStream, WebResourceOverride, NetworkMock, WebConsoleSession, NetworkBodyCapture } =
  await import(pathToFileURL(path.join(temporary, 'resource-stream.mjs')));
registerResourceStreamTests({ WebResourceStream, WebResourceOverride, NodePort });
registerM3ClockTests({ NetworkMock, WebResourceOverride, NodePort });
registerM3ConsentTests({ NetworkBodyCapture, WebConsoleSession, NodePort });
const storageWriteEntry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/StorageWriteSession.ets', import.meta.url));
let StorageWriteSession;
if (fs.existsSync(storageWriteEntry)) {
  await build({ entryPoints: [storageWriteEntry], outfile: path.join(temporary, 'storage-write.mjs'),
    bundle: true, platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
  ({ StorageWriteSession } = await import(pathToFileURL(path.join(temporary, 'storage-write.mjs'))));
}
const highlightEntry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/UiHighlightSession.ets', import.meta.url));
let UiHighlightSession, readUiHighlightSource;
if (fs.existsSync(highlightEntry)) {
  await build({ entryPoints: [highlightEntry], outfile: path.join(temporary, 'ui-highlight.mjs'),
    bundle: true, platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
  ({ UiHighlightSession } = await import(pathToFileURL(path.join(temporary, 'ui-highlight.mjs'))));
}
const replayEntry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/SemanticReplaySession.ets', import.meta.url));
let SemanticReplaySession;
if (fs.existsSync(replayEntry)) {
  await build({ entryPoints: [replayEntry], outfile: path.join(temporary, 'semantic-replay.mjs'),
    bundle: true, platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
  ({ SemanticReplaySession } = await import(pathToFileURL(path.join(temporary, 'semantic-replay.mjs'))));
}
registerSemanticReplayTests({ SemanticReplaySession, NodePort });
globalThis.__kitTest.SemanticReplaySession = SemanticReplaySession;
const highlightPlatform = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/PlatformUiHighlight.ets', import.meta.url));
if (fs.existsSync(highlightPlatform)) {
  await build({ entryPoints: [highlightPlatform], outfile: path.join(temporary, 'ui-highlight-platform.mjs'),
    bundle: true, platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
    plugins: [{ name: 'explicit-highlight-platform-substitute', setup(builder) {
      builder.onResolve({ filter: /^@kit\./ }, (args) => ({ path: args.path, namespace: 'highlight-kit-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'highlight-kit-test' }, () => ({
        contents: 'export const ChildrenCountMode = {ONLY_EXPANDED:1}; export const ExpandMode = {NOT_EXPAND:0};',
        loader: 'js',
      }));
    } }] });
  ({ readUiHighlightSource } = await import(pathToFileURL(path.join(temporary, 'ui-highlight-platform.mjs'))));
}
const pagePath = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/pages/Index.ets', import.meta.url));
// Only ordinary page methods are executable on Node. ArkUI builders/rendering
// and all actual Phone UX remain outside this explicit platform substitute.
const pageMethods = (await readFile(pagePath, 'utf8')).split('  @Builder')[0]
  .replace(/^@(Entry|ComponentV2)\r?$/gm, '').replace('struct Index', 'export class Index')
  .replace(/@Local /g, '').replace(/^  @Monitor\([^\n]*\)\r?\n/gm, '') + '\n}\n';
await build({ stdin: { contents: pageMethods, sourcefile: pagePath, resolveDir: path.dirname(pagePath), loader: 'ts' },
  outfile: path.join(temporary, 'page-methods.mjs'), bundle: true, platform: 'node', format: 'esm',
  resolveExtensions: ['.ets', '.ts', '.js'], plugins: [{ name: 'explicit-page-method-substitute', setup(builder) {
    builder.onResolve({ filter: /\/ProducerController$|^@kit\./ }, (args) => ({ path: args.path, namespace: 'page-method-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'page-method-test' }, (args) => ({
      contents: args.path.endsWith('/ProducerController') ? 'export const producer = globalThis.__kitTest.pageProducer;' :
        'export const webview = { WebviewController: class {} }; export const http = {RequestMethod:{GET:"GET"},HttpDataType:{STRING:0},createHttp:()=>globalThis.__kitTest.createHttp()}; export const HdsNavigation = {}; export const HdsNavigationTitleMode = {};',
      loader: 'js',
    }));
  } }] });
let pageProducer;
globalThis.__kitTest.pageProducer = new Proxy({}, { get: (_target, name) => {
  if (!pageProducer) throw Error('Page fixture required');
  const value = pageProducer[name]; return typeof value === 'function' ? value.bind(pageProducer) : value;
} });
const { Index: ProducerPage } = await import(pathToFileURL(path.join(temporary, 'page-methods.mjs')));
const metricsPath = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/PlatformMetrics.ets', import.meta.url));
// Node cannot execute @Concurrent; the conversion body is real, the platform API is substituted.
await build({ stdin: { contents: (await readFile(metricsPath, 'utf8')).replaceAll('@Concurrent\n', ''),
  sourcefile: metricsPath, resolveDir: path.dirname(metricsPath), loader: 'ts' },
  outfile: path.join(temporary, 'metrics.mjs'), platform: 'node', bundle: true, format: 'esm',
  plugins: [{ name: 'explicit-hidebug-test-double', setup(builder) {
    builder.onResolve({ filter: /^@kit\./ }, (args) => ({ path: args.path, namespace: 'kit-metrics-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'kit-metrics-test' }, () => ({
      contents: 'export const hidebug = { getPss: () => globalThis.__kitTest.nativePss(), getCpuUsage: () => globalThis.__kitTest.nativeCpu() };', loader: 'js',
    }));
  } }] });
const { readPssBytes, readCpuPercent } = await import(pathToFileURL(path.join(temporary, 'metrics.mjs')));
after(() => {
  delete globalThis.ObservedV2; delete globalThis.Trace; delete globalThis.canIUse; delete globalThis.__kitTest;
});
class TestSocket {
  handlers = new Map();
  sent = [];
  closed = false;
  on(type, handler) { this.handlers.set(type, handler); }
  off(type) { this.handlers.delete(type); }
  async connect(endpoint, options) { this.endpoint = endpoint; this.options = options; this.handlers.get('open')?.(); return true; }
  async send(text) { this.sent.push(JSON.parse(text)); return true; }
  async close() { this.closed = true; return true; }
  message(value) { this.handlers.get('message')?.(undefined, JSON.stringify(value)); }
}
const settle = async () => { for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); } };
function controllerFixture(context) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const socket = new TestSocket();
  globalThis.__kitTest.socketFactory = () => socket;
  globalThis.__kitTest.debug = true;
  globalThis.__kitTest.sample = async () => 4096;
  globalThis.__kitTest.cpu = async () => 25;
  globalThis.__kitTest.addWatcher = () => ({});
  globalThis.__kitTest.removeWatcher = () => {};
  globalThis.__kitTest.save = async () => { throw Error('unexpected picker'); };
  globalThis.__kitTest.fileIo = {
    OpenMode: { READ_WRITE: fs.constants.O_RDWR, CREATE: fs.constants.O_CREAT, NOFOLLOW: fs.constants.O_NOFOLLOW },
    openSync: (name, flags) => ({ fd: fs.openSync(name, flags, 0o600) }),
    statSync: fs.fstatSync, closeSync: (file) => fs.closeSync(file.fd), fsyncSync: fs.fsyncSync,
    writeSync: (fd, bytes) => fs.writeSync(fd, Buffer.from(bytes)),
  };
  const controller = new ProducerController();
  controller.initialize();
  const target = { project: 'test-project' };
  for (const line of controller.state.localTarget.split('\n')) {
    const [key, value] = line.split(' ');
    target[key.slice(2)] = value;
  }
  const authority = new PairingAuthority({ now: () => now });
  const invitation = authority.issue(target);
  const text = JSON.stringify({ endpoint: 'ws://127.0.0.1:12345/bridge/v1', invitation });
  context.after(async () => { await controller.stop(); authority.close(); });
  return { controller, socket, authority, text };
}
function uiFixture(context, root = uiNode(1, 'Column', [uiNode(2, 'Text')])) {
  const fixture = controllerFixture(context);
  let reads = 0;
  const uiContext = { getFrameNodeById: (id) => {
    reads++; assert.equal(id, 'bridge_capture_root'); return root;
  }, px2vp: (pixels) => pixels / 2 };
  fixture.controller.registerUi(uiContext, 'bridge_capture_root', 'page-main');
  return { ...fixture, uiContext, reads: () => reads };
}
function uiNode(id, role, children = []) {
  return {
    getUniqueId: () => id, getNodeType: () => role,
    isDisposed: () => false, isAttached: () => true, isVisible: () => true,
    getPositionToWindow: () => ({ x: -3, y: 7 }),
    getMeasuredSize: () => ({ width: 240, height: 80 }),
    getChildrenCount: (mode) => { assert.equal(mode, 1, 'Only expanded nodes may be counted'); return children.length; },
    getChild: (index, mode) => { assert.equal(mode, 0, 'Capture must not expand a lazy child'); return children[index]; },
    getInspectorInfo: () => { throw Error('private text must never be queried'); },
    getId: () => { throw Error('arbitrary app identifiers must never be queried'); },
  };
}
async function connectUi(context, root, configure = () => {}) {
  const fixture = uiFixture(context, root);
  configure(fixture);
  fixture.controller.review(fixture.text); await fixture.controller.confirm();
  const accepted = fixture.authority.accept(fixture.socket.sent[0]);
  fixture.socket.message(accepted.reply);
  const epoch = '00000000-0000-4000-8000-000000000002';
  fixture.socket.message(accepted.channel.seal({ type: 'ready', sessionEpoch: epoch }));
  await settle();
  assert.deepEqual(accepted.channel.open(fixture.socket.sent[1]), {
    type: 'ready', sessionEpoch: epoch, clockSync: 'four-timestamp-v1',
    eventBatch: 'events-v1', retention: 'rolling-v1',
  });
  fixture.socket.message(accepted.channel.seal({
    type: 'connected', sessionEpoch: epoch, eventBatch: 'events-v1', retention: 'rolling-v1',
  }));
  await settle();
  assert.equal(fixture.controller.state.phase, 'connected');
  return { ...fixture, accepted, epoch };
}

function snapshotPort() {
  const calls = { snapshot: 0, info: 0, pack: 0, pixelRelease: 0, packerRelease: 0 };
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);
  const pixel = { getPixelBytesNumber: () => 1024,
    getImageInfo: async () => { calls.info++; return { size: { width: 120, height: 40 } }; },
    release: async () => { calls.pixelRelease++; } };
  const packer = { packToData: async (source, options) => {
    calls.pack++; assert.equal(source, pixel);
    assert.deepEqual(options, { format: 'image/png', quality: 100, bufferSize: 262144, needsPackProperties: false });
    return Uint8Array.from(bytes).buffer;
  }, release: async () => { calls.packerRelease++; } };
  return { calls, pixel, packer, bytes };
}
async function connectSnapshot(context, source = snapshotPort(), allowed = true) {
  const root = uiNode(1, 'Column'), target = uiNode(2, 'Column');
  target.getParent = () => root;
  const fixture = await connectUi(context, root, ({ controller, uiContext }) => {
    controller.registerUi(uiContext, 'bridge_capture_root', 'page-main', allowed);
    uiContext.getFrameNodeById = (id) => {
      assert(['bridge_capture_root', 'bridge_snapshot_target'].includes(id)); return id === 'bridge_capture_root' ? root : target;
    };
    uiContext.getComponentSnapshot = () => ({
      getWithUniqueId: async (id, options) => {
        source.calls.snapshot++; assert.equal(id, 2);
        assert.deepEqual(options, { scale: 1, waitUntilRenderFinished: true });
        return source.pixel;
      },
    });
    globalThis.__kitTest.packer = () => source.packer;
  });
  return { ...fixture, source, root, target };
}
function highlightFixture(context) {
  assert.equal(typeof UiHighlightSession, 'function', 'Actual ArkTS UI highlight owner must exist');
  const initial = Date.now();
  let now = initial;
  const originalNow = Date.now;
  Date.now = () => now;
  context.after(() => { Date.now = originalNow; });
  let source = { targetId: 'bridge_snapshot_target', windowId: 'page-main', sourceHash: 'a'.repeat(64),
    binding: 'b'.repeat(64), deadline: initial + 60000 };
  const calls = [];
  let held = '';
  let clearFails = false;
  const host = {
    apply: (commandId) => { calls.push(['apply', commandId]); held = commandId; return true; },
    clear: (commandId) => {
      calls.push(['clear', commandId]);
      if (clearFails) throw Error('PRIVATE_HOST_ERROR');
      if (held && held !== commandId) return false;
      held = ''; return true;
    },
  };
  const owner = new UiHighlightSession(new NodePort(), () => source, host);
  context.after(() => { clearFails = false; owner.dispose(); owner.retryClear(); });
  return { owner, host, calls, initial, held: () => held, time: (value) => { now = value; },
    source: (value) => { source = value; }, currentSource: () => source,
    failClear: (value) => { clearFails = value; } };
}
test('UI highlight is independently reviewed, confirmed, single-use and clears only its command', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  assert.equal(review.scope, 'ui.highlight'); assert.equal(review.risk, 'R2');
  assert.equal(review.targetId, 'bridge_snapshot_target');
  assert.equal(review.expiresAt, f.initial + 30000); assert.equal(review.durationMs, 3000);
  assert.equal(review.idempotencyKey, review.commandId); assert.match(review.planHash, /^[a-f0-9]{64}$/);
  review.planHash = 'tampered'; assert.equal(f.owner.confirm(review.planHash), false);
  const hash = f.owner.status().planHash;
  assert.equal(f.owner.apply(hash), false); assert.equal(f.calls.length, 0);
  assert.equal(f.owner.confirm(hash), true); assert.equal(f.owner.apply(hash), true);
  assert.equal(f.held(), review.commandId); assert.equal(f.owner.status().pendingCleanup, 1);
  assert.equal(f.owner.apply(hash), false); assert.equal(f.owner.confirm(hash), false);
  f.owner.cancel(); assert.equal(f.held(), ''); assert.equal(f.owner.status().pendingCleanup, 0);
  assert.deepEqual(f.calls, [['apply', review.commandId], ['clear', review.commandId]]);
  assert.equal(f.owner.apply(hash), false);
});
test('UI highlight registers recovery before a throwing or rejecting host can affect state', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.host.apply = (id) => {
    assert.equal(f.owner.status().pendingCleanup, 1);
    f.calls.push(['apply', id]); throw Error('PRIVATE_HOST_ERROR');
  };
  f.failClear(true); f.owner.confirm(review.planHash);
  assert.equal(f.owner.apply(review.planHash), false);
  assert.equal(f.owner.status().pendingCleanup, 1);
  assert.equal(f.owner.status().revocation, 'cleanup-failed');
  assert(!JSON.stringify(f.owner.status()).includes('PRIVATE_HOST_ERROR'));
  const count = f.calls.length; f.owner.status(); f.owner.cancel(); f.owner.dispose();
  assert.equal(f.calls.length, count, 'Failure must not cause automatic repeated cleanup');
  assert.throws(() => f.owner.review());
  f.failClear(false); assert.equal(f.owner.retryClear(), true);
  assert.equal(f.owner.status().pendingCleanup, 0);
});
for (const change of ['sourceHash', 'binding', 'windowId', 'deadline', 'missing']) {
  test(`UI highlight permanently rejects ${change} drift and clears owned outline`, (context) => {
    const f = highlightFixture(context), original = f.currentSource(), review = f.owner.review();
    f.owner.confirm(review.planHash); assert.equal(f.owner.apply(review.planHash), true);
    f.source(change === 'missing' ? undefined : { ...original,
      [change]: change === 'deadline' ? original.deadline - 1 : 'changed' });
    assert.equal(f.owner.status().pendingCleanup, 0); assert.equal(f.held(), '');
    f.source(original); assert.equal(f.owner.apply(review.planHash), false);
    assert.equal(f.owner.confirm(review.planHash), false);
  });
}
test('UI highlight checks display expiry synchronously and cannot renew consumed review', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.owner.confirm(review.planHash); f.time(f.initial + 29900);
  assert.equal(f.owner.apply(review.planHash), true);
  assert.equal(f.owner.status().displayExpiresAt, review.expiresAt);
  f.time(review.expiresAt); assert.equal(f.owner.status().pendingCleanup, 0);
  assert.equal(f.held(), ''); assert.equal(f.owner.apply(review.planHash), false);
});
test('UI highlight default three-second display deadline clears even before timer callback', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.owner.confirm(review.planHash); f.owner.apply(review.planHash);
  f.time(f.initial + 3000); assert.equal(f.owner.status().pendingCleanup, 0); assert.equal(f.held(), '');
});
test('UI highlight backward clock permanently closes owner even after time recovers', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.owner.confirm(review.planHash); f.owner.apply(review.planHash);
  f.time(f.initial - 1); assert.equal(f.owner.status().pendingCleanup, 0);
  f.time(f.initial + 1000); assert.throws(() => f.owner.review());
  assert.equal(f.owner.apply(review.planHash), false);
});
test('UI highlight one-Hz rate and non-evicted attempt budget include rejected reviews', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.owner.confirm(review.planHash); f.owner.apply(review.planHash); f.owner.cancel();
  const next = f.owner.review(); f.owner.confirm(next.planHash);
  assert.equal(f.owner.apply(next.planHash), false);
  f.time(f.initial + 1000); assert.equal(f.owner.apply(next.planHash), true); f.owner.cancel();
  for (let index = 2; index < 256; index++) assert.throws(() => f.owner.review(30001));
  assert.throws(() => f.owner.review());
  assert.equal(f.owner.apply(review.planHash), false);
});
test('UI highlight default host absence is unavailable and cannot create a grant', (context) => {
  const f = highlightFixture(context);
  const missing = new UiHighlightSession(new NodePort(), f.currentSource);
  context.after(() => missing.dispose());
  assert.throws(() => missing.review()); assert.equal(missing.status().pendingCleanup, 0);
});
test('UI highlight refused host cleanup remains a responsibility until explicit retry', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  const originalClear = f.host.clear;
  f.host.clear = () => false; f.owner.confirm(review.planHash); f.owner.apply(review.planHash);
  f.owner.dispose(); assert.equal(f.owner.status().pendingCleanup, 1);
  f.host.clear = originalClear; assert.equal(f.owner.retryClear(), true);
  assert.throws(() => f.owner.review(), 'Disposed owner cannot be revived');
});
test('UI highlight dispose releases the host after cleanup but retains it while responsibility remains', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.owner.confirm(review.planHash); f.owner.apply(review.planHash);
  f.failClear(true); f.owner.dispose(); assert.equal(f.owner.host, f.host);
  f.failClear(false); assert.equal(f.owner.retryClear(), true);
  assert.equal(f.owner.host, undefined, 'Disposed completed owner must not retain the page callback');
});
test('UI highlight platform source binds ancestry but does not hash moving layout or read text', () => {
  assert.equal(typeof readUiHighlightSource, 'function', 'Actual ArkTS highlight platform source must exist');
  const root = uiNode(1, 'Column'), target = uiNode(2, 'Column');
  target.getParent = () => root;
  const context = { getFrameNodeById: (id) => {
    assert(['bridge_capture_root', 'bridge_snapshot_target'].includes(id));
    return id === 'bridge_capture_root' ? root : target;
  }, px2vp: (value) => value / 2 };
  const port = new NodePort(), first = readUiHighlightSource(context, port);
  assert.match(first, /^[a-f0-9]{64}$/);
  target.getPositionToWindow = () => ({ x: 5, y: 400 });
  assert.equal(readUiHighlightSource(context, port), first);
  target.getParent = () => uiNode(3, 'Column');
  assert.throws(() => readUiHighlightSource(context, port));
});
test('UI highlight accepts separate native proxy objects for the same system root unique ID', () => {
  const root = uiNode(1, 'Column'), proxy = uiNode(1, 'Column'), target = uiNode(2, 'Column');
  target.getParent = () => proxy;
  const context = { getFrameNodeById: (id) => id === 'bridge_capture_root' ? root : target, px2vp: (value) => value };
  assert.match(readUiHighlightSource(context, new NodePort()), /^[a-f0-9]{64}$/);
});
async function connectHighlight(context, configure = () => {}) {
  const calls = [];
  let held = '', clearFails = false;
  const host = {
    apply: (id) => { calls.push(['apply', id]); held = id; return true; },
    clear: (id) => { calls.push(['clear', id]); if (clearFails) return false;
      if (held && held !== id) return false; held = ''; return true; },
  };
  const root = uiNode(1, 'Column'), target = uiNode(2, 'Column');
  target.getParent = () => root;
  const fixture = await connectUi(context, root, (f) => {
    f.uiContext.getFrameNodeById = (id) => id === 'bridge_capture_root' ? root : target;
    f.controller.registerUi(f.uiContext, 'bridge_capture_root', 'page-main', false, host);
    configure(f);
  });
  context.after(() => { clearFails = false; fixture.controller.retryUiHighlightCleanup?.(); });
  return { ...fixture, root, target, host, calls, held: () => held, failClear: (value) => { clearFails = value; } };
}
test('UI highlight controller host absence stays default closed without a review', async (context) => {
  const f = await connectSnapshot(context);
  assert.equal(typeof f.controller.uiHighlightAvailable, 'function');
  assert.equal(f.controller.uiHighlightAvailable(), false);
  assert.throws(() => f.controller.reviewUiHighlight());
});
test('UI highlight controller separates review confirm execute, clears stale samples and never sends write frames', async (context) => {
  const f = await connectHighlight(context), controller = f.controller;
  assert.equal(typeof controller.reviewUiHighlight, 'function');
  assert.equal(await controller.captureUi(), true); assert(controller.uiFile());
  controller.cancelExport();
  controller.state.screenshotData = 'PRIVATE_OLD_PREVIEW';
  controller.uiSample = JSON.stringify({ old: true });
  controller.exportBytes = Uint8Array.from([1, 2, 3]); const exportBytes = controller.exportBytes;
  controller.state.exportPhase = 'review';
  const before = f.socket.sent.length, review = controller.reviewUiHighlight();
  assert.equal(controller.executeUiHighlight(review.planHash), false); assert.equal(f.calls.length, 0);
  assert.equal(controller.confirmUiHighlight(review.planHash), true);
  assert.equal(controller.executeUiHighlight(review.planHash), true);
  assert.equal(f.held(), review.commandId); assert.equal(controller.uiFile(), undefined);
  assert.equal(controller.state.screenshotData, ''); assert(exportBytes.every((byte) => byte === 0));
  assert.equal(controller.state.exportPhase, 'idle'); assert.equal(f.socket.sent.length, before);
  assert.equal(controller.executeUiHighlight(review.planHash), false);
  controller.cancelUiHighlight(); assert.equal(f.held(), '');
});
for (const action of ['stop', 'source', 'debug', 'epoch', 'identity', 'window']) {
  test(`UI highlight controller ${action} invalidates before host cleanup`, async (context) => {
    const f = await connectHighlight(context), controller = f.controller;
    assert.equal(typeof controller.reviewUiHighlight, 'function');
    const review = controller.reviewUiHighlight(); controller.confirmUiHighlight(review.planHash);
    assert.equal(controller.executeUiHighlight(review.planHash), true);
    if (action === 'stop') await controller.stop('BACKGROUND');
    if (action === 'source') f.target.isAttached = () => false;
    if (action === 'debug') { globalThis.__kitTest.debug = false; context.after(() => { globalThis.__kitTest.debug = true; }); }
    if (action === 'epoch') controller.epoch = 'changed';
    if (action === 'identity') controller.session.negotiated.identity.buildId = 'unverified:changed';
    if (action === 'window') controller.uiWindow = 'changed';
    assert.equal(controller.uiHighlightStatus().pendingCleanup, 0); assert.equal(f.held(), '');
    assert.equal(controller.confirmUiHighlight(review.planHash), false);
    assert.equal(controller.executeUiHighlight(review.planHash), false);
  });
}
test('UI highlight cleanup failure survives stop and blocks pairing, registration and fresh capture', async (context) => {
  const f = await connectHighlight(context), controller = f.controller;
  assert.equal(typeof controller.reviewUiHighlight, 'function');
  const review = controller.reviewUiHighlight(); controller.confirmUiHighlight(review.planHash);
  controller.executeUiHighlight(review.planHash); f.failClear(true);
  controller.cancelUiHighlight(); assert.equal(controller.uiHighlightStatus().pendingCleanup, 1);
  assert.equal(await controller.captureUi(), false);
  await controller.stop(); assert.equal(controller.state.phase, 'cleanup-failed');
  const count = f.calls.length; controller.uiHighlightStatus(); await controller.stop();
  assert.equal(f.calls.length, count);
  assert.throws(() => controller.review(f.text));
  assert.throws(() => controller.registerUi(f.uiContext, 'bridge_capture_root', 'page-main', false, f.host));
  f.failClear(false); assert.equal(controller.retryUiHighlightCleanup(), true);
  assert.equal(controller.uiHighlightStatus().pendingCleanup, 0); assert.equal(f.held(), '');
  assert.equal(controller.state.phase, 'stopped');
});
test('UI highlight fresh subtree capture first clears the owned outline', async (context) => {
  const f = await connectHighlight(context), controller = f.controller;
  assert.equal(typeof controller.reviewUiHighlight, 'function');
  const review = controller.reviewUiHighlight(); controller.confirmUiHighlight(review.planHash);
  controller.executeUiHighlight(review.planHash);
  assert.equal(await controller.captureUi(), true); assert.equal(f.held(), '');
  assert.equal(controller.uiHighlightStatus().pendingCleanup, 0);
});
test('UI highlight timer observes source loss without a page status query and cannot revive its grant', async (context) => {
  const f = await connectHighlight(context), controller = f.controller;
  const review = controller.reviewUiHighlight(); controller.confirmUiHighlight(review.planHash);
  controller.executeUiHighlight(review.planHash);
  f.target.isAttached = () => false; context.mock.timers.tick(1000); await settle();
  assert.equal(f.held(), '', 'Timer must revoke on source loss without a status query');
  f.target.isAttached = () => true;
  assert.equal(controller.confirmUiHighlight(review.planHash), false);
  assert.equal(controller.executeUiHighlight(review.planHash), false);
});
test('UI highlight reentrant host cancellation clears effects made after cancellation returns', (context) => {
  const f = highlightFixture(context), review = f.owner.review();
  f.host.apply = (id) => { f.owner.cancel(); f.calls.push(['late-state', id]); return true; };
  f.owner.confirm(review.planHash);
  assert.equal(f.owner.apply(review.planHash), false);
  assert.equal(f.owner.status().pendingCleanup, 0);
  assert.deepEqual(f.calls, [['late-state', review.commandId], ['clear', review.commandId]]);
});
test('UI highlight tombstone collision never replaces an earlier consumed command', (context) => {
  const f = highlightFixture(context);
  const repeated = new NodePort(); repeated.random = () => new Uint8Array(16).fill(7);
  const owner = new UiHighlightSession(repeated, f.currentSource, f.host);
  context.after(() => owner.dispose());
  const review = owner.review(); owner.confirm(review.planHash); owner.apply(review.planHash); owner.cancel();
  assert.throws(() => owner.review());
  assert.equal(owner.apply(review.planHash), false); assert.equal(owner.status().pendingCleanup, 0);
});
test('UI highlight page accepts only its command and keeps review confirm execute separate', async (context) => {
  const f = await connectHighlight(context); pageProducer = f.controller;
  globalThis.NavPathStack = class {};
  context.after(() => { pageProducer = undefined; delete globalThis.NavPathStack; });
  const page = new ProducerPage();
  assert.equal(typeof page.applyUiHighlight, 'function');
  assert.equal(page.applyUiHighlight('owned-command'), true);
  assert.equal(page.applyUiHighlight('other-command'), false);
  assert.equal(page.clearUiHighlight('other-command'), false);
  assert.equal(page.highlightCommand, 'owned-command');
  assert.equal(page.clearUiHighlight('owned-command'), true);
  assert.equal(page.highlightCommand, '');
  page.reviewUiHighlight(); const hash = f.controller.state.uiHighlightPlanHash;
  assert.match(hash, /^[a-f0-9]{64}$/); page.executeUiHighlight(); assert.equal(f.calls.length, 0);
  page.confirmUiHighlight(); page.executeUiHighlight(); assert.equal(f.calls.length, 1);
  page.cancelUiHighlight(); assert.equal(f.held(), '');
});
for (const change of ['root-hidden', 'target-hidden', 'disposed', 'detached', 'zero-size', 'nonfinite', 'cycle', 'depth']) {
  test(`UI highlight source refuses ${change} before effects`, () => {
    assert.equal(typeof readUiHighlightSource, 'function', 'Actual ArkTS highlight platform source must exist');
    const root = uiNode(1, 'Column'), target = uiNode(2, 'Column');
    target.getParent = () => root;
    if (change === 'root-hidden') root.isVisible = () => false;
    if (change === 'target-hidden') target.isVisible = () => false;
    if (change === 'disposed') target.isDisposed = () => true;
    if (change === 'detached') target.isAttached = () => false;
    if (change === 'zero-size') target.getMeasuredSize = () => ({ width: 0, height: 40 });
    if (change === 'nonfinite') target.getPositionToWindow = () => ({ x: Infinity, y: 0 });
    if (change === 'cycle') target.getParent = () => target;
    if (change === 'depth') {
      let parent = root;
      for (let index = 0; index < 32; index++) { const node = uiNode(index + 3, 'Column'), prior = parent;
        node.getParent = () => prior; parent = node; }
      target.getParent = () => parent;
    }
    const context = { getFrameNodeById: (id) => id === 'bridge_capture_root' ? root : target, px2vp: (value) => value };
    assert.throws(() => readUiHighlightSource(context, new NodePort()));
  });
}
test('screenshot requires application review and never enters event frames or ZIP export', async (context) => {
  const fixture = await connectSnapshot(context);
  const { controller, source, socket } = fixture;
  assert.equal(await controller.confirmScreenshot(), false);
  assert.equal(source.calls.snapshot, 0);
  controller.reviewScreenshot();
  assert.equal(controller.state.screenshotPhase, 'review');
  assert.equal(await controller.confirmScreenshot(), true);
  assert.equal(controller.state.screenshotData, 'data:image/png;base64,' + source.bytes.toString('base64'));
  assert.equal(source.calls.pixelRelease, 1); assert.equal(source.calls.packerRelease, 1);
  assert.equal(socket.sent.length, 2, 'No snapshot payload or screenshot event is sent');
  context.mock.timers.tick(1000); await settle();
  fixture.accepted.channel.open(socket.sent.at(-1));
  controller.reviewExport();
  const destination = path.join(temporary, 'snapshot-excluded.zip');
  globalThis.__kitTest.save = async () => [destination];
  await controller.confirmExport({});
  const content = await readFile(destination), result = verifyProblemPackage(content);
  assert.equal(result.kit.attachmentPolicy, 'none');
  assert.equal(result.manifest.files.some((file) => /\.(png|jpe?g)$/.test(file.path)), false);
  assert.equal(content.includes(source.bytes), false);
});
test('screenshot host denial and missing Image SysCap never begin native collection', async (context) => {
  const fixture = await connectSnapshot(context, undefined, false);
  assert.throws(() => fixture.controller.reviewScreenshot(), /SCREENSHOT_UNAVAILABLE/);
  assert.equal(fixture.source.calls.snapshot, 0);
});
test('screenshot missing packer capability denies review without claiming capture', async (context) => {
  const fixture = await connectSnapshot(context);
  const original = globalThis.canIUse;
  globalThis.canIUse = (name) => !name.includes('ImagePacker');
  try {
    assert.throws(() => fixture.controller.reviewScreenshot(), /SCREENSHOT_UNAVAILABLE/);
    assert.equal(fixture.source.calls.snapshot, 0);
  } finally { globalThis.canIUse = original; }
});
test('screenshot cancel erases the preview and does not invoke native snapshot', async (context) => {
  const { controller, source } = await connectSnapshot(context);
  controller.reviewScreenshot(); controller.cancelScreenshot();
  assert.equal(await controller.confirmScreenshot(), false);
  assert.equal(controller.state.screenshotData, '');
  assert.equal(source.calls.snapshot, 0);
});
test('screenshot pending owner survives revoke and blocks review until native settlement', async (context) => {
  const fixture = await connectSnapshot(context);
  let complete;
  fixture.uiContext.getComponentSnapshot = () => ({ getWithUniqueId: () => new Promise((resolve) => { complete = resolve; }) });
  fixture.controller.reviewScreenshot();
  const operation = fixture.controller.confirmScreenshot(); await settle();
  await fixture.controller.stop('APP_BACKGROUND');
  assert.equal(fixture.controller.state.screenshotData, '');
  assert.throws(() => fixture.controller.review(fixture.text), /SCREENSHOT_CAPTURE_BUSY/);
  complete(fixture.source.pixel);
  assert.equal(await operation, false);
  assert.equal(fixture.source.calls.pack, 0);
  assert.equal(fixture.source.calls.pixelRelease, 1);
  fixture.controller.review(fixture.text);
  assert.equal(fixture.controller.state.phase, 'review');
});
test('screenshot deadline is checked after native await even before timeout callbacks run', async (context) => {
  const fixture = await connectSnapshot(context);
  let complete;
  fixture.uiContext.getComponentSnapshot = () => ({ getWithUniqueId: () => new Promise((resolve) => { complete = resolve; }) });
  fixture.controller.reviewScreenshot();
  const operation = fixture.controller.confirmScreenshot(); await settle();
  const original = Date.now;
  try {
    Date.now = () => fixture.accepted.reply.expiresAt;
    complete(fixture.source.pixel);
    assert.equal(await operation, false);
    assert.equal(fixture.controller.state.screenshotData, '');
    assert.equal(fixture.source.calls.pack, 0);
  } finally { Date.now = original; }
});
test('screenshot three-second timeout retains owner and rejects late pixels', async (context) => {
  const fixture = await connectSnapshot(context);
  let complete;
  fixture.uiContext.getComponentSnapshot = () => ({ getWithUniqueId: () => new Promise((resolve) => { complete = resolve; }) });
  fixture.controller.reviewScreenshot();
  const operation = fixture.controller.confirmScreenshot(); await settle();
  context.mock.timers.tick(3000); await settle();
  assert.equal(await operation, false);
  assert.equal(fixture.controller.state.screenshotData, '');
  assert.throws(() => fixture.controller.reviewScreenshot(), /SCREENSHOT_CAPTURE_BUSY/);
  complete(fixture.source.pixel); await settle();
  assert.equal(fixture.source.calls.pixelRelease, 1);
  assert.equal(fixture.source.calls.pack, 0);
});
for (const [name, change] of [
  ['foreign subtree', ({ target }) => { target.getParent = () => null; }],
  ['disposed target', ({ target }) => { target.isDisposed = () => true; }],
  ['hidden target', ({ target }) => { target.isVisible = () => false; }],
]) {
  test(`screenshot rejects ${name} before native capture`, async (context) => {
    const fixture = await connectSnapshot(context); change(fixture);
    fixture.controller.reviewScreenshot();
    assert.equal(await fixture.controller.confirmScreenshot(), false);
    assert.equal(fixture.source.calls.snapshot, 0);
  });
}
test('screenshot native size limit releases pixels before any encoding', async (context) => {
  const source = snapshotPort(); source.pixel.getPixelBytesNumber = () => 1048577;
  const { controller } = await connectSnapshot(context, source);
  controller.reviewScreenshot();
  assert.equal(await controller.confirmScreenshot(), false);
  assert.equal(source.calls.pack, 0); assert.equal(source.calls.pixelRelease, 1);
  assert.equal(controller.state.screenshotData, '');
});
test('screenshot failed release retains exact resource until explicit revoke retries cleanup', async (context) => {
  const source = snapshotPort();
  source.pixel.release = async () => { source.calls.pixelRelease++; throw Error('release failure'); };
  const { controller, text } = await connectSnapshot(context, source);
  controller.reviewScreenshot();
  assert.equal(await controller.confirmScreenshot(), false);
  assert.equal(controller.state.screenshotData, '');
  assert.equal(controller.state.screenshotPhase, 'cleanup-failed');
  await controller.stop();
  assert.equal(controller.state.phase, 'cleanup-failed');
  assert.throws(() => controller.review(text), /SCREENSHOT_CAPTURE_BUSY/);
  source.pixel.release = async () => { source.calls.pixelRelease++; };
  await controller.stop();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(source.calls.packerRelease, 1);
  controller.review(text);
});
test('screenshot scale bounds the preflight target before native allocation', async (context) => {
  const fixture = await connectSnapshot(context);
  fixture.target.getMeasuredSize = () => ({ width: 2048, height: 1024 });
  fixture.uiContext.getComponentSnapshot = () => ({ getWithUniqueId: async (_id, options) => {
    assert.equal(options.scale, 0.25); return fixture.source.pixel;
  } });
  fixture.controller.reviewScreenshot();
  assert.equal(await fixture.controller.confirmScreenshot(), true);
});
test('screenshot preview expires after thirty seconds without persistence', async (context) => {
  const fixture = await connectSnapshot(context);
  fixture.controller.reviewScreenshot();
  assert.equal(await fixture.controller.confirmScreenshot(), true);
  assert(fixture.controller.screenshotPreview().startsWith('data:image/png;base64,'));
  context.mock.timers.tick(30000); await settle();
  assert.equal(fixture.controller.screenshotPreview(), '');
  assert.equal(fixture.controller.state.screenshotData, '');
});
test('screenshot timeout settlement resumes the shared automatic sample owner', async (context) => {
  const fixture = await connectSnapshot(context);
  let complete;
  fixture.uiContext.getComponentSnapshot = () => ({ getWithUniqueId: () => new Promise((resolve) => { complete = resolve; }) });
  fixture.controller.reviewScreenshot();
  const operation = fixture.controller.confirmScreenshot(); await settle();
  context.mock.timers.tick(3000); await settle();
  assert.equal(await operation, false);
  context.mock.timers.tick(1000); await settle();
  complete(fixture.source.pixel); await settle();
  context.mock.timers.tick(1000); await settle();
  const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(event.channel, 'hidebug'); assert.equal(event.sequence, 1);
});
test('screenshot expired review is denied synchronously before any native API call', async (context) => {
  const fixture = await connectSnapshot(context);
  fixture.controller.reviewScreenshot();
  const original = Date.now;
  try {
    Date.now = () => now + 30000;
    assert.equal(await fixture.controller.confirmScreenshot(), false);
    assert.equal(fixture.source.calls.snapshot, 0);
  } finally { Date.now = original; }
});
test('screenshot late cleanup failure after revoke is visible and blocks new pairing', async (context) => {
  const fixture = await connectSnapshot(context);
  let complete;
  fixture.source.pixel.release = async () => { throw Error('late native release failed'); };
  fixture.uiContext.getComponentSnapshot = () => ({ getWithUniqueId: () => new Promise((resolve) => { complete = resolve; }) });
  fixture.controller.reviewScreenshot();
  const operation = fixture.controller.confirmScreenshot(); await settle();
  await fixture.controller.stop();
  complete(fixture.source.pixel);
  assert.equal(await operation, false);
  assert.equal(fixture.controller.state.phase, 'cleanup-failed');
  assert.equal(fixture.controller.state.screenshotPhase, 'cleanup-failed');
  fixture.source.pixel.release = async () => {};
  await fixture.controller.stop();
  assert.equal(fixture.controller.state.phase, 'stopped');
});
for (const name of ['encoding error', 'oversized result', 'invalid PNG', 'late source change', 'release-time revocation']) {
  test(`screenshot ${name} cannot restore preview and releases owned resources`, async (context) => {
    const fixture = await connectSnapshot(context);
    if (name === 'encoding error') { fixture.source.packer.packToData = async () => { throw Error('pack failed'); }; }
    if (name === 'oversized result') { fixture.source.packer.packToData = async () => new ArrayBuffer(262145); }
    if (name === 'invalid PNG') { fixture.source.packer.packToData = async () => new ArrayBuffer(32); }
    if (name === 'late source change') {
      fixture.source.packer.release = async () => {
        fixture.source.calls.packerRelease++; fixture.target.getUniqueId = () => 7;
      };
    }
    if (name === 'release-time revocation') {
      fixture.source.packer.release = async () => { fixture.source.calls.packerRelease++; fixture.controller.cancelScreenshot(); };
    }
    fixture.controller.reviewScreenshot();
    assert.equal(await fixture.controller.confirmScreenshot(), false);
    assert.equal(fixture.controller.state.screenshotData, '');
    assert.equal(fixture.source.calls.pixelRelease, 1);
    assert.equal(fixture.source.calls.packerRelease, 1);
  });
}

function nativeRequest(responseCode = 204) {
  let calls = 0;
  const response = { responseCode };
  for (const key of ['result', 'header', 'cookies', 'performanceTiming']) {
    Object.defineProperty(response, key, { get: () => { throw Error('private response must not be read'); } });
  }
  const request = { request: async (url, options) => {
    calls++; assert.equal(url, 'https://example.invalid/private?secret=excluded');
    assert.equal(options.header.Authorization, 'test-only-excluded');
    return response;
  }, destroy: () => { throw Error('host owns the native request'); } };
  return { request, response, calls: () => calls };
}
async function connectNetwork(context, request) {
  return connectUi(context, undefined, ({ controller }) => controller.registerNetwork(request));
}

const controlledWebUrl = 'http://127.0.0.1:12345/kit-readonly.html';
function nativeConsoleMessage(level = 2) {
  return { getMessageLevel: () => level, getSource: () => 3,
    getSourceId: () => controlledWebUrl, getLineNumber: () => 1,
    getMessage: () => { throw Error('console text must not be read'); } };
}
function nativeWeb() {
  let calls = 0;
  let read = async () => JSON.stringify({
    url: controlledWebUrl, title: 'private-title-excluded',
    children_nodes: [{ tag: 'main', text: 'private-text-excluded',
      attributes: { id: 'private-id-excluded' }, children_nodes: [
        { tag: 'input', text: 'private-input-excluded', attributes: { value: 'private-value-excluded' } },
      ] }],
  });
  const controller = {
    getUrl: () => controlledWebUrl,
    executeAIPageCommand: async (command) => {
      calls++; assert.deepEqual(JSON.parse(command), { method: 'getFullDom', params: { wants: [] } });
      return read();
    },
    runJavaScript: () => { throw Error('arbitrary script is forbidden'); },
  };
  return { controller, calls: () => calls, read: (value) => { read = value; } };
}
async function connectWeb(context, source = nativeWeb()) {
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(source.controller, 'web-main', controlledWebUrl);
    controller.webPageBegin(controlledWebUrl);
    controller.webPageEnd(controlledWebUrl);
  });
  return { ...fixture, source };
}
function dfxGroup(name = 'APP_CRASH', eventType = 1) {
  const info = { domain: 'OS', name, eventType };
  Object.defineProperty(info, 'params', { get: () => { throw Error('private DFX params must never be queried'); } });
  return { name, appEventInfos: [info] };
}
function watcherPort() {
  let watcher;
  let added = 0, removed = 0;
  globalThis.__kitTest.addWatcher = (value) => { added++; watcher = value; return {}; };
  globalThis.__kitTest.removeWatcher = (value) => { assert.equal(value, watcher); removed++; };
  return { watcher: () => watcher, added: () => added, removed: () => removed,
    emit: (groups, domain = 'OS') => watcher.onReceive(domain, groups) };
}
function acknowledge(fixture, sequence) {
  fixture.socket.message(fixture.accepted.channel.seal({ ...fixture.accepted.negotiated.identity,
    protocolVersion: '1.1', sessionEpoch: fixture.epoch, type: 'ack', ackThrough: sequence }));
}
test('DFX watcher starts once only after explicit action, uses native filters and never captures at registration', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort();
  assert.equal(fixture.controller.state.dfxAvailable, true);
  assert.equal(port.added(), 0);
  assert.equal(fixture.controller.dfxFile(), undefined);
  assert.equal(fixture.controller.startDfx(), true);
  assert.equal(fixture.controller.startDfx(), false);
  assert.equal(port.added(), 1);
  const watcher = port.watcher();
  assert.match(watcher.name, /^[A-Za-z][A-Za-z0-9_]{0,30}[A-Za-z0-9]$/);
  assert.deepEqual(watcher.appEventFilters, [{ domain: 'OS', names: ['APP_CRASH', 'APP_FREEZE'] }]);
  assert.equal(watcher.onTrigger, undefined);
  assert.equal(fixture.socket.sent.length, 2);
  port.emit([dfxGroup()]);
  assert.equal(fixture.socket.sent.length, 2, 'callback must not send or remove');
  assert.equal(port.removed(), 0);
  context.mock.timers.tick(1000); await settle();
  const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  EventEnvelopeSchema.parse(event);
  assert.equal(event.channel, 'hiappevent');
  assert.deepEqual(event.payload, { eventName: 'APP_CRASH', summary: 'observed-callback;fault-time-unverified;[MEMORY_ONLY]' });
  const file = fixture.controller.dfxFile();
  assert.equal(file.path, 'dfx-events.jsonl'); assert.equal(file.records.length, 1);
  file.records[0].payload.eventName = 'tampered';
  assert.equal(fixture.controller.dfxFile().records[0].payload.eventName, 'APP_CRASH');
  context.mock.timers.tick(5000); await settle();
  assert.equal(fixture.socket.sent.length, 3, 'DFX uses the same one outstanding ACK');
  await fixture.controller.stop('APP_BACKGROUND');
  assert.equal(port.removed(), 1); assert.equal(fixture.controller.dfxFile(), undefined);
  port.emit([dfxGroup()]); assert.equal(fixture.socket.sent.length, 3);
});
test('DFX capability denial and missing negotiation perform no platform registration', async (context) => {
  const fixture = await connectUi(context, undefined, () => {
    globalThis.canIUse = (name) => name !== 'SystemCapability.HiviewDFX.HiAppEvent';
  });
  context.after(() => { globalThis.canIUse = () => true; });
  const port = watcherPort();
  assert.equal(fixture.controller.state.dfxAvailable, false);
  globalThis.canIUse = () => true;
  assert.equal(fixture.controller.startDfx(), false);
  assert.equal(port.added(), 0);
});
for (const failure of ['null', 'undefined', 'throw']) {
  test(`DFX ${failure} registration discards synchronous callbacks and releases its exact owner`, async (context) => {
    const fixture = await connectUi(context);
    let owner, removed = 0;
    globalThis.__kitTest.addWatcher = (watcher) => {
      owner = watcher; watcher.onReceive('OS', [dfxGroup()]);
      if (failure === 'throw') { throw Error('private platform error'); }
      return failure === 'null' ? null : undefined;
    };
    globalThis.__kitTest.removeWatcher = (watcher) => { assert.equal(watcher, owner); removed++; };
    assert.equal(fixture.controller.startDfx(), false);
    assert.equal(removed, 1);
    assert.equal(fixture.controller.state.dfxPhase, 'failed');
    assert.equal(fixture.controller.dfxFile(), undefined);
    owner.onReceive('OS', [dfxGroup()]);
    context.mock.timers.tick(1000); await settle();
    assert.equal(fixture.accepted.channel.open(fixture.socket.sent.at(-1)).channel, 'hidebug');
  });
}
test('DFX removal failure invalidates capture, retains ownership and blocks pairing until explicit retry', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort();
  assert.equal(fixture.controller.startDfx(), true);
  globalThis.__kitTest.removeWatcher = () => { throw Error('private remove failure'); };
  await fixture.controller.stop();
  assert.equal(fixture.controller.state.phase, 'cleanup-failed');
  assert.equal(fixture.controller.state.reason, 'DFX_CLOSE_FAILED');
  assert.throws(() => fixture.controller.review(fixture.text), /DFX_CAPTURE_BUSY/);
  port.emit([dfxGroup()]);
  assert.equal(fixture.controller.dfxFile(), undefined);
  globalThis.__kitTest.removeWatcher = (watcher) => assert.equal(watcher, port.watcher());
  await fixture.controller.stop();
  assert.equal(fixture.controller.state.phase, 'stopped');
});
test('DFX synchronous successful registration callback cannot become evidence before owner acquisition', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort();
  const add = globalThis.__kitTest.addWatcher;
  globalThis.__kitTest.addWatcher = (watcher) => { watcher.onReceive('OS', [dfxGroup()]); return add(watcher); };
  assert.equal(fixture.controller.startDfx(), true);
  context.mock.timers.tick(1000); await settle();
  assert.equal(fixture.accepted.channel.open(fixture.socket.sent.at(-1)).channel, 'hidebug');
  assert.equal(fixture.controller.dfxFile(), undefined);
  assert.equal(port.removed(), 0);
});
test('DFX projects only allowed native names and types with bounded input and a 32-record queue', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort();
  fixture.controller.startDfx();
  port.emit([dfxGroup('UNKNOWN')]); port.emit([dfxGroup('APP_CRASH', 3)]);
  port.emit([dfxGroup()], 'CUSTOM');
  const group = dfxGroup();
  group.appEventInfos = Array.from({ length: 65 }, () => dfxGroup().appEventInfos[0]);
  port.emit([group]);
  port.emit(Array.from({ length: 10 }, () => dfxGroup('APP_FREEZE')));
  context.mock.timers.tick(1000); await settle();
  assert.equal(fixture.controller.dfxFile().dropped, 46);
  assert.equal(fixture.controller.dfxFile().records[0].payload.eventName, 'APP_CRASH');
});
test('DFX files and callbacks expire synchronously even before the deadline timer runs', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort();
  fixture.controller.startDfx(); port.emit([dfxGroup()]);
  context.mock.timers.tick(1000); await settle();
  assert(fixture.controller.dfxFile());
  const sent = fixture.socket.sent.length;
  context.mock.timers.setTime(now + 600001);
  port.emit([dfxGroup()]);
  assert.equal(fixture.controller.dfxFile(), undefined);
  assert.equal(fixture.controller.startDfx(), false);
  assert.equal(fixture.socket.sent.length, sent);
});
test('DFX, registered HTTP, Web and PSS rotate without starvation at one combined automatic Hz', async (context) => {
  const source = nativeWeb(), request = nativeRequest();
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerNetwork(request.request);
    controller.registerWeb(source.controller, 'web-main', controlledWebUrl);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  const port = watcherPort(); fixture.controller.startDfx();
  const channels = [];
  for (let index = 1; index <= 8; index++) {
    await fixture.controller.requestNetwork('https://example.invalid/private?secret=excluded', { header: { Authorization: 'test-only-excluded' } });
    fixture.controller.observeWebConsole(nativeConsoleMessage());
    port.emit([dfxGroup()]);
    context.mock.timers.tick(999); await settle();
    assert.equal(fixture.socket.sent.length, index + 1);
    context.mock.timers.tick(1); await settle();
    const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
    channels.push(event.channel); assert.equal(event.sequence, index);
    acknowledge(fixture, index); await settle();
  }
  assert.deepEqual(channels, ['arkweb.console', 'hidebug', 'app.network', 'hidebug', 'hiappevent', 'hidebug', 'arkweb.console', 'hidebug']);
});
test('CPU native conversion preserves percentages and rejects invalid native readings', () => {
  for (const [usage, expected] of [[0, 0], [0.5, 50], [1, 100]]) {
    globalThis.__kitTest.nativeCpu = () => usage;
    assert.equal(readCpuPercent(), expected);
  }
  for (const usage of [-1, NaN, Infinity, '0.5']) {
    globalThis.__kitTest.nativeCpu = () => usage;
    assert.throws(() => readCpuPercent(), /CPU_SAMPLE_INVALID/);
  }
});

function storageWriteFixture(context, original = 'ORIGINAL_TEST_ONLY', value = 'REPLACEMENT_TEST_ONLY') {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  assert.equal(typeof StorageWriteSession, 'function', 'Actual ArkTS StorageWriteSession must exist');
  let binding = 'test-identity:epoch:source:revision';
  let pending = false;
  const calls = [], values = new Map(original === null ? [] : [['ohmate-test-local', original]]);
  const mutation = (code) => {
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, text) => values.set(key, text),
      removeItem: (key) => values.delete(key),
    };
    return Function('location', 'window', 'Date', 'return ' + code)(
      { href: controlledWebUrl }, { localStorage: storage, sessionStorage: storage }, Date);
  };
  let run = async (code, active, dispatched) => {
    assert.equal(active(), true); dispatched(); return mutation(code);
  };
  const executor = { busy: () => pending, execute: async (code, active, dispatched) => {
    calls.push(code); pending = true;
    try { return await run(code, active, dispatched); } finally { pending = false; }
  } };
  const owner = new StorageWriteSession(new NodePort(), () => binding, () => pending);
  const input = () => ({ url: controlledWebUrl, area: 'local', key: 'ohmate-test-local', original, value,
    binding, captureId: 1, captureDeadline: now + 30000, deadline: now + 600000, ttlMs: 15000 });
  const review = () => owner.review(input());
  context.after(() => owner.dispose());
  return { owner, executor, input, review, calls, values, mutation, binding: (text) => { binding = text; },
    run: (fn) => { run = fn; } };
}
test('Storage R3 binds one reviewed command and never exposes original or replacement values', async (context) => {
  const f = storageWriteFixture(context), review = f.review();
  assert.equal(review.scope, 'arkweb.storage.write'); assert.equal(review.risk, 'R3');
  assert.match(review.commandId, /^[a-f0-9-]{36}$/);
  assert.equal(review.expiresAt, now + 15000);
  assert.equal(JSON.stringify(review).includes('ORIGINAL_TEST_ONLY'), false);
  assert.equal(JSON.stringify(review).includes('REPLACEMENT_TEST_ONLY'), false);
  assert.equal(await f.owner.apply(review.planHash, f.executor), false);
  assert.equal(f.owner.confirm('0'.repeat(64)), false);
  assert.equal(f.owner.confirm(review.planHash), true);
  assert.equal(await f.owner.apply(review.planHash, f.executor), true);
  assert.equal(f.values.get('ohmate-test-local'), 'REPLACEMENT_TEST_ONLY');
  assert.equal(f.owner.status().revocation, 'active');
  assert.equal(f.owner.confirm(review.planHash), false);
  assert.equal(await f.owner.apply(review.planHash, f.executor), false);
  assert.equal(f.calls.length, 1);
  await f.owner.cancel(f.executor);
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY');
  assert.equal(f.owner.status().revocation, 'revoked');
  assert.equal(JSON.stringify(f.owner.status()).includes('ORIGINAL_TEST_ONLY'), false);
});
for (const [original, value] of [[null, ''], ['', null], ['existing', ''], ['existing', null]]) {
  test('Storage R3 restores absent and empty values distinctly ' + JSON.stringify([original, value]), async (context) => {
    const f = storageWriteFixture(context, original, value), review = f.review();
    f.owner.confirm(review.planHash);
    assert.equal(await f.owner.apply(review.planHash, f.executor), true);
    assert.equal(f.values.has('ohmate-test-local'), value !== null);
    await f.owner.cancel(f.executor);
    assert.equal(f.values.has('ohmate-test-local'), original !== null);
    assert.equal(f.values.get('ohmate-test-local') ?? null, original);
  });
}
test('Storage R3 rechecks original before effects and does not overwrite a concurrent value', async (context) => {
  const f = storageWriteFixture(context), review = f.review();
  f.owner.confirm(review.planHash); f.values.set('ohmate-test-local', 'CONCURRENT_TEST_ONLY');
  assert.equal(await f.owner.apply(review.planHash, f.executor), false);
  assert.equal(f.values.get('ohmate-test-local'), 'CONCURRENT_TEST_ONLY');
  assert.equal(f.owner.status().revocation, 'not-needed');
});
test('Storage R3 restoration conflicts retain responsibility and retry only explicitly', async (context) => {
  const f = storageWriteFixture(context), review = f.review();
  f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash, f.executor), true);
  f.values.set('ohmate-test-local', 'CONCURRENT_TEST_ONLY');
  await f.owner.cancel(f.executor);
  assert.equal(f.owner.status().revocation, 'cleanup-failed');
  assert.equal(f.owner.status().pendingCleanup, 1);
  assert.equal(f.values.get('ohmate-test-local'), 'CONCURRENT_TEST_ONLY');
  await f.owner.cancel(f.executor);
  assert.equal(f.calls.length, 2, 'Repeated cancellation must not automatically retry failed restoration');
  f.values.set('ohmate-test-local', 'REPLACEMENT_TEST_ONLY');
  assert.equal(await f.owner.retryRestore(f.executor), true);
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY');
});
for (const field of ['binding', 'captureId', 'original', 'value', 'ttlMs', 'url']) {
  test('Storage R3 plan includes ' + field, (context) => {
    const f = storageWriteFixture(context), first = f.review(), input = f.input();
    if (field === 'binding') { input.binding += '-other'; f.binding(input.binding); }
    else if (field === 'captureId') input.captureId++;
    else if (field === 'ttlMs') input.ttlMs++;
    else if (field === 'url') input.url = input.url.replace('12345', '12346');
    else input[field] += '-other';
    const second = f.owner.review(input);
    assert.notEqual(first.planHash, second.planHash);
    assert.equal(f.owner.confirm(first.planHash), false);
  });
}
for (const change of ['source', 'expiry', 'rollback']) {
  test('Storage R3 revokes before effects on ' + change, async (context) => {
    const f = storageWriteFixture(context), review = f.review(); f.owner.confirm(review.planHash);
    if (change === 'source') f.binding('different-source');
    if (change === 'expiry') context.mock.timers.setTime(review.expiresAt);
    if (change === 'rollback') context.mock.timers.setTime(now - 1);
    assert.equal(await f.owner.apply(review.planHash, f.executor), false);
    assert.equal(f.calls.length, 0);
    context.mock.timers.setTime(now + 1);
    assert.equal(f.owner.confirm(review.planHash), false);
  });
}
test('Storage R3 registers restoration before dispatch and retains ownership after cancellation', async (context) => {
  const f = storageWriteFixture(context), review = f.review(); f.owner.confirm(review.planHash);
  let release;
  f.run((code, active, dispatched) => {
    dispatched(); assert.equal(f.owner.status().pendingCleanup, 1);
    return new Promise((resolve) => { release = () => resolve(f.mutation(code)); });
  });
  const applying = f.owner.apply(review.planHash, f.executor); await settle();
  const cancelling = f.owner.cancel(f.executor); await settle();
  assert.equal(await applying, false);
  assert.equal(f.owner.status().nativePending, true);
  assert.throws(() => f.review(), /STORAGE_WRITE_BUSY/);
  f.run(async (code, active, dispatched) => { assert.equal(active(), true); dispatched(); return f.mutation(code); });
  release(); await cancelling; await settle();
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY');
  assert.equal(f.owner.status().pendingCleanup, 0);
});
test('Storage R3 timeout retains native owner and restores late effects without a second execution', async (context) => {
  const f = storageWriteFixture(context), review = f.review(); f.owner.confirm(review.planHash);
  let release;
  f.run((code, active, dispatched) => { dispatched(); return new Promise((resolve) => { release = () => resolve(f.mutation(code)); }); });
  const applying = f.owner.apply(review.planHash, f.executor); await settle();
  context.mock.timers.tick(3000); await settle();
  assert.equal(await applying, false); assert.equal(f.owner.status().nativePending, true);
  assert.equal(f.owner.status().pendingCleanup, 1);
  f.run(async (code, active, dispatched) => { assert.equal(active(), true); dispatched(); return f.mutation(code); });
  release(); await settle();
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY');
  assert.equal(f.calls.length, 2);
  assert.equal(f.owner.confirm(review.planHash), false);
});
test('Storage R3 uncertain native failure retains responsibility until explicit verified restoration', async (context) => {
  const f = storageWriteFixture(context), review = f.review(); f.owner.confirm(review.planHash);
  f.run(async (code, active, dispatched) => { dispatched(); f.mutation(code); throw Error('PRIVATE_NATIVE_ERROR'); });
  assert.equal(await f.owner.apply(review.planHash, f.executor), false);
  assert.equal(f.owner.status().pendingCleanup, 1);
  assert.equal(f.calls.length, 1, 'An uncertain failure must not blindly overwrite a concurrent value');
  assert.equal(JSON.stringify(f.owner.status()).includes('PRIVATE_NATIVE_ERROR'), false);
  f.run(async (code, active, dispatched) => { dispatched(); return f.mutation(code); });
  assert.equal(await f.owner.retryRestore(f.executor), true);
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY');
});
test('Storage R3 raw expiry never extends for restoration and keeps unresolved responsibility', async (context) => {
  const f = storageWriteFixture(context), input = f.input(); input.ttlMs = 30000;
  const review = f.owner.review(input); f.owner.confirm(review.planHash);
  assert.equal(await f.owner.apply(review.planHash, f.executor), true);
  context.mock.timers.tick(30000); await settle();
  assert.equal(f.owner.status().pendingCleanup, 1);
  assert.equal(f.owner.status().reason, 'STORAGE_RECOVERY_EXPIRED');
  assert.equal(await f.owner.retryRestore(f.executor), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.owner.original, undefined, 'The private original reference must be cleared at its original deadline');
  assert.equal(f.owner.replacement, undefined);
});
for (const [name, change] of [
  ['unknown area', (input) => { input.area = 'cookie'; }],
  ['unlisted prefix', (input) => { input.key = 'business-token'; }],
  ['oversized value', (input) => { input.value = 'x'.repeat(1025); }],
  ['malformed UTF8', (input) => { input.value = '\ud800'; }],
  ['extra raw field', (input) => { input.extra = 'RAW_TEST_ONLY'; }],
  ['expired capture', (input) => { input.captureDeadline = now; }],
  ['extended capture', (input) => { input.captureDeadline = now + 30001; }],
  ['invalid TTL', (input) => { input.ttlMs = 600001; }],
  ['no effect', (input) => { input.value = input.original; }],
]) {
  test('Storage R3 rejects ' + name + ' without effects', (context) => {
    const f = storageWriteFixture(context), input = f.input(); change(input);
    assert.throws(() => f.owner.review(input));
    assert.equal(f.calls.length, 0);
  });
}
test('Storage R3 invalid reviews consume the bounded owner budget', (context) => {
  const f = storageWriteFixture(context);
  for (let i = 0; i < 256; i++) {
    const input = f.input(); input.key = 'not-allowed';
    assert.throws(() => f.owner.review(input), /STORAGE_WRITE_INVALID/);
  }
  assert.throws(() => f.review(), /STORAGE_WRITE_UNAVAILABLE/);
});
test('Storage R3 restoration expiry and confirmation do not reset the command deadline', async (context) => {
  const f = storageWriteFixture(context), review = f.review();
  f.owner.confirm(review.planHash); context.mock.timers.tick(14999);
  assert.equal(f.owner.confirm(review.planHash), false);
  assert.equal(await f.owner.apply(review.planHash, f.executor), true);
  context.mock.timers.tick(1); await settle();
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY');
  assert.equal(f.owner.status().pendingCleanup, 0);
});
for (const observation of ['status', 'retry']) {
  test('Storage R3 source drift permanently ends recovery after ' + observation, async (context) => {
    const f = storageWriteFixture(context), review = f.review();
    f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash, f.executor), true);
    f.binding('different-source');
    if (observation === 'status') f.owner.status();
    else assert.equal(await f.owner.retryRestore(f.executor), false);
    f.binding('test-identity:epoch:source:revision');
    assert.equal(await f.owner.retryRestore(f.executor), false);
    assert.equal(f.calls.length, 1, 'Returning to the prior binding must not revive recovery');
    assert.equal(f.values.get('ohmate-test-local'), 'REPLACEMENT_TEST_ONLY');
    assert.equal(f.owner.status().pendingCleanup, 1);
    assert.equal(f.owner.status().reason, 'STORAGE_RECOVERY_SOURCE_CHANGED');
    assert.equal(f.owner.original, undefined);
  });
}
test('Storage R3 a late restoration cannot certify a timed-out recovery', async (context) => {
  const f = storageWriteFixture(context), review = f.review();
  f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash, f.executor), true);
  let release;
  f.run((code, active, dispatched) => {
    assert.equal(active(), true); dispatched();
    return new Promise((resolve) => { release = () => resolve(f.mutation(code)); });
  });
  const cancelling = f.owner.cancel(f.executor); await settle();
  context.mock.timers.tick(3000); await settle(); await cancelling;
  assert.equal(f.owner.status().nativePending, true);
  assert.equal(f.owner.status().reason, 'STORAGE_RESTORE_TIMEOUT');
  assert.equal(await f.owner.retryRestore(f.executor), false);
  release(); await settle();
  assert.equal(f.values.get('ohmate-test-local'), 'ORIGINAL_TEST_ONLY', 'The native effect can finish after timeout');
  assert.equal(f.owner.status().nativePending, false);
  assert.equal(f.owner.status().pendingCleanup, 1, 'Late physical effects do not certify recovery');
  assert.equal(f.owner.status().revocation, 'cleanup-failed');
  f.run(async (code, active, dispatched) => { assert.equal(active(), true); dispatched(); return f.mutation(code); });
  assert.equal(await f.owner.retryRestore(f.executor), true);
  assert.equal(f.calls.length, 3, 'Explicit retry verifies the original without reapplying');
});
for (const stage of ['apply', 'restore']) {
  test('Storage R3 clears pending native projection references at raw expiry during ' + stage, async (context) => {
    const f = storageWriteFixture(context), input = f.input(); input.ttlMs = 30000;
    const review = f.owner.review(input); f.owner.confirm(review.planHash);
    if (stage === 'restore') assert.equal(await f.owner.apply(review.planHash, f.executor), true);
    let release;
    f.run((code, active, dispatched) => {
      dispatched(); return new Promise((resolve) => { release = () => resolve('untrusted-late-result'); });
    });
    const pending = stage === 'apply' ? f.owner.apply(review.planHash, f.executor) : f.owner.cancel(f.executor);
    await settle();
    const projection = f.owner.nativeMutation;
    assert.ok(projection, 'The in-flight projection must have an owned, clearable reference');
    context.mock.timers.tick(30000); await settle(); await pending;
    assert.equal(f.owner.original, undefined); assert.equal(f.owner.replacement, undefined);
    assert.equal(projection.original, null); assert.equal(projection.expected, null); assert.equal(projection.replacement, null);
    assert.equal(f.owner.status().nativePending, true);
    release(); await settle();
    assert.equal(f.owner.status().pendingCleanup, 1);
    assert.equal(f.owner.status().revocation, 'cleanup-failed');
    assert.equal(f.owner.status().nativePending, false);
  });
}
for (const cause of ['source', 'expiry']) {
  test('Storage R3 restore timeout preserves permanent failure after ' + cause, async (context) => {
    const f = storageWriteFixture(context), review = f.review();
    f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash, f.executor), true);
    let release;
    f.run((code, active, dispatched) => {
      dispatched(); return new Promise((resolve) => { release = () => resolve('discarded-late-result'); });
    });
    const cancelling = f.owner.cancel(f.executor); await settle();
    if (cause === 'source') f.binding('different-source');
    else context.mock.timers.setTime(now + 30000);
    const reason = cause === 'source' ? 'STORAGE_RECOVERY_SOURCE_CHANGED' : 'STORAGE_RECOVERY_EXPIRED';
    assert.equal(f.owner.status().reason, reason);
    context.mock.timers.tick(3000); await settle(); await cancelling;
    assert.equal(f.owner.status().reason, reason);
    release(); await settle();
    assert.equal(f.owner.status().reason, reason); assert.equal(f.owner.status().pendingCleanup, 1);
  });
}
test('Storage R3 disposal clears raw references without losing unresolved responsibility', async (context) => {
  const f = storageWriteFixture(context), review = f.review();
  f.owner.confirm(review.planHash); assert.equal(await f.owner.apply(review.planHash, f.executor), true);
  f.owner.dispose();
  assert.equal(f.owner.status().pendingCleanup, 1);
  assert.equal(f.owner.status().revocation, 'cleanup-failed');
  assert.equal(f.owner.status().reason, 'STORAGE_RECOVERY_DISPOSED');
  assert.equal(f.owner.original, undefined); assert.equal(f.owner.replacement, undefined);
  assert.equal(await f.owner.retryRestore(f.executor), false); assert.equal(f.calls.length, 1);
});
test('Storage R3 app entry requires a current captured allowlist and independent confirmation', async (context) => {
  const f = await connectControlledStorage(context);
  assert.throws(() => f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY'));
  assert.equal(await f.controller.captureControlledStorage(), true);
  assert.throws(() => f.controller.reviewStorageWrite('local', 'ohmate-test-unlisted', 'NEW_TEST_ONLY'));
  const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
  assert.equal(await f.controller.executeStorageWrite(review.planHash), false);
  assert.equal(f.controller.confirmStorageWrite(review.planHash), true);
  const values = new Map([['ohmate-test-local', 'PRIVATE_TEST_VALUE']]);
  f.result(() => {
    const code = f.scripts.at(-1);
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key) };
    const text = Function('location', 'window', 'Date', 'return ' + code)(
      { href: controlledWebUrl }, { localStorage: storage, sessionStorage: storage }, Date);
    return Promise.resolve({ getType: () => 1, getString: () => text });
  });
  assert.equal(await f.controller.executeStorageWrite(review.planHash), true);
  assert.equal(values.get('ohmate-test-local'), 'NEW_TEST_ONLY');
  assert.equal(f.controller.webStorageSnapshot(), undefined);
  assert.equal(f.socket.sent.length, 2);
  assert.equal(f.controller.storageWriteStatus().pendingCleanup, 1);
  assert.equal(JSON.stringify(f.controller.state).includes('NEW_TEST_ONLY'), false);
  let domReads = 0;
  f.source.controller.executeAIPageCommand = async () => { domReads++; return 'DO_NOT_READ'; };
  assert.equal(await f.controller.captureWebDom(), false, 'Unresolved recovery prevents new Web capture');
  assert.equal(domReads, 0);
  await f.controller.cancelStorageWrite();
  assert.equal(values.get('ohmate-test-local'), 'PRIVATE_TEST_VALUE');
});
for (const reason of ['USER_REVOKED', 'APP_BACKGROUND', 'ABILITY_DESTROYED', 'WINDOW_DESTROYED',
  'CONNECTION_FAILED', 'ACK_TIMEOUT', 'SESSION_EXPIRED']) {
  test('Storage R3 app stop reports retained recovery after ' + reason, async (context) => {
    // Allow the shared fixtures below to initialize when this is the first selected test.
    await settle();
    const f = await connectControlledStorage(context);
    assert.equal(await f.controller.captureControlledStorage(), true);
    const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
    assert.equal(f.controller.confirmStorageWrite(review.planHash), true);
    const values = new Map([['ohmate-test-local', 'PRIVATE_TEST_VALUE']]);
    f.result(async () => {
      const storage = { getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
      const text = Function('location', 'window', 'Date', 'return ' + f.scripts.at(-1))(
        { href: controlledWebUrl }, { localStorage: storage, sessionStorage: storage }, Date);
      return { getType: () => 1, getString: () => text };
    });
    assert.equal(await f.controller.executeStorageWrite(review.planHash), true);
    assert.equal(values.get('ohmate-test-local'), 'NEW_TEST_ONLY');
    await f.controller.stop(reason);
    assert.equal(f.socket.closed, true);
    assert.equal(f.controller.state.phase, 'cleanup-failed');
    assert.equal(f.controller.state.reason, 'STORAGE_RESTORE_REQUIRED');
    const status = f.controller.storageWriteStatus();
    assert.equal(status.pendingCleanup, 1); assert.equal(status.nativePending, false);
    assert.equal(status.revocation, 'cleanup-failed');
    assert.equal(status.reason, 'STORAGE_RECOVERY_DISPOSED');
    assert.equal(f.controller.webStorageWrite.original, undefined);
    assert.equal(f.controller.webStorageWrite.replacement, undefined);
    assert.equal(f.controller.webStorageFile(), undefined);
    assert.equal(f.controller.webStorageSnapshot(), undefined);
    assert.equal(f.socket.sent.length, 2, 'No write or recovery frames are emitted');
    await f.controller.stop('APP_BACKGROUND'); await f.controller.stop();
    assert.equal(f.controller.state.phase, 'cleanup-failed');
    assert.equal(await f.controller.retryStorageRestore(), false);
    assert.equal(f.scripts.length, 2, 'Destroyed source cannot dispatch restoration');
    assert.equal(values.get('ohmate-test-local'), 'NEW_TEST_ONLY', 'Retained responsibility is not restored evidence');
    assert.throws(() => f.controller.review('{}'), /STORAGE_CLEANUP_REQUIRED/);
    assert.throws(() => f.controller.registerWeb(f.source.controller, 'web-main', controlledWebUrl),
      /STORAGE_CLEANUP_REQUIRED/);
  });
}
for (const confirmed of [false, true]) {
  test('Storage R3 app stop clears unused raw values before socket close ' + confirmed, async (context) => {
    await settle();
    const f = await connectControlledStorage(context);
    assert.equal(await f.controller.captureControlledStorage(), true);
    const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
    if (confirmed) assert.equal(f.controller.confirmStorageWrite(review.planHash), true);
    let finish;
    f.socket.close = () => new Promise((resolve) => { finish = resolve; });
    const closing = f.controller.stop('APP_BACKGROUND');
    assert.equal(f.controller.webStorageWrite.original, undefined);
    assert.equal(f.controller.webStorageWrite.replacement, undefined);
    assert.equal(f.controller.confirmStorageWrite(review.planHash), false);
    assert.equal(await f.controller.executeStorageWrite(review.planHash), false);
    await settle(); assert.equal(typeof finish, 'function');
    assert.equal(f.controller.stop('ABILITY_DESTROYED'), closing);
    finish(true); await closing;
    assert.equal(f.controller.state.phase, 'stopped');
    assert.equal(f.controller.storageWriteStatus().pendingCleanup, 0);
    assert.equal(f.scripts.length, 1, 'Unused consent has no effects to restore');
  });
}
test('Storage R3 app stop retains pending native ownership without projecting late results', async (context) => {
  await settle();
  const f = await connectControlledStorage(context);
  assert.equal(await f.controller.captureControlledStorage(), true);
  const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
  assert.equal(f.controller.confirmStorageWrite(review.planHash), true);
  let release, getters = 0;
  f.result(() => new Promise((resolve) => { release = () => resolve({
    getType: () => { getters++; return 1; }, getString: () => { getters++; return 'DO_NOT_PROJECT'; },
  }); }));
  const applying = f.controller.executeStorageWrite(review.planHash); await settle();
  const closing = f.controller.stop('WINDOW_DESTROYED');
  assert.equal(f.controller.webStorageWrite.original, undefined);
  assert.equal(f.controller.webStorageWrite.replacement, undefined);
  await closing;
  assert.equal(f.controller.state.phase, 'cleanup-failed');
  assert.equal(f.controller.state.reason, 'STORAGE_RESTORE_REQUIRED');
  assert.equal(f.controller.storageWriteStatus().nativePending, true);
  release(); assert.equal(await applying, false); await settle();
  assert.equal(getters, 0);
  assert.equal(f.controller.storageWriteStatus().nativePending, false);
  assert.equal(f.controller.storageWriteStatus().pendingCleanup, 1);
  assert.equal(f.controller.state.phase, 'cleanup-failed');
  assert.equal(f.scripts.length, 2);
});
test('Storage R3 app recovery responsibility does not mask a socket close failure', async (context) => {
  await settle();
  const f = await connectControlledStorage(context);
  assert.equal(await f.controller.captureControlledStorage(), true);
  const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
  f.controller.confirmStorageWrite(review.planHash);
  f.result(async () => ({ getType: () => 1, getString: () => JSON.stringify({
    url: controlledWebUrl, area: review.area, key: review.key, commandId: review.commandId,
    mode: 'apply', outcome: 'applied',
  }) }));
  assert.equal(await f.controller.executeStorageWrite(review.planHash), true);
  f.socket.close = async () => false;
  await f.controller.stop('APP_BACKGROUND');
  assert.equal(f.controller.state.reason, 'SOCKET_CLOSE_FAILED');
  assert.equal(f.controller.storageWriteStatus().pendingCleanup, 1);
  f.socket.close = async () => true;
  await f.controller.stop();
  assert.equal(f.controller.state.phase, 'cleanup-failed');
  assert.equal(f.controller.state.reason, 'STORAGE_RESTORE_REQUIRED');
  assert.equal(f.scripts.length, 2);
});
for (const action of ['permission', 'source', 'identity', 'epoch', 'navigation', 'cancel', 'expiry']) {
  test('Storage R3 app consent rejects drift ' + action, async (context) => {
    const f = await connectControlledStorage(context);
    assert.equal(await f.controller.captureControlledStorage(), true);
    const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
    assert.equal(f.controller.confirmStorageWrite(review.planHash), true);
    if (action === 'permission') f.enabled(false);
    if (action === 'source') f.source.controller.getUrl = () => 'https://foreign.test/';
    if (action === 'identity') f.controller.session.negotiated.identity.buildId += ':changed';
    if (action === 'epoch') f.controller.epoch += '-changed';
    if (action === 'navigation') { f.controller.webPageBegin(controlledWebUrl); f.controller.webPageEnd(controlledWebUrl); }
    if (action === 'cancel') f.controller.cancelWebStorage();
    if (action === 'expiry') context.mock.timers.setTime(review.expiresAt);
    assert.equal(await f.controller.executeStorageWrite(review.planHash), false);
    assert.equal(f.scripts.length, 1);
  });
}
for (const action of ['cancel', 'timeout', 'source', 'stop']) {
  test('Storage R3 app late native message has no getter access after ' + action, async (context) => {
    const f = await connectControlledStorage(context);
    assert.equal(await f.controller.captureControlledStorage(), true);
    const review = f.controller.reviewStorageWrite('local', 'ohmate-test-local', 'NEW_TEST_ONLY');
    assert.equal(f.controller.confirmStorageWrite(review.planHash), true);
    let release, getters = 0;
    f.result(() => new Promise((resolve) => { release = () => resolve({
      getType: () => { getters++; return 1; }, getString: () => { getters++; return 'DO_NOT_PROJECT'; },
    }); }));
    const applying = f.controller.executeStorageWrite(review.planHash); await settle();
    let cancelling;
    if (action === 'cancel') cancelling = f.controller.cancelStorageWrite();
    if (action === 'timeout') context.mock.timers.tick(3000);
    if (action === 'source') {
      f.enabled(false); f.controller.storageWriteStatus(); f.enabled(true);
    }
    if (action === 'stop') await f.controller.stop();
    await settle();
    assert.equal(f.controller.storageWriteStatus().pendingCleanup, 1);
    assert.equal(f.controller.storageWriteStatus().nativePending, true);
    assert.throws(() => f.controller.registerWeb(f.source.controller, 'web-main', controlledWebUrl), /WEB_CAPTURE_BUSY/);
    const restoration = { url: controlledWebUrl, area: review.area, key: review.key,
      commandId: review.commandId, mode: 'restore', outcome: 'conflict' };
    f.result(async () => ({ getType: () => 1, getString: () => JSON.stringify(restoration) }));
    release(); assert.equal(await applying, false); await cancelling; await settle();
    assert.equal(getters, 0, 'Invalid native results must be discarded before any getter');
    assert.equal(f.controller.storageWriteStatus().nativePending, false);
    assert.equal(f.controller.storageWriteStatus().pendingCleanup, 1);
    assert.equal(f.controller.storageWriteStatus().revocation, 'cleanup-failed');
    assert.equal(await f.controller.captureControlledStorage(), false);
    assert.equal(await f.controller.executeConsole('0'.repeat(64)), false);
    assert.throws(() => f.controller.review('{}'), /STORAGE_CLEANUP_REQUIRED/);
    if (action === 'source' || action === 'stop') {
      assert.equal(await f.controller.retryStorageRestore(), false);
      assert.equal(f.scripts.length, 2, 'No new recovery script may run after permanent drift');
    }
  });
}
for (const [area, operation, value] of [[0, 0, 'ohmate-local-test'], [1, 1, ''], [0, 2, null]]) {
  test('Storage R3 page requires review then confirmation then separate execution ' + [area, operation], async (context) => {
    const f = await connectControlledStorage(context);
    await f.controller.captureControlledStorage();
    pageProducer = f.controller;
    globalThis.NavPathStack = class {};
    const page = new ProducerPage();
    context.after(() => { delete globalThis.NavPathStack; pageProducer = undefined; });
    assert.equal(typeof page.selectStorageWrite, 'function');
    page.selectStorageWrite(area, operation);
    let submitted;
    const review = f.controller.reviewStorageWrite.bind(f.controller);
    f.controller.reviewStorageWrite = (...args) => { submitted = args; return review(...args); };
    page.reviewStorageWrite();
    assert.deepEqual(submitted.slice(0, 3), [area === 0 ? 'local' : 'session',
      area === 0 ? 'ohmate-test-local' : 'ohmate-test-session', value]);
    assert.equal(f.controller.state.storageWritePhase, 'review'); assert.equal(f.scripts.length, 1);
    assert.equal(await f.controller.executeStorageWrite(f.controller.state.storageWritePlanHash), false);
    page.confirmStorageWrite();
    assert.equal(f.controller.state.storageWritePhase, 'confirmed'); assert.equal(f.scripts.length, 1);
    page.selectStorageWrite(area === 0 ? 1 : 0, operation);
    assert.equal(f.controller.state.storageWritePhase, 'cancelled');
    assert.equal(await f.controller.executeStorageWrite(page.storageReview?.planHash ?? ''), false);
    assert.equal(f.scripts.length, 1);
  });
  test('Storage R3 page executes and restores only its separately confirmed plan ' + [area, operation], async (context) => {
    const f = await connectControlledStorage(context);
    await f.controller.captureControlledStorage();
    pageProducer = f.controller; globalThis.NavPathStack = class {};
    const page = new ProducerPage();
    context.after(() => { delete globalThis.NavPathStack; pageProducer = undefined; });
    page.selectStorageWrite(area, operation); page.reviewStorageWrite();
    await page.executeStorageWrite();
    assert.equal(f.scripts.length, 1); assert.equal(page.storageWriteFailed, true);
    page.confirmStorageWrite();
    const values = new Map([['ohmate-test-local', 'PRIVATE_TEST_VALUE'], ['ohmate-test-session', 'PRIVATE_TEST_VALUE']]);
    f.result(async () => {
      const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, text) => values.set(key, text),
        removeItem: (key) => values.delete(key) };
      const text = Function('location', 'window', 'Date', 'return ' + f.scripts.at(-1))(
        { href: controlledWebUrl }, { localStorage: storage, sessionStorage: storage }, Date);
      return { getType: () => 1, getString: () => text };
    });
    await page.executeStorageWrite();
    assert.equal(page.storageWriteFailed, false);
    const key = area === 0 ? 'ohmate-test-local' : 'ohmate-test-session';
    assert.equal(values.get(key) ?? null, value); assert.equal(f.controller.state.storageWriteCleanup, 1);
    await page.executeStorageWrite(); assert.equal(f.scripts.length, 2, 'The same plan cannot execute twice');
    await f.controller.cancelStorageWrite();
    assert.equal(values.get(key), 'PRIVATE_TEST_VALUE'); assert.equal(f.controller.state.storageWriteCleanup, 0);
    assert.equal(f.controller.state.storageWriteRevocation, 'revoked');
    assert.equal(JSON.stringify(page).includes('PRIVATE_TEST_VALUE'), false);
  });
}
test('CPU is explicit TaskPool work, shares the ACK and merges with PSS into one defensive memory file', async (context) => {
  const fixture = await connectUi(context);
  let reads = 0;
  globalThis.__kitTest.cpu = async () => { reads++; return 25; };
  context.mock.timers.tick(1000); await settle();
  assert.equal(reads, 0);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(await fixture.controller.captureCpu(), false);
  acknowledge(fixture, 1); await settle();
  assert.equal(await fixture.controller.captureCpu(), true);
  assert.equal(reads, 1);
  const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  EventEnvelopeSchema.parse(event);
  assert.deepEqual(event.payload, { metric: 'cpuPercent', value: 25 });
  const file = fixture.controller.memoryFile();
  assert.equal(file.path, 'memory-clues.jsonl'); assert.equal(file.records.length, 2);
  assert.deepEqual(file.records.map((record) => record.payload.metric), ['pssBytes', 'cpuPercent']);
  assert.equal(file.source.api, 'hidebug.getPss.getCpuUsage');
  file.records[1].payload.value = 99;
  assert.equal(fixture.controller.memoryFile().records[1].payload.value, 25);
});
test('CPU TaskPool owner survives revocation until native settlement and cannot restore late evidence', async (context) => {
  const fixture = await connectUi(context);
  let resolve;
  globalThis.__kitTest.cpu = () => new Promise((done) => { resolve = done; });
  const pending = fixture.controller.captureCpu();
  await settle();
  await fixture.controller.stop('APP_BACKGROUND');
  assert.throws(() => fixture.controller.review(fixture.text), /METRICS_CAPTURE_BUSY/);
  assert.equal(fixture.controller.memoryFile(), undefined);
  resolve(25);
  assert.equal(await pending, false);
  assert.equal(fixture.socket.sent.length, 2);
  assert.doesNotThrow(() => fixture.controller.review(fixture.text));
});
test('CPU failed or expired native completions produce no record and do not expose platform errors', async (context) => {
  const fixture = await connectUi(context);
  globalThis.__kitTest.cpu = async () => { throw Error('private diagnostic'); };
  assert.equal(await fixture.controller.captureCpu(), false);
  assert.equal(fixture.controller.state.cpuReason, 'CPU_CAPTURE_FAILED');
  assert.equal(fixture.controller.memoryFile(), undefined);
  let resolve;
  globalThis.__kitTest.cpu = () => new Promise((done) => { resolve = done; });
  const pending = fixture.controller.captureCpu(); await settle();
  context.mock.timers.setTime(now + 600001); resolve(25);
  assert.equal(await pending, false);
  assert.equal(fixture.controller.memoryFile(), undefined);
  assert.equal(fixture.socket.sent.length, 2);
});
test('DFX and CPU explicit export freezes their current files in unique public domain paths', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort();
  fixture.controller.startDfx(); port.emit([dfxGroup()]);
  context.mock.timers.tick(1000); await settle();
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
  context.mock.timers.tick(1000); await settle();
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 2); await settle();
  assert.equal(await fixture.controller.captureCpu(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  fixture.controller.reviewExport();
  assert.equal(fixture.controller.state.exportDfxSequence, 1);
  assert.equal(fixture.controller.state.exportCpuSequence, 3);
  const destination = path.join(temporary, 'dfx-cpu.zip');
  globalThis.__kitTest.save = async () => [destination];
  await fixture.controller.confirmExport({});
  assert.equal(fixture.controller.state.exportPhase, 'saved');
  const bytes = await readFile(destination);
  const result = verifyProblemPackage(bytes), zip = readProblemZip(bytes);
  assert.equal(result.session.source.kind, 'app-readonly-summary');
  assert.equal(result.kit.domains.find((item) => item.domain === 'dfx').count, 1);
  assert.equal(result.kit.domains.find((item) => item.domain === 'memory').count, 2);
  const memory = zip.get('memory-clues.jsonl').read().toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(memory.map((item) => item.payload.metric), ['pssBytes', 'cpuPercent']);
  const dfx = JSON.parse(zip.get('dfx-events.jsonl').read().toString());
  assert.equal(dfx.payload.eventName, 'APP_CRASH');
  assert.equal(dfx.fingerprint, undefined);
  assert.equal(result.kit.domains.filter((item) => item.status === 'not-captured').length, 16);
  assert.equal(bytes.includes(Buffer.from('private DFX')), false);
  assert.equal(bytes.includes(Buffer.from('params')), false);
});
test('CPU-only export declares its real source and leaves DFX uncollected when no callback arrived', async (context) => {
  const fixture = await connectUi(context);
  fixture.controller.startDfx();
  assert.equal(await fixture.controller.captureCpu(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  fixture.controller.reviewExport();
  const destination = path.join(temporary, 'cpu-only.zip');
  globalThis.__kitTest.save = async () => [destination];
  await fixture.controller.confirmExport({});
  const result = verifyProblemPackage(await readFile(destination));
  assert.equal(result.kit.files.find((item) => item.domain === 'memory').source.api, 'hidebug.getCpuUsage');
  assert.equal(result.kit.domains.find((item) => item.domain === 'dfx').status, 'not-captured');
});
test('DFX archive validation rejects foreign scope, params, wrong source and extra memory metrics', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort(); fixture.controller.startDfx(); port.emit([dfxGroup()]);
  context.mock.timers.tick(1000); await settle();
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
  context.mock.timers.tick(1000); await settle(); fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  const archiveEntry = fileURLToPath(new URL('../examples/OHMateKitProducer/entry/src/main/ets/bridge/KitProblemArchive.ets', import.meta.url));
  await build({ entryPoints: [archiveEntry], outfile: path.join(temporary, 'dfx-archive.mjs'), bundle: true,
    platform: 'node', format: 'esm', loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
  const { makeMemoryProblem } = await import(pathToFileURL(path.join(temporary, 'dfx-archive.mjs')));
  const memory = fixture.controller.memoryFile();
  for (const alter of [
    (file) => { file.records[0].device = 'foreign'; },
    (file) => { file.records[0].payload.params = { external_log: 'private' }; },
    (file) => { file.source.api = 'hiAppEvent.readFaultlog'; },
    (file) => { file.records[0].payload.eventName = 'UNKNOWN'; },
  ]) {
    const file = fixture.controller.dfxFile(); alter(file);
    assert.throws(() => makeMemoryProblem(memory, new NodePort(), undefined, undefined, undefined, file), /EXPORT_SAMPLE_INVALID/);
  }
  const duplicated = fixture.controller.memoryFile(); duplicated.records.push(duplicated.records[0]);
  assert.throws(() => makeMemoryProblem(duplicated, new NodePort()), /EXPORT_SAMPLE_INVALID/);
});
test('DFX failed sending immediately clears watcher evidence and releases the native owner', async (context) => {
  const fixture = await connectUi(context);
  const port = watcherPort(); fixture.controller.startDfx(); port.emit([dfxGroup()]);
  fixture.socket.send = async () => false;
  context.mock.timers.tick(1000); await settle();
  assert.equal(fixture.controller.state.phase, 'stopped');
  assert.equal(fixture.controller.dfxFile(), undefined); assert.equal(port.removed(), 1);
});
test('DFX failed acquisition retains an unremovable owner and rejects retry before explicit revoke', async (context) => {
  const fixture = await connectUi(context);
  let adds = 0;
  globalThis.__kitTest.addWatcher = () => { adds++; return null; };
  globalThis.__kitTest.removeWatcher = () => { throw Error('private remove error'); };
  assert.equal(fixture.controller.startDfx(), false);
  assert.equal(fixture.controller.state.dfxPhase, 'cleanup-failed');
  assert.equal(fixture.controller.startDfx(), false);
  assert.equal(adds, 1);
  await fixture.controller.stop();
  assert.equal(fixture.controller.state.phase, 'cleanup-failed');
  globalThis.__kitTest.removeWatcher = () => {};
  await fixture.controller.stop();
  assert.equal(fixture.controller.state.phase, 'stopped');
});
test('PSS native owner remains pending across revoke and blocks review until actual settlement', async (context) => {
  const fixture = await connectUi(context);
  let resolve;
  globalThis.__kitTest.sample = () => new Promise((done) => { resolve = done; });
  context.mock.timers.tick(1000); await settle();
  await fixture.controller.stop();
  assert.throws(() => fixture.controller.review(fixture.text), /METRICS_CAPTURE_BUSY/);
  resolve(4096); await settle();
  assert.doesNotThrow(() => fixture.controller.review(fixture.text));
  assert.equal(fixture.controller.memoryFile(), undefined);
  assert.equal(fixture.socket.sent.length, 2);
});
test('CPU capability denial and invalid TaskPool value never emit a metric', async (context) => {
  const fixture = await connectUi(context);
  const originalCanIUse = globalThis.canIUse;
  try {
    globalThis.canIUse = (name) => name !== 'SystemCapability.HiviewDFX.HiProfiler.HiDebug';
    globalThis.__kitTest.cpu = () => { throw Error('must not call denied platform'); };
    assert.equal(await fixture.controller.captureCpu(), false);
  } finally { globalThis.canIUse = originalCanIUse; }
  for (const value of [-1, NaN, Infinity, '25']) {
    globalThis.__kitTest.cpu = async () => value;
    assert.equal(await fixture.controller.captureCpu(), false);
    assert.equal(fixture.controller.state.cpuReason, 'CPU_CAPTURE_FAILED');
    assert.equal(fixture.controller.memoryFile(), undefined);
  }
  assert.equal(fixture.socket.sent.length, 2);
  context.mock.timers.tick(1000); await settle();
  const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(event.sequence, 1, 'Rejected CPU readings must not consume the shared event sequence');
  assert.equal(event.payload.metric, 'pssBytes');
});
test('registered Web DOM reads actual command shape, strips private fields and shares the absolute ACK sequence', async (context) => {
  const fixture = await connectWeb(context);
  const { controller, socket, accepted } = fixture;
  assert.equal(controller.state.webAvailable, true);
  assert.equal(await controller.captureWebDom(), true);
  assert.equal(fixture.source.calls(), 1);
  const event = accepted.channel.open(socket.sent.at(-1));
  EventEnvelopeSchema.parse(event);
  assert.equal(event.channel, 'arkweb.dom'); assert.equal(event.sequence, 1);
  assert.equal(await controller.captureWebDom(), false);
  assert.equal(fixture.source.calls(), 1);
  const file = controller.webDomFile();
  assert.equal(file.path, 'web-dom/web-main.json');
  assert.equal(file.records.length, 2);
  assert.deepEqual(file.records.map((record) => record.payload.role), ['main', 'input']);
  const { fingerprint: _fingerprint, ...scope } = accepted.negotiated.identity;
  const profile = buildKitProfile({ files: [file] }, scope);
  assert.equal(profile.profile.files[0].source.api, 'WebviewController.executeAIPageCommand');
  const serialized = JSON.stringify({ event, file });
  for (const field of ['private-title-excluded', 'private-text-excluded', 'private-id-excluded',
    'private-input-excluded', 'private-value-excluded', controlledWebUrl]) {
    assert.equal(serialized.includes(field), false, field);
  }
  file.records[0].payload.role = 'forged';
  assert.equal(controller.webDomFile().records[0].payload.role, 'main');
  await controller.stop();
  assert.equal(controller.webDomFile(), undefined);
});
test('Web DOM invalid, no-result, unknown and over-budget responses produce no event or snapshot', async (context) => {
  const fixture = await connectWeb(context);
  for (const response of ['', 'not-json', '{"code":160,"message":"private-error-excluded"}',
    JSON.stringify({ url: controlledWebUrl, children_nodes: [{ tag: 'div', surprise: 'private-field' }] }),
    JSON.stringify({ url: controlledWebUrl, children_nodes: Array.from({ length: 257 }, () => ({ tag: 'div' })) }),
    JSON.stringify({ url: controlledWebUrl, children_nodes: [{ tag: 'div', text: 'x'.repeat(65536) }] })]) {
    fixture.source.read(async () => response);
    assert.equal(await fixture.controller.captureWebDom(), false);
    assert.equal(fixture.controller.webDomFile(), undefined);
    assert.equal(fixture.controller.state.unacknowledged, 0);
  }
  assert.equal(fixture.socket.sent.length, 2);
});
test('Web DOM native ownership survives a wait timeout and prevents overlapping registrations until settlement', async (context) => {
  const fixture = await connectWeb(context);
  let finish;
  fixture.source.read(() => new Promise((resolve) => { finish = resolve; }));
  const pending = fixture.controller.captureWebDom();
  await settle();
  context.mock.timers.tick(3000);
  await settle();
  assert.equal(await pending, false);
  assert.equal(fixture.controller.state.webReason, 'WEB_CAPTURE_TIMEOUT');
  assert.equal(await fixture.controller.captureWebDom(), false);
  assert.equal(fixture.source.calls(), 1);
  await fixture.controller.stop();
  assert.throws(() => fixture.controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl), /WEB_CAPTURE_BUSY/);
  assert.throws(() => fixture.controller.review(fixture.text), /WEB_CAPTURE_BUSY/);
  finish(JSON.stringify({ url: controlledWebUrl, children_nodes: [{ tag: 'div' }] }));
  await settle();
  fixture.controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl);
  assert.equal(fixture.controller.webDomFile(), undefined);
});
test('Web DOM rebuild, revoke and synchronous expiry discard late native results', async (context) => {
  const fixture = await connectWeb(context);
  for (const action of ['rebuild', 'expiry', 'revoke']) {
    let finish;
    fixture.source.read(() => new Promise((resolve) => { finish = resolve; }));
    const pending = fixture.controller.captureWebDom();
    await settle();
    if (action === 'rebuild') { fixture.controller.webPageBegin(controlledWebUrl); }
    else if (action === 'expiry') { context.mock.timers.setTime(now + 600000); }
    else { await fixture.controller.stop(); }
    finish(JSON.stringify({ url: controlledWebUrl, children_nodes: [{ tag: 'div' }] }));
    await settle();
    assert.equal(await pending, false);
    assert.equal(fixture.controller.webDomFile(), undefined);
    assert.equal(fixture.socket.sent.length, 2);
    if (action === 'rebuild') { fixture.controller.webPageEnd(controlledWebUrl); }
    if (action === 'expiry') { context.mock.timers.setTime(now); }
  }
});
test('Web Console reads native source metadata without message text or retaining raw source paths', async (context) => {
  const fixture = await connectWeb(context);
  const privateMessage = nativeConsoleMessage(3);
  fixture.controller.observeWebConsole(privateMessage);
  context.mock.timers.tick(1000); await settle();
  const consoleEvent = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(consoleEvent.channel, 'arkweb.console');
  assert.equal(consoleEvent.payload.level, 'warn');
  assert.equal(consoleEvent.payload.summary, 'source-3;page;line-1;frame-column-unverified;[MEMORY_ONLY]');
  assert.equal(JSON.stringify(consoleEvent).includes(controlledWebUrl), false);
  EventEnvelopeSchema.parse(consoleEvent);
  assert.equal(fixture.controller.webConsoleFile().records[0].sequence, consoleEvent.sequence);
});
function acknowledgeWeb(fixture, event) {
  fixture.socket.message(fixture.accepted.channel.seal({
    ...fixture.accepted.negotiated.identity, protocolVersion: '1.1', sessionEpoch: fixture.epoch,
    type: 'ack', ackThrough: event.sequence,
  }));
}
test('Web main-navigation emits native callback duration with no status; preconfirmation and rebuilt records are discarded', async (context) => {
  const fixture = await connectWeb(context);
  const { controller } = fixture;
  controller.webNavigationRequest({ isMainFrame: () => true, getRequestUrl: () => controlledWebUrl,
    getRequestMethod: () => 'GET' });
  controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  context.mock.timers.tick(1000); await settle();
  const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(event.channel, 'arkweb.network');
  assert.deepEqual(event.payload, { requestId: 'web-navigation-2', method: 'GET', durationMs: 0 });
  EventEnvelopeSchema.parse(event);
  assert.equal(controller.webNetworkFile().source.api, 'Web.onPageBegin.onPageEnd');
  controller.webPageBegin(controlledWebUrl);
  assert.equal(controller.webNetworkFile(), undefined);
  acknowledgeWeb(fixture, event); await settle();
  controller.observeWebConsole(nativeConsoleMessage());
  controller.webPageBegin(controlledWebUrl);
  context.mock.timers.tick(1000); await settle();
  const next = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(next.channel, 'hidebug');
});
test('failed or timed-out Web DOM collection resumes PSS sampling while retaining the native request owner', async (context) => {
  const fixture = await connectWeb(context);
  let finish;
  fixture.source.read(() => new Promise((resolve) => { finish = resolve; }));
  const pending = fixture.controller.captureWebDom();
  await settle(); context.mock.timers.tick(3000); await settle();
  assert.equal(await pending, false);
  context.mock.timers.tick(1000); await settle();
  assert.equal(fixture.accepted.channel.open(fixture.socket.sent.at(-1)).channel, 'hidebug');
  finish(''); await settle();
});
test('page rebuild during DOM send invalidates its local snapshot; a denied source is never queried', async (context) => {
  const fixture = await connectWeb(context);
  const originalSend = fixture.socket.send.bind(fixture.socket);
  let release;
  fixture.socket.send = async (text) => {
    await originalSend(text);
    return new Promise((resolve) => { release = resolve; });
  };
  const pending = fixture.controller.captureWebDom();
  await settle();
  fixture.controller.webPageBegin(controlledWebUrl);
  release(true); await settle();
  assert.equal(await pending, false);
  assert.equal(fixture.controller.webDomFile(), undefined);
  const calls = fixture.source.calls();
  fixture.source.controller.getUrl = () => 'https://outside.invalid/private';
  assert.equal(await fixture.controller.captureWebDom(), false);
  assert.equal(fixture.source.calls(), calls);
});
test('Web DOM source rejection before native start performs no platform call', async (context) => {
  const fixture = await connectWeb(context);
  const pending = fixture.controller.captureWebDom();
  await fixture.controller.stop();
  await settle();
  assert.equal(await pending, false);
  assert.equal(fixture.source.calls(), 0);
});
test('failed Web DOM sending immediately revokes all evidence instead of waiting for an ACK timeout', async (context) => {
  const fixture = await connectWeb(context);
  fixture.socket.send = async () => false;
  assert.equal(await fixture.controller.captureWebDom(), false);
  await settle();
  assert.equal(fixture.controller.state.phase, 'stopped');
  assert.equal(fixture.controller.state.reason, 'CONNECTION_FAILED');
  assert.equal(fixture.socket.closed, true);
  assert.equal(fixture.controller.webDomFile(), undefined);
  assert.equal(fixture.controller.memoryFile(), undefined);
});
test('Web snapshots are unavailable after source drift even before a navigation callback', async (context) => {
  const fixture = await connectWeb(context);
  assert.equal(await fixture.controller.captureWebDom(), true);
  fixture.source.controller.getUrl = () => 'https://outside.invalid/private';
  assert.equal(fixture.controller.webDomFile(), undefined);
});
test('Web export refuses private parent fields, duplicate nodes and inconsistent child counts', async (context) => {
  const fixture = await connectWeb(context);
  assert.equal(await fixture.controller.captureWebDom(), true);
  acknowledgeWeb(fixture, fixture.accepted.channel.open(fixture.socket.sent.at(-1)));
  await settle(); context.mock.timers.tick(1000); await settle();
  const memory = fixture.controller.memoryFile();
  const bridge = path.dirname(controllerEntry);
  const exportPath = path.join(temporary, 'web-parent-export.mjs');
  await build({ stdin: { contents: "export { makeMemoryProblem } from './KitProblemArchive';",
    resolveDir: bridge, loader: 'ts' }, outfile: exportPath, bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
    plugins: [{ name: 'explicit-web-export-double', setup(builder) {
      builder.onResolve({ filter: /^@kit\./ }, (args) => ({ path: args.path, namespace: 'web-export-double' }));
      builder.onLoad({ filter: /.*/, namespace: 'web-export-double' }, () => ({ loader: 'js',
        contents: 'export const webview={}; export const systemDateTime={};' }));
    } }] });
  const { makeMemoryProblem } = await import(pathToFileURL(exportPath));
  for (const change of [
    (file) => { file.records[1].payload.parentId = 'private-parent-excluded'; },
    (file) => { file.records[1].payload.nodeId = file.records[0].payload.nodeId; },
    (file) => { file.records[0].payload.childCount = 0; },
  ]) {
    const dom = fixture.controller.webDomFile();
    change(dom);
    assert.throws(() => makeMemoryProblem(memory, new NodePort(), undefined, undefined,
      { dom, console: undefined, navigation: undefined }), /EXPORT_SAMPLE_INVALID/);
  }
});
test('a Web navigation started before app confirmation cannot be reported by its late end callback', async (context) => {
  const source = nativeWeb();
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(source.controller, 'web-main', controlledWebUrl);
    controller.webNavigationRequest({ isMainFrame: () => true, getRequestUrl: () => controlledWebUrl, getRequestMethod: () => 'GET' });
    controller.webPageBegin(controlledWebUrl);
  });
  fixture.controller.webPageEnd(controlledWebUrl);
  context.mock.timers.tick(1000); await settle();
  assert.equal(fixture.accepted.channel.open(fixture.socket.sent.at(-1)).channel, 'hidebug');
  assert.equal(fixture.controller.webNetworkFile(), undefined);
});
test('continuous Web events cannot starve the registered native HTTP source', async (context) => {
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
    controller.registerNetwork(nativeRequest().request);
  });
  await fixture.controller.requestNetwork(networkUrl, networkOptions());
  for (const expected of ['arkweb.console', 'hidebug', 'app.network']) {
    fixture.controller.observeWebConsole(nativeConsoleMessage());
    context.mock.timers.tick(1000); await settle();
    const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
    assert.equal(event.channel, expected); acknowledgeWeb(fixture, event); await settle();
  }
});
test('explicit Web export freezes DOM, Console and both network sources without duplicate paths or private fields', async (context) => {
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
    controller.registerNetwork(nativeRequest().request);
  });
  const { controller, socket, accepted } = fixture;
  const receive = () => accepted.channel.open(socket.sent.at(-1));
  const ack = async (event) => { acknowledgeWeb(fixture, event); await settle(); };
  await controller.captureWebDom(); await ack(receive());
  context.mock.timers.tick(1000); await settle(); await ack(receive());
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle(); await ack(receive());
  controller.webNavigationRequest({ isMainFrame: () => true, getRequestUrl: () => controlledWebUrl, getRequestMethod: () => 'GET' });
  controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  await controller.captureWebDom(); await ack(receive());
  controller.observeWebConsole(nativeConsoleMessage());
  for (const channel of ['hidebug', 'arkweb.network', 'hidebug', 'arkweb.console']) {
    context.mock.timers.tick(1000); await settle();
    const event = receive(); assert.equal(event.channel, channel); await ack(event);
  }
  controller.reviewExport();
  assert.equal(controller.state.exportWebNodes, 2);
  const destination = path.join(temporary, 'web-readonly-export.zip');
  globalThis.__kitTest.save = async () => [destination];
  await controller.confirmExport({});
  const content = await readFile(destination), archive = verifyProblemPackage(content);
  assert.equal(archive.session.source.kind, 'app-readonly-summary');
  assert.equal(archive.kit.files.find((file) => file.domain === 'web-dom').count, 2);
  assert.equal(archive.kit.files.find((file) => file.domain === 'web-console').count, 1);
  assert.equal(archive.kit.files.find((file) => file.domain === 'network-summary').count, 2);
  const files = archive.manifest.files;
  assert.equal(new Set(files.map((file) => file.path)).size, files.length);
  assert.equal(readProblemZip(content).size, files.length + 1);
  for (const token of ['private-text-excluded', 'private-title-excluded', 'private-value-excluded', controlledWebUrl, networkUrl]) {
    assert.equal(content.includes(Buffer.from(token)), false);
  }
});
const networkOptions = () => ({ method: 'POST', header: { Authorization: 'test-only-excluded' }, extraData: 'test-only-body-private' });
const networkUrl = 'https://example.invalid/private?secret=excluded';
function ackEvent(socket, accepted, event) {
  const ack = { type: 'ack', ackThrough: event.sequence, protocolVersion: event.protocolVersion,
    sessionEpoch: event.sessionEpoch, fingerprint: event.fingerprint };
  for (const key of ['project', 'buildId', 'device', 'process', 'sessionId']) { ack[key] = event[key]; }
  socket.message(accepted.channel.seal(ack));
}
test('registered native HTTP request preserves response and emits metadata-only encrypted event', async (context) => {
  const native = nativeRequest();
  const { controller, socket, accepted } = await connectNetwork(context, native.request);
  assert.equal(controller.networkFile(), undefined);
  const returned = await controller.requestNetwork(networkUrl, networkOptions());
  assert.equal(returned, native.response); assert.equal(native.calls(), 1);
  assert.equal(socket.sent.length, 2, 'one-second scheduler, no unbounded immediate sends');
  context.mock.timers.tick(1000); await settle();
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent[2]));
  assert.equal(event.channel, 'app.network'); assert.equal(event.sequence, 1);
  assert.deepEqual(event.payload, { requestId: 'request-1', method: 'POST', status: 204, durationMs: 0 });
  assert(!JSON.stringify(event).includes('excluded')); assert(!JSON.stringify(event).includes('secret'));
  const file = controller.networkFile();
  assert.equal(file.path, 'network-summary.jsonl'); assert.equal(file.source.kind, 'registered-adapter');
  assert.equal(file.source.api, 'HttpRequest.request'); assert.equal(file.source.provenance, 'peer-reported');
  assert.equal(file.status, 'summary-only'); assert.equal(file.records.length, 1);
  assert.equal(file.records[0].fingerprint, undefined);
  file.records[0].payload.method = 'DELETE';
  assert.equal(controller.networkFile().records[0].payload.method, 'POST');
  ackEvent(socket, accepted, event); await settle();
  context.mock.timers.tick(1000); await settle();
  const pss = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent[3]));
  assert.equal(pss.channel, 'hidebug'); assert.equal(pss.sequence, 2);
  assert.equal(controller.memoryFile().dropped, 0);
});
test('registered native HTTP failure propagates unchanged and records an absent status', async (context) => {
  const failure = new Error('test-only-network-failure');
  const request = { request: async () => { throw failure; } };
  const { controller, socket, accepted } = await connectNetwork(context, request);
  await assert.rejects(controller.requestNetwork(networkUrl, networkOptions()), (error) => error === failure);
  context.mock.timers.tick(1000); await settle();
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent[2]));
  assert.equal(event.channel, 'app.network'); assert.equal(event.payload.status, undefined);
  assert(!JSON.stringify(event).includes(failure.message));
});
test('registered native HTTP overflow is bounded and reports actual discarded completions', async (context) => {
  const native = nativeRequest();
  const { controller, socket, accepted } = await connectNetwork(context, native.request);
  for (let index = 0; index < 40; index++) { await controller.requestNetwork(networkUrl, networkOptions()); }
  assert.equal(native.calls(), 40);
  for (let index = 0; index < 32; index++) {
    context.mock.timers.tick(1000); await settle();
    const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent.at(-1)));
    assert.equal(event.channel, 'app.network'); assert.equal(event.payload.requestId, `request-${index + 9}`);
    ackEvent(socket, accepted, event); await settle();
    context.mock.timers.tick(1000); await settle();
    const pss = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent.at(-1)));
    assert.equal(pss.channel, 'hidebug'); assert.equal(controller.memoryFile().dropped, index);
    ackEvent(socket, accepted, pss); await settle();
  }
  assert.equal(controller.networkFile().records.length, 1);
  assert.equal(controller.networkFile().dropped, 39);
  context.mock.timers.tick(1000); await settle();
  assert.equal(accepted.channel.open(socket.sent.at(-1)).channel, 'hidebug');
});
test('continuous registered HTTP completions cannot starve the process PSS source', async (context) => {
  const { controller, socket, accepted } = await connectNetwork(context, nativeRequest().request);
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle();
  const first = accepted.channel.open(socket.sent[2]); ackEvent(socket, accepted, first); await settle();
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle();
  const second = accepted.channel.open(socket.sent[3]);
  assert.equal(first.channel, 'app.network'); assert.equal(second.channel, 'hidebug');
  assert.equal(controller.memoryFile().dropped, 0);
});
test('registered HTTP file and pending export bytes become unavailable exactly at expiry', async (context) => {
  const { controller, socket, accepted } = await connectNetwork(context, nativeRequest().request);
  context.mock.timers.tick(1000); await settle();
  const pss = accepted.channel.open(socket.sent[2]); ackEvent(socket, accepted, pss); await settle();
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle(); accepted.channel.open(socket.sent[3]);
  assert(controller.networkFile()); assert(controller.memoryFile());
  const original = Date.now;
  try {
    Date.now = () => accepted.reply.expiresAt;
    assert.equal(controller.networkFile(), undefined); assert.equal(controller.memoryFile(), undefined);
    assert.throws(() => controller.reviewExport(), /EXPORT_SAMPLE_REQUIRED/);
  } finally { Date.now = original; }
});
test('invalid registered HTTP status loses observation but preserves host response', async (context) => {
  const native = nativeRequest(999);
  const { controller, socket, accepted } = await connectNetwork(context, native.request);
  assert.equal(await controller.requestNetwork(networkUrl, networkOptions()), native.response);
  context.mock.timers.tick(1000); await settle();
  assert.equal(accepted.channel.open(socket.sent[2]).channel, 'hidebug');
  assert.equal(controller.networkFile(), undefined);
});
test('registered native HTTP preserves one outstanding ack and failed sending erases summary', async (context) => {
  const { controller, socket, accepted } = await connectNetwork(context, nativeRequest().request);
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle();
  const event = accepted.channel.open(socket.sent[2]);
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle();
  assert.equal(socket.sent.length, 3);
  ackEvent(socket, accepted, event); await settle();
  context.mock.timers.tick(1000); await settle();
  const pss = accepted.channel.open(socket.sent.at(-1)); ackEvent(socket, accepted, pss); await settle();
  socket.send = async () => false;
  context.mock.timers.tick(1000); await settle();
  assert.equal(controller.state.phase, 'stopped'); assert.equal(controller.networkFile(), undefined);
});
test('registered native HTTP rejects active re-registration and does not capture pre-confirmation work', async (context) => {
  const fixture = controllerFixture(context), native = nativeRequest();
  fixture.controller.registerNetwork(native.request);
  assert.equal(await fixture.controller.requestNetwork(networkUrl, networkOptions()), native.response);
  assert.equal(fixture.controller.networkFile(), undefined);
  fixture.controller.review(fixture.text);
  assert.throws(() => fixture.controller.registerNetwork(native.request), /INVALID_STATE/);
});
test('registered native HTTP revoke clears queued data without destroying host request or retaining late result', async (context) => {
  let resolve;
  const response = { responseCode: 200 };
  const request = { request: () => new Promise((done) => { resolve = done; }), destroy: () => assert.fail('host-owned') };
  const { controller, socket } = await connectNetwork(context, request);
  const pending = controller.requestNetwork(networkUrl, networkOptions());
  await controller.stop('BACKGROUND'); resolve(response);
  assert.equal(await pending, response);
  context.mock.timers.tick(1000); await settle();
  assert.equal(socket.sent.length, 2); assert.equal(controller.networkFile(), undefined);
  await assert.rejects(controller.requestNetwork(networkUrl, networkOptions()), /NETWORK_SOURCE_REQUIRED/);
});
test('registered native HTTP completion at expiry cannot restore capture before timer callback', async (context) => {
  let resolve;
  const request = { request: () => new Promise((done) => { resolve = done; }) };
  const { controller, socket, accepted } = await connectNetwork(context, request);
  const pending = controller.requestNetwork(networkUrl, networkOptions());
  const original = Date.now;
  try { Date.now = () => accepted.reply.expiresAt; resolve({ responseCode: 200 }); await pending; }
  finally { Date.now = original; }
  context.mock.timers.tick(1000); await settle();
  const event = accepted.channel.open(socket.sent[2]);
  assert.equal(event.channel, 'hidebug', 'expired completion must not create a network event');
  assert.equal(controller.networkFile(), undefined);
});
test('registered native HTTP export freezes provided network summary and declares all missing domains', async (context) => {
  const { controller, socket, accepted } = await connectNetwork(context, nativeRequest().request);
  context.mock.timers.tick(1000); await settle();
  const pss = accepted.channel.open(socket.sent[2]); ackEvent(socket, accepted, pss); await settle();
  await controller.requestNetwork(networkUrl, networkOptions());
  context.mock.timers.tick(1000); await settle();
  accepted.channel.open(socket.sent[3]);
  controller.reviewExport();
  const destination = path.join(temporary, 'network-application-export.zip');
  globalThis.__kitTest.save = async () => [destination];
  await controller.confirmExport({});
  const content = await readFile(destination), archive = verifyProblemPackage(content);
  assert.equal(archive.session.source.kind, 'app-readonly-summary');
  assert.equal(archive.kit.files.length, 2);
  const network = archive.kit.files.find((file) => file.domain === 'network-summary');
  assert.equal(network.count, 1); assert.equal(network.source.kind, 'registered-adapter');
  assert.equal(archive.kit.domains.filter((domain) => domain.status === 'not-captured').length, 16);
  const signal = new AbortController().signal;
  const zip = await readProblemZipAt(content.length, async (offset, length) => content.subarray(offset, offset + length), signal);
  const page = await verifyProblemArchive(zip, signal, { domain: 'network-summary', after: 0, limit: 1 });
  assert.equal(page.kitPage.records[0].record.payload.status, 204);
  for (const token of ['test-only-excluded', 'test-only-body-private', 'secret=excluded', networkUrl]) {
    assert(!content.includes(Buffer.from(token)), 'No private request field may appear in the archive');
  }
});
test('registered UI source negotiates UI, optional DFX and PSS read capabilities without collecting before confirmation', async (context) => {
  const fixture = uiFixture(context);
  assert.equal(await fixture.controller.captureUi(), false);
  assert.equal(fixture.reads(), 0);
  fixture.controller.review(fixture.text); await fixture.controller.confirm();
  assert.deepEqual(fixture.socket.sent[0].handshake.channels.map((item) => item.channel), ['ui', 'hiappevent', 'hidebug']);
  assert.ok(fixture.socket.sent[0].handshake.channels.every((item) => !item.write && !item.highRisk));
});
test('UI geometry converts measured px to window vp and reports only the visibility attribute', async (context) => {
  const root = uiNode(1, 'Column');
  root.isVisible = () => false;
  const { controller } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), true);
  assert.deepEqual(controller.uiFile().records[0].payload.bounds,
    { x: -3, y: 7, width: 120, height: 40, unit: 'vp', origin: 'window' });
  assert.equal(controller.uiFile().records[0].payload.visible, false);
});
test('UI geometry rejects disposed nodes before any native measurement', async (context) => {
  const root = uiNode(1, 'Column');
  root.isDisposed = () => true;
  root.getMeasuredSize = () => { throw Error('must not measure a disposed entity'); };
  const { controller } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), false);
  assert.equal(controller.uiFile(), undefined);
});
test('UI geometry rejects detached sources before native measurement', async (context) => {
  const root = uiNode(1, 'Column');
  root.isAttached = () => false;
  const { controller } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), false);
  assert.equal(controller.uiFile(), undefined);
});
test('UI traversal skips detached descendants instead of failing the whole capture', async (context) => {
  const child = uiNode(2, 'Text');
  child.isAttached = () => false;
  const root = uiNode(1, 'Column', [child]);
  const { controller } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), true);
  const file = controller.uiFile();
  assert.equal(file.records.length, 1);
  assert.equal(file.records[0].payload.nodeId, 'node-1');
});
for (const [label, change] of [
  ['nonfinite position', (root) => { root.getPositionToWindow = () => ({ x: Infinity, y: 0 }); }],
  ['negative size', (root) => { root.getMeasuredSize = () => ({ width: -1, height: 0 }); }],
  ['nonboolean visibility', (root) => { root.isVisible = () => 'visible'; }],
]) {
  test(`UI geometry rejects ${label} without emitting an event`, async (context) => {
    const root = uiNode(1, 'Column'); change(root);
    const { controller, socket } = await connectUi(context, root);
    assert.equal(await controller.captureUi(), false);
    assert.equal(socket.sent.length, 2);
    assert.equal(controller.uiFile(), undefined);
  });
}
test('UI geometry rejects invalid context conversion rather than mixing units', async (context) => {
  const fixture = await connectUi(context);
  fixture.uiContext.px2vp = () => NaN;
  assert.equal(await fixture.controller.captureUi(), false);
  assert.equal(fixture.controller.uiFile(), undefined);
});
test('UI geometry checks expiry after traversal before consuming sequence or sending', async (context) => {
  const root = uiNode(1, 'Column');
  const { controller, socket, accepted } = await connectUi(context, root);
  const originalNow = Date.now;
  root.getNodeType = () => { Date.now = () => accepted.reply.expiresAt; return 'Column'; };
  try {
    assert.equal(await controller.captureUi(), false);
    assert.equal(socket.sent.length, 2);
    assert.equal(controller.state.unacknowledged, 0);
  } finally { Date.now = originalNow; }
});
test('registered real UI traversal sends a public redacted summary and exposes a defensive structural file', async (context) => {
  const { controller, socket, accepted, reads } = await connectUi(context);
  assert.equal(controller.uiFile(), undefined);
  assert.equal(await controller.captureUi(), true);
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent.at(-1)));
  assert.equal(event.channel, 'ui'); assert.equal(event.sequence, 1);
  assert.deepEqual(event.payload, { windowId: 'page-main', nodeCount: 2, summary: 'registered-subtree;expanded-only' });
  assert.equal(reads(), 1);
  const file = controller.uiFile();
  assert.equal(file.path, 'ui-tree.json');
  assert.equal(file.records.length, 2);
  assert.equal(file.records[0].payload.nodeId, 'node-1');
  assert.equal(file.records[0].payload.parentId, null);
  assert.equal(file.records[1].payload.parentId, 'node-1');
  assert.deepEqual(file.source, { id: 'arkui-tree', kind: 'platform-api',
    api: 'UIContext.getFrameNodeById.FrameNode.getPositionToWindow.getMeasuredSize.isVisible.isAttached',
    provenance: 'peer-reported' });
  const { fingerprint: _fingerprint, ...identity } = accepted.negotiated.identity;
  assert.equal(buildKitProfile({ files: [file] }, identity).profile.domains.find((domain) => domain.domain === 'ui').count, 2);
  file.records[0].payload.role = 'forged';
  assert.equal(controller.uiFile().records[0].payload.role, 'Column');
  assert.equal(JSON.stringify(controller.uiFile()).includes('fingerprint'), false);
});
test('UI capture shares one pending ack and resumes PSS with the next absolute sequence', async (context) => {
  const { controller, socket, accepted, epoch, reads } = await connectUi(context);
  assert.equal(await controller.captureUi(), true);
  assert.equal(accepted.channel.open(socket.sent.at(-1)).channel, 'ui');
  assert.equal(await controller.captureUi(), false);
  assert.equal(reads(), 1);
  context.mock.timers.tick(1000); await settle();
  assert.equal(socket.sent.length, 3, 'The scheduled PSS must not bypass the UI ack');
  socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: 1 }));
  await settle(); context.mock.timers.tick(1000); await settle();
  const event = accepted.channel.open(socket.sent.at(-1));
  assert.equal(event.channel, 'hidebug'); assert.equal(event.sequence, 2);
  assert.equal(controller.memoryFile().dropped, 0, 'UI summaries are not discarded PSS samples');
  controller.reviewExport();
  assert.equal(controller.state.exportDropped, 0);
});
test('UI capture refuses unavailable roots without a placeholder or stopping PSS', async (context) => {
  const { controller } = await connectUi(context, null);
  assert.equal(await controller.captureUi(), false);
  assert.equal(controller.uiFile(), undefined);
  assert.equal(controller.state.uiReason, 'UI_CAPTURE_FAILED');
  assert.equal(controller.state.phase, 'connected');
});
test('UI capture budget rejects oversized expanded trees before reading children', async (context) => {
  let childrenRead = 0;
  const root = uiNode(1, 'Column');
  root.getChildrenCount = () => 256;
  root.getChild = () => { childrenRead++; throw Error('budget must reject before traversal'); };
  const { controller } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), false);
  assert.equal(childrenRead, 0); assert.equal(controller.uiFile(), undefined);
});
test('UI capture rejects cycles without exposing private diagnostics', async (context) => {
  const root = uiNode(1, 'Column');
  root.getChildrenCount = () => 1; root.getChild = () => root;
  const fixture = await connectUi(context, root);
  assert.equal(await fixture.controller.captureUi(), false);
  assert.equal(fixture.controller.uiFile(), undefined);
  assert.equal(fixture.controller.state.uiReason, 'UI_CAPTURE_FAILED');
});
test('UI capture depth budget rejects an arbitrarily deep tree without recursion', async (context) => {
  let root = uiNode(34, 'Text');
  for (let id = 33; id > 0; id--) { root = uiNode(id, 'Column', [root]); }
  const { controller } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), false);
  assert.equal(controller.uiFile(), undefined);
});
test('late UI send cannot restore a tree after background or revoke', async (context) => {
  const { controller, socket } = await connectUi(context);
  let completed;
  socket.send = () => new Promise((resolve) => { completed = resolve; });
  const capture = controller.captureUi(); await settle();
  assert.equal(typeof completed, 'function');
  assert.equal(controller.uiFile(), undefined);
  await controller.stop('APP_BACKGROUND');
  completed(true);
  assert.equal(await capture, false);
  assert.equal(controller.uiFile(), undefined);
  assert.equal(await controller.captureUi(), false);
});
test('UI source cannot change scope while reviewing or connected and unregister revokes it', async (context) => {
  const { controller, uiContext, reads } = await connectUi(context);
  assert.throws(() => controller.registerUi(uiContext, 'other', 'other-window'), /INVALID_STATE/);
  await controller.unregisterUi();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(await controller.captureUi(), false); assert.equal(reads(), 0);
});
test('explicit UI export freezes the current tree and memory summary into their public domain files', async (context) => {
  const { controller, socket, accepted, epoch } = await connectUi(context);
  assert.equal(await controller.captureUi(), true);
  accepted.channel.open(socket.sent.at(-1));
  socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: 1 }));
  await settle(); context.mock.timers.tick(1000); await settle();
  accepted.channel.open(socket.sent.at(-1));
  controller.reviewExport();
  const target = path.join(temporary, 'ui-export.ohmate-problem.zip');
  globalThis.__kitTest.save = async () => [target];
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'saved');
  const result = verifyProblemPackage(await readFile(target));
  assert.equal(result.session.source.kind, 'app-readonly-summary');
  assert.equal(result.session.through, 0); assert.equal(result.events.length, 0);
  assert.equal(result.kit.files.length, 2);
  assert.equal(result.kit.domains.find((domain) => domain.domain === 'ui').count, 2);
  assert.equal(result.kit.domains.find((domain) => domain.domain === 'memory').count, 1);
  assert.equal(result.kit.domains.filter((domain) => domain.status === 'not-captured').length, 16);
  assert.equal(result.session.authentication, 'not-restored');
  assert.equal(result.session.buildVerification, 'unverified');
});
test('UI evidence expires synchronously even if the deadline callback has not fired', async (context) => {
  const { controller, socket, accepted, reads } = await connectUi(context);
  let complete;
  socket.send = () => new Promise((resolve) => { complete = resolve; });
  const capture = controller.captureUi(); await settle();
  const originalDateNow = Date.now;
  const expiry = accepted.reply.expiresAt;
  try {
    Date.now = () => expiry;
    complete(true);
    assert.equal(await capture, false);
    assert.equal(controller.uiFile(), undefined);
    assert.equal(await controller.captureUi(), false);
    assert.equal(reads(), 1);
  } finally { Date.now = originalDateNow; }
});
test('previously captured UI file is unavailable at expiry before the timer executes', async (context) => {
  const { controller, socket, accepted } = await connectUi(context);
  assert.equal(await controller.captureUi(), true);
  accepted.channel.open(socket.sent.at(-1));
  assert.equal(controller.uiFile().records.length, 2);
  const originalDateNow = Date.now;
  try {
    Date.now = () => accepted.reply.expiresAt;
    assert.equal(controller.uiFile(), undefined);
  } finally { Date.now = originalDateNow; }
});
test('UI export identity includes a changed tree even when the frozen PSS sample is unchanged', async (context) => {
  const root = uiNode(1, 'Column');
  const { controller, socket, accepted, epoch } = await connectUi(context, root);
  assert.equal(await controller.captureUi(), true);
  accepted.channel.open(socket.sent.at(-1));
  const ack = (sequence) => socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: sequence }));
  ack(1); await settle(); context.mock.timers.tick(1000); await settle();
  accepted.channel.open(socket.sent.at(-1));
  controller.reviewExport();
  const first = path.join(temporary, 'tree-first.zip');
  globalThis.__kitTest.save = async () => [first]; await controller.confirmExport({});
  const firstProblem = verifyProblemPackage(await readFile(first));
  ack(2); await settle();
  root.getChildrenCount = () => 1; root.getChild = () => uiNode(2, 'Text');
  assert.equal(await controller.captureUi(), true);
  accepted.channel.open(socket.sent.at(-1));
  controller.reviewExport();
  const second = path.join(temporary, 'tree-second.zip');
  globalThis.__kitTest.save = async () => [second]; await controller.confirmExport({});
  const secondProblem = verifyProblemPackage(await readFile(second));
  assert.notEqual(firstProblem.manifest.problemId, secondProblem.manifest.problemId);
  assert.equal(firstProblem.kit.domains.find((item) => item.domain === 'ui').count, 1);
  assert.equal(secondProblem.kit.domains.find((item) => item.domain === 'ui').count, 2);
});
async function prepareController(context) {
  const fixture = controllerFixture(context);
  fixture.controller.review(fixture.text);
  await fixture.controller.confirm();
  const accepted = fixture.authority.accept(fixture.socket.sent[0]);
  fixture.socket.message(accepted.reply);
  const epoch = '00000000-0000-4000-8000-000000000001';
  fixture.socket.message(accepted.channel.seal({ type: 'ready', sessionEpoch: epoch }));
  await settle();
  return { ...fixture, accepted, epoch };
}
async function connectController(context) {
  const fixture = await prepareController(context);
  const { accepted, epoch } = fixture;
  assert.deepEqual(accepted.channel.open(fixture.socket.sent[1]), {
    type: 'ready', sessionEpoch: epoch, clockSync: 'four-timestamp-v1',
    eventBatch: 'events-v1', retention: 'rolling-v1',
  });
  fixture.socket.message(accepted.channel.seal({
    type: 'connected', sessionEpoch: epoch, eventBatch: 'events-v1', retention: 'rolling-v1',
  }));
  await settle();
  assert.equal(fixture.controller.state.phase, 'connected');
  return fixture;
}
const now = 1792800000000;
const identity = {
  project: 'project-test', buildId: 'unverified-example', device: 'ephemeral-device',
  process: 'process-test', sessionId: 'session-test', fingerprint: 'f'.repeat(64),
};
function setup(version = '1.1') {
  const authority = new PairingAuthority({ now: () => now });
  const { fingerprint: _fingerprint, ...target } = identity;
  const invitation = authority.issue(target);
  const text = JSON.stringify({ endpoint: 'ws://127.0.0.1:12345/bridge/v1', invitation });
  const port = new NodePort();
  const input = parsePairing(text, port, now);
  const session = new PairingSession(input, port, () => now, version);
  return { authority, invitation, text, port, input, session };
}
function connect() {
  const value = setup();
  const accepted = value.authority.accept(value.session.request(true));
  value.session.finish(accepted.reply);
  return { ...value, accepted };
}

test('actual ArkTS canonical JSON agrees with the desktop for Unicode, nesting and arrays', () => {
  const value = { z: ['日志', { b: false, a: 0 }], a: null };
  assert.equal(canonical(value), canonicalJson(value));
});
test('requires application confirmation and never sends the invitation value', () => {
  const { session, invitation } = setup();
  assert.throws(() => session.request(false), /APP_CONFIRMATION_REQUIRED/);
  const request = session.request(true);
  assert.equal(request.appConfirmed, true);
  assert.ok(!JSON.stringify(request).includes(invitation.oneTimeCode));
  assert.throws(() => session.request(true), /INVALID_STATE/);
});
test('mutual proofs, directional AES frames and Unicode are interoperable with desktop sources', () => {
  const { accepted, session, port } = connect();
  const ready = { type: 'ready', sessionEpoch: 'epoch' };
  assert.deepEqual(session.open(accepted.channel.seal(ready)), ready);
  assert.deepEqual(accepted.channel.open(session.seal({ type: 'ready', summary: '设备 ✓' })), { type: 'ready', summary: '设备 ✓' });
  session.close();
  assert.equal(port.cleared, true);
  assert.throws(() => session.seal(ready), /INVALID_STATE/);
  accepted.channel.close();
});
for (const version of ['1.0', '1.1']) {
  test(`negotiates ${version} with only the implemented hidebug channel`, () => {
    const { session, authority } = setup(version);
    const accepted = authority.accept(session.request(true));
    session.finish(accepted.reply);
    assert.equal(session.negotiated.protocolVersion, version);
    assert.deepEqual(session.negotiated.channels.map((offer) => offer.channel), ['hidebug']);
    session.close(); accepted.channel.close();
  });
}
test('rejects LAN, userinfo, query, escaped hosts, malformed URLs and expired invitations', () => {
  const { invitation, port } = setup();
  for (const endpoint of ['ws://example.test:1/bridge/v1', 'ws://127.0.0.1@evil:1/bridge/v1',
    'ws://127.0.0.1:12345/bridge/v1?q=1', 'ws://2130706433:1/bridge/v1',
    'ws://127.0.0.1:99999/bridge/v1', 'ws://127.0.0.1:0/bridge/v1']) {
    assert.throws(() => parsePairing(JSON.stringify({ endpoint, invitation }), port, now));
  }
  assert.throws(() => parsePairing(JSON.stringify({ endpoint: 'ws://127.0.0.1:12345/bridge/v1',
    invitation: { ...invitation, expiresAt: now } }), port, now));
});
test('rejects unknown fields, changed hashes, write grants and missing real collector channel', () => {
  const { invitation, port } = setup();
  const variants = [
    { ...invitation, unexpected: 'value' },
    { ...invitation, fingerprint: 'a'.repeat(64) },
    { ...invitation, oneTimeCode: 'short' },
    { ...invitation, handshake: { ...invitation.handshake, channels: [invitation.handshake.channels[0]] } },
  ];
  for (const key of ['schemaHash', 'capabilityHash', 'write']) {
    const altered = structuredClone(invitation);
    altered.handshake.channels.find((item) => item.channel === 'hidebug')[key] = key === 'write' ? true : 'a'.repeat(64);
    variants.push(altered);
  }
  for (const changed of variants) {
    assert.throws(() => parsePairing(JSON.stringify({ endpoint: 'ws://127.0.0.1:12345/bridge/v1', invitation: changed }), port, now));
  }
});
test('rejects wrong server proof and clears ephemeral state', () => {
  const { session, authority, port } = setup();
  const accepted = authority.accept(session.request(true));
  assert.throws(() => session.finish({ ...accepted.reply, proof: '0'.repeat(64) }), /PAIRING_INVALID/);
  assert.equal(port.cleared, true);
  assert.throws(() => session.finish(accepted.reply), /INVALID_STATE/);
  accepted.channel.close();
});
test('rejects replay, skipped counters, reflection, changed tags and future key limits', () => {
  for (const mutation of ['replay', 'gap', 'reflection', 'tag', 'scope']) {
    const { session, accepted, port } = connect();
    const frame = accepted.channel.seal({ type: 'ready' });
    if (mutation === 'replay') { session.open(frame); }
    if (mutation === 'gap') { frame.counter = 2; }
    if (mutation === 'reflection') { frame.direction = 'kit-to-cli'; }
    if (mutation === 'tag') { frame.tag = Buffer.alloc(16).toString('base64'); }
    if (mutation === 'scope') { frame.connectionId = 'a'.repeat(64); }
    assert.throws(() => session.open(frame));
    assert.equal(port.cleared, true);
    accepted.channel.close();
  }
});
test('real-metric event shape has full scope, monotonic clock and explicit unsynchronized uncertainty', () => {
  const { session, accepted } = connect();
  const event = makeMetricEvent(session.negotiated, 'epoch-test', 1, 'clock-test', '123456',
    new Date(now).toISOString(), 1024);
  assert.equal(EventEnvelopeSchema.parse(event).payload.value, 1024);
  assert.equal(event.offsetUncertaintyMs, Number.MAX_SAFE_INTEGER);
  assert.equal(event.monotonicNs, '123456');
  assert.throws(() => makeMetricEvent(session.negotiated, 'epoch-test', 1, 'clock-test', '123456',
    new Date(now).toISOString(), -1));
  session.close(); accepted.channel.close();
});
test('controller connects only after explicit confirmation and disables proxies', async (context) => {
  const { controller, socket, text } = controllerFixture(context);
  controller.review(text);
  assert.equal(socket.sent.length, 0);
  assert.equal(controller.state.phase, 'review');
  await controller.confirm();
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.options.proxy, 'no-proxy');
  assert.equal(socket.options.protocol, 'ohmate-readonly-v1');
});
test('controller explicitly requests rolling history and waits for the exact encrypted echo', async (context) => {
  const { controller, socket, accepted, epoch } = await prepareController(context);
  assert.deepEqual(accepted.channel.open(socket.sent[1]), {
    type: 'ready', sessionEpoch: epoch, clockSync: 'four-timestamp-v1',
    eventBatch: 'events-v1', retention: 'rolling-v1',
  });
  let samples = 0;
  globalThis.__kitTest.sample = async () => { samples++; return 4096; };
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(controller.state.phase, 'confirming');
  assert.equal(samples, 0);
  assert.equal(socket.sent.length, 2);
  socket.message(accepted.channel.seal({
    type: 'connected', sessionEpoch: epoch, eventBatch: 'events-v1', retention: 'rolling-v1',
  }));
  await settle();
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(samples, 1);
  assert.equal(EventEnvelopeSchema.parse(accepted.channel.open(socket.sent[2])).sequence, 1);
  assert.equal(controller.state.unacknowledged, 1);
});
for (const invalid of ['missing-retention', 'missing-batch', 'missing-both', 'wrong-retention',
  'wrong-batch', 'extra', 'epoch', 'resumed']) {
  test(`ArkTS controller rejects ${invalid} connected echo before starting any collection`, async (context) => {
    const { controller, socket, accepted, epoch } = await prepareController(context);
    assert.equal(accepted.channel.open(socket.sent[1]).type, 'ready');
    let samples = 0;
    globalThis.__kitTest.sample = async () => { samples++; return 4096; };
    const echo = { type: 'connected', sessionEpoch: epoch, eventBatch: 'events-v1', retention: 'rolling-v1' };
    if (invalid === 'missing-retention' || invalid === 'missing-both') { delete echo.retention; }
    if (invalid === 'missing-batch' || invalid === 'missing-both') { delete echo.eventBatch; }
    if (invalid === 'wrong-retention') { echo.retention = 'future-v2'; }
    if (invalid === 'wrong-batch') { echo.eventBatch = 'future-v2'; }
    if (invalid === 'extra') { echo.resume = true; }
    if (invalid === 'epoch') { echo.sessionEpoch = '00000000-0000-4000-8000-000000000002'; }
    if (invalid === 'resumed') { echo.type = 'resumed'; }
    socket.message(accepted.channel.seal(echo));
    await settle();
    assert.equal(controller.state.phase, 'stopped');
    assert.equal(controller.state.reason, 'FRAME_REJECTED');
    assert.equal(controller.state.ackThrough, 0);
    assert.equal(controller.state.unacknowledged, 0);
    assert.equal(socket.closed, true);
    assert.equal(socket.handlers.size, 0);
    context.mock.timers.tick(600000);
    await settle();
    assert.equal(samples, 0);
    assert.equal(socket.sent.length, 2);
  });
}
test('actual ArkTS controller answers encrypted clock probes without consuming a sample ack', async (context) => {
  const { controller, socket, accepted, epoch } = await connectController(context);
  const probe = { type: 'clock-probe', version: '1', probeId: '00000000-0000-4000-8000-000000000009',
    sessionEpoch: epoch, t0: '12345678901234567890' };
  socket.message(accepted.channel.seal(probe));
  await settle();
  const reply = accepted.channel.open(socket.sent.at(-1));
  assert.equal(reply.type, 'clock-reply');
  assert.equal(reply.t0, probe.t0);
  assert.equal(reply.t1, '100000000');
  assert.equal(reply.t2, '100000000');
  assert.equal(reply.precisionNs, '1000000');
  assert.equal(reply.clockId, reply.bootId);
  assert.equal(controller.state.ackThrough, 0);
  assert.equal(controller.state.phase, 'connected');
  context.mock.timers.tick(1000);
  await settle();
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent.at(-1)));
  assert.equal(event.clockId, reply.clockId);
  assert.equal(controller.state.unacknowledged, 1);
  socket.message(accepted.channel.seal({ ...probe, probeId: '00000000-0000-4000-8000-000000000010' }));
  await settle();
  assert.equal(accepted.channel.open(socket.sent.at(-1)).type, 'clock-reply');
  assert.equal(controller.state.unacknowledged, 1);
  assert.equal(controller.state.ackThrough, 0);
});
for (const invalid of ['epoch', 'replay', 'precision', 'extra']) {
  test(`ArkTS controller rejects a clock probe with ${invalid}`, async (context) => {
    const { controller, socket, accepted, epoch } = await connectController(context);
    const probe = { type: 'clock-probe', version: '1', probeId: '00000000-0000-4000-8000-000000000009',
      sessionEpoch: epoch, t0: '100' };
    if (invalid === 'replay') { socket.message(accepted.channel.seal(probe)); await settle(); }
    if (invalid === 'epoch') { probe.sessionEpoch = '00000000-0000-4000-8000-000000000002'; }
    if (invalid === 'precision') { probe.t0 = '18446744073709551616'; }
    if (invalid === 'extra') { probe.execute = 'write'; }
    socket.message(accepted.channel.seal(probe));
    await settle();
    assert.equal(controller.state.phase, 'stopped');
    assert.equal(controller.state.ackThrough, 0);
  });
}
test('controller reports socket-creation failure and closes instead of retaining pairing state', async (context) => {
  const { controller, text } = controllerFixture(context);
  controller.review(text);
  globalThis.__kitTest.socketFactory = () => { throw new Error('platform failure with sensitive detail'); };
  await controller.confirm();
  assert.equal(controller.state.phase, 'stopped');
  assert.ok(!controller.state.reason.includes('sensitive'));
});
test('controller handles synchronous socket-close failure without retaining active keys', async (context) => {
  const { controller, socket, text } = controllerFixture(context);
  controller.review(text);
  await controller.confirm();
  socket.close = () => { throw new Error('native failure'); };
  await controller.stop();
  assert.equal(controller.state.phase, 'cleanup-failed');
  assert.equal(controller.state.reason, 'SOCKET_CLOSE_FAILED');
  assert.throws(() => controller.review(text));
  socket.close = async () => true;
  await controller.stop();
  assert.equal(controller.state.phase, 'stopped');
});
test('controller treats a remote close event as terminal despite failed best-effort cleanup', async (context) => {
  const { controller, socket, text } = controllerFixture(context);
  controller.review(text);
  await controller.confirm();
  let closes = 0;
  socket.close = async () => { closes++; throw new Error('native failure'); };
  socket.off = () => { throw new Error('native detach failure'); };
  socket.handlers.get('close')?.();
  await controller.stop('CONNECTION_CLOSED');
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(closes, 1);
  controller.review(text);
  assert.equal(controller.state.phase, 'review');
});
test('background revocation drops a late metrics result and removes listeners', async (context) => {
  const { controller, socket } = await connectController(context);
  let resolveMetric;
  globalThis.__kitTest.sample = () => new Promise((resolve) => { resolveMetric = resolve; });
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(typeof resolveMetric, 'function');
  const sent = socket.sent.length;
  await controller.stop('APP_BACKGROUND');
  resolveMetric(4096);
  await settle();
  assert.equal(socket.sent.length, sent);
  assert.equal(socket.handlers.size, 0);
  assert.equal(socket.closed, true);
  assert.equal(controller.state.phase, 'stopped');
});
test('collector waits for persisted ack, refuses changed scope and preserves unacknowledged sequence', async (context) => {
  const { controller, socket, accepted, epoch } = await connectController(context);
  context.mock.timers.tick(1000);
  await settle();
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent.at(-1)));
  assert.equal(event.payload.value, 4096);
  assert.equal(controller.state.unacknowledged, 1);
  const sent = socket.sent.length;
  context.mock.timers.tick(2000);
  await settle();
  assert.equal(socket.sent.length, sent);
  socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: 1, device: 'changed' }));
  await settle();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(controller.state.ackThrough, 0);
  assert.equal(controller.state.unacknowledged, 1);
});
test('controller expires an unused invitation and never auto-reconnects after stopping', async (context) => {
  const { controller, socket, text } = controllerFixture(context);
  controller.review(text);
  context.mock.timers.tick(120000);
  await settle();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(socket.sent.length, 0);
  context.mock.timers.tick(600000);
  assert.equal(socket.sent.length, 0);
});
test('valid ack permits exactly the next sample and missing ack stops with a visible gap', async (context) => {
  const { controller, socket, accepted, epoch } = await connectController(context);
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(accepted.channel.open(socket.sent.at(-1)).sequence, 1);
  socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: 1 }));
  await settle();
  assert.equal(controller.state.ackThrough, 1);
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(accepted.channel.open(socket.sent.at(-1)).sequence, 2);
  context.mock.timers.tick(10000);
  await settle();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(controller.state.reason, 'ACK_TIMEOUT');
  assert.equal(controller.state.unacknowledged, 2);
});
test('actual metrics body converts exactly one platform KB reading to bytes', () => {
  let calls = 0;
  globalThis.__kitTest.nativePss = () => { calls++; return 8n; };
  assert.equal(readPssBytes(), 8192);
  assert.equal(calls, 1);
});
for (const value of [-1n, BigInt(Number.MAX_SAFE_INTEGER)]) {
  test(`actual metrics body refuses out-of-range KB ${value}`, () => {
    globalThis.__kitTest.nativePss = () => value;
    assert.throws(() => readPssBytes(), /PSS_SAMPLE_INVALID/);
  });
}
test('no memory file exists before a confirmed successful sample', async (context) => {
  const { controller } = await connectController(context);
  assert.equal(controller.memoryFile(), undefined);
});
test('confirmed memory sample validates as a real domain file with platform source declaration', async (context) => {
  const { controller, socket, accepted } = await connectController(context);
  context.mock.timers.tick(1000); await settle();
  const event = accepted.channel.open(socket.sent.at(-1)), file = controller.memoryFile();
  assert.equal(file.path, 'memory-clues.jsonl');
  assert.deepEqual(file.source, { id: 'process-pss', kind: 'platform-api', api: 'hidebug.getPss', provenance: 'peer-reported' });
  assert.equal(file.status, 'summary-only'); assert.equal(file.sampled, true); assert.equal(file.dropped, 0);
  assert.equal(file.records.length, 1); assert.equal(file.records[0].payload.value, event.payload.value);
  assert.equal(Object.hasOwn(file.records[0], 'fingerprint'), false);
  const { fingerprint: _fingerprint, ...scope } = accepted.negotiated.identity;
  const profile = buildKitProfile({ files: [file] }, scope);
  assert.equal(profile.profile.domains.find((domain) => domain.domain === 'memory').count, 1);
  assert.equal(profile.profile.domains.filter((domain) => domain.status === 'not-captured').length, 17);
  assert.equal(profile.profile.provenance, 'peer-reported');
});
test('memory file retains one defensive record and reports replaced samples as dropped', async (context) => {
  const { controller, socket, accepted, epoch } = await connectController(context);
  context.mock.timers.tick(1000); await settle();
  const file = controller.memoryFile();
  file.records[0].payload.value = 777; file.source.api = 'forged';
  assert.equal(controller.memoryFile().records[0].payload.value, 4096);
  assert.equal(controller.memoryFile().source.api, 'hidebug.getPss');
  socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: 1 }));
  await settle();
  context.mock.timers.tick(1000); await settle();
  assert.equal(controller.memoryFile().records.length, 1);
  assert.equal(controller.memoryFile().records[0].sequence, 2);
  assert.equal(controller.memoryFile().dropped, 1);
  await controller.stop('APP_BACKGROUND');
  assert.equal(controller.memoryFile(), undefined);
});
test('late sample-send completion cannot restore memory evidence after revoke', async (context) => {
  const { controller, socket } = await connectController(context);
  let completed;
  socket.send = () => new Promise((resolve) => { completed = resolve; });
  context.mock.timers.tick(1000); await settle();
  assert.equal(typeof completed, 'function');
  assert.equal(controller.memoryFile(), undefined);
  await controller.stop('APP_BACKGROUND');
  completed(true); await settle();
  assert.equal(controller.memoryFile(), undefined);
});
test('failed platform capture produces no placeholder memory file', async (context) => {
  const { controller } = await connectController(context);
  globalThis.__kitTest.sample = async () => { throw new Error('private platform diagnostic'); };
  context.mock.timers.tick(1000); await settle();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(controller.state.reason, 'COLLECTION_FAILED');
  assert.equal(controller.memoryFile(), undefined);
});
test('controller rejects a remote write without executing or acknowledging it', async (context) => {
  const { controller, socket, accepted } = await connectController(context);
  const before = socket.sent.length;
  socket.message(accepted.channel.seal({ type: 'command', capability: 'ui.write', command: 'click' }));
  await settle();
  assert.equal(controller.state.phase, 'stopped');
  assert.equal(socket.sent.length, before);
  assert.equal(controller.state.ackThrough, 0);
});
test('export confirmation requires a reviewed current sample before opening a picker or file', async (context) => {
  const { controller } = await connectController(context);
  assert.throws(() => controller.reviewExport(), /EXPORT_SAMPLE_REQUIRED/);
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'idle');
  assert.equal(controller.memoryFile(), undefined);
});
test('reviewed application ZIP validates publicly with explicit memory source and 17 missing domains', async (context) => {
  const { controller } = await connectController(context);
  context.mock.timers.tick(1000); await settle();
  controller.reviewExport();
  assert.equal(controller.state.exportPhase, 'review');
  assert.equal(controller.state.exportSequence, 1);
  assert.equal(controller.state.exportDropped, 0);
  assert.ok(controller.state.exportBytes > 0 && controller.state.exportBytes <= 1024 ** 2);
  const target = path.join(temporary, 'app-export.ohmate-problem.zip');
  let options;
  globalThis.__kitTest.save = async (value) => { options = value; return [target]; };
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'saved');
  assert.ok(options.newFileNames[0].endsWith('.ohmate-problem.zip'));
  assert.equal(options.autoCreateEmptyFile, false, 'The picker must not pre-create a file before the revoke check');
  const bytes = await readFile(target), result = verifyProblemPackage(bytes);
  const record = JSON.parse(readProblemZip(bytes).get('memory-clues.jsonl').read().toString());
  assert.equal(bytes.length, controller.state.exportBytes);
  assert.equal(result.payloadIntegrity, 'verified');
  assert.equal(result.session.source.kind, 'app-memory-summary');
  assert.equal(result.session.through, 0);
  assert.equal(result.session.authentication, 'not-restored');
  assert.equal(result.session.deviceProvenance, 'peer-asserted');
  assert.equal(result.session.buildVerification, 'unverified');
  assert.equal(result.events.length, 0);
  assert.equal(result.kit.domains.filter((domain) => domain.status === 'not-captured').length, 17);
  assert.equal(record.payload.value, 4096);
  assert.equal(record.sequence, 1);
  assert.equal(result.kit.files[0].source.api, 'hidebug.getPss');
  assert.equal(result.kit.files[0].source.provenance, 'peer-reported');
  assert.equal(result.kit.attachmentPolicy, 'none');
  assert.ok(!bytes.includes(Buffer.from(controller.state.fingerprint)));
  await controller.stop('APP_BACKGROUND');
  assert.equal(controller.state.exportPhase, 'idle');
  assert.deepEqual(await readFile(target), bytes, 'A saved user file does not belong to revoke cleanup');
});
test('export review freezes exactly the displayed sample instead of replacing it during confirmation', async (context) => {
  const { controller, socket, accepted, epoch } = await connectController(context);
  context.mock.timers.tick(1000); await settle();
  controller.reviewExport();
  socket.message(accepted.channel.seal({ ...accepted.negotiated.identity, type: 'ack',
    protocolVersion: accepted.negotiated.protocolVersion, sessionEpoch: epoch, ackThrough: 1 }));
  await settle();
  globalThis.__kitTest.sample = async () => 8192;
  context.mock.timers.tick(1000); await settle();
  assert.equal(controller.memoryFile().records[0].sequence, 2);
  assert.equal(controller.state.exportSequence, 1);
  const target = path.join(temporary, 'frozen.ohmate-problem.zip');
  globalThis.__kitTest.save = async () => [target];
  await controller.confirmExport({});
  const bytes = await readFile(target), result = verifyProblemPackage(bytes);
  const record = JSON.parse(readProblemZip(bytes).get('memory-clues.jsonl').read().toString());
  assert.equal(record.sequence, 1);
  assert.equal(record.payload.value, 4096);
  assert.equal(result.kit.files[0].dropped, 0);
});
test('revocation while choosing a destination prevents late export writes and blocks overlapping pickers', async (context) => {
  const { controller } = await connectController(context);
  context.mock.timers.tick(1000); await settle(); controller.reviewExport();
  let selected, opens = 0;
  globalThis.__kitTest.save = () => new Promise((resolve) => { selected = resolve; });
  globalThis.__kitTest.fileIo.openSync = () => { opens++; throw Error('must not write'); };
  const pending = controller.confirmExport({});
  await settle();
  assert.equal(controller.state.exportPhase, 'saving');
  assert.throws(() => controller.reviewExport(), /EXPORT_BUSY/);
  await controller.stop('APP_BACKGROUND');
  selected([path.join(temporary, 'late.ohmate-problem.zip')]);
  await pending;
  assert.equal(opens, 0);
  assert.equal(controller.state.exportPhase, 'idle');
});
test('cancelled export review and picker cancellation never produce a file', async (context) => {
  const { controller } = await connectController(context);
  context.mock.timers.tick(1000); await settle(); controller.reviewExport();
  controller.cancelExport();
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'idle');
  controller.reviewExport();
  globalThis.__kitTest.save = async () => [];
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'cancelled');
});
test('an expired connection cancels export even before its timer callback executes', async (context) => {
  const { controller } = await connectController(context);
  context.mock.timers.tick(1000); await settle(); controller.reviewExport();
  let selected, opens = 0;
  globalThis.__kitTest.save = () => new Promise((resolve) => { selected = resolve; });
  globalThis.__kitTest.fileIo.openSync = () => { opens++; throw Error('expired export write'); };
  const pending = controller.confirmExport({});
  await settle();
  context.mock.timers.setTime(now + 601000);
  selected([path.join(temporary, 'expired.ohmate-problem.zip')]);
  await pending;
  assert.equal(opens, 0);
  assert.equal(controller.state.exportPhase, 'cancelled');
});
test('export handles short writes, syncs and closes the complete user-selected ZIP', async (context) => {
  const { controller } = await connectController(context);
  context.mock.timers.tick(1000); await settle(); controller.reviewExport();
  const target = path.join(temporary, 'short.ohmate-problem.zip');
  const io = globalThis.__kitTest.fileIo, close = io.closeSync;
  let synced = false, closed = false, calls = 0;
  io.writeSync = (fd, bytes) => { calls++; return fs.writeSync(fd, Buffer.from(bytes).subarray(0, 4096)); };
  io.fsyncSync = (fd) => { fs.fsyncSync(fd); synced = true; };
  io.closeSync = (file) => { assert.equal(synced, true); close(file); closed = true; };
  globalThis.__kitTest.save = async () => [target];
  await controller.confirmExport({});
  assert.ok(calls > 1 && closed);
  assert.equal(controller.state.exportPhase, 'saved');
  assert.equal(verifyProblemPackage(await readFile(target)).payloadIntegrity, 'verified');
});
test('export refuses existing content and preserves its bytes', async (context) => {
  const { controller } = await connectController(context);
  context.mock.timers.tick(1000); await settle(); controller.reviewExport();
  const target = path.join(temporary, 'existing.ohmate-problem.zip'), original = Buffer.from('existing user content');
  await writeFile(target, original);
  globalThis.__kitTest.save = async () => [target];
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'failed');
  assert.equal(controller.state.exportReason, 'EXPORT_FAILED');
  assert.deepEqual(await readFile(target), original);
});
for (const failure of ['zero-write', 'sync', 'close', 'picker']) {
  test(`export ${failure} failure cannot report saved; retained handles close on revoke`, async (context) => {
    const { controller } = await connectController(context);
    context.mock.timers.tick(1000); await settle(); controller.reviewExport();
    const target = path.join(temporary, `${failure}.ohmate-problem.zip`);
    const io = globalThis.__kitTest.fileIo, close = io.closeSync;
    let openFile;
    const open = io.openSync;
    io.openSync = (name, flags) => { openFile = open(name, flags); return openFile; };
    globalThis.__kitTest.save = async () => [target];
    if (failure === 'zero-write') { io.writeSync = () => 0; }
    if (failure === 'sync') { io.fsyncSync = () => { throw Error('private sync failure'); }; }
    if (failure === 'close') { io.closeSync = () => { throw Error('private close failure'); }; }
    if (failure === 'picker') { globalThis.__kitTest.save = async () => { throw Error('private chooser failure'); }; }
    await controller.confirmExport({});
    assert.equal(controller.state.exportPhase, failure === 'close' ? 'cleanup-failed' : 'failed');
    assert.ok(!controller.state.exportReason.includes('private'));
    if (failure === 'close') { assert.throws(() => controller.reviewExport(), /EXPORT_BUSY/); }
    io.closeSync = close;
    await controller.stop();
    if (openFile) { assert.throws(() => fs.fstatSync(openFile.fd), { code: 'EBADF' }); }
    assert.equal(controller.state.exportPhase, 'idle');
  });
}
test('release build and missing system capabilities cannot enter pairing', async (context) => {
  controllerFixture(context);
  globalThis.__kitTest.debug = false;
  const release = new ProducerController();
  release.initialize();
  assert.equal(release.state.phase, 'unavailable');
  assert.equal(release.state.localTarget, '');
  assert.throws(() => release.review('{}'));
  globalThis.__kitTest.debug = true;
  globalThis.canIUse = () => false;
  const unsupported = new ProducerController();
  unsupported.initialize();
  assert.equal(unsupported.state.reason, 'CAPABILITY_UNAVAILABLE');
  assert.throws(() => unsupported.review('{}'));
  globalThis.canIUse = () => true;
});
test('key expiry and frame limits close the session; altered reply budgets fail proof', () => {
  for (const mutation of ['expiry', 'budget', 'counter']) {
    const authority = new PairingAuthority({ now: () => now, maxFrames: 1 });
    const { fingerprint: _fingerprint, ...target } = identity;
    const invitation = authority.issue(target);
    const port = new NodePort();
    let clock = now;
    const input = parsePairing(JSON.stringify({ endpoint: 'ws://127.0.0.1:12345/bridge/v1', invitation }), port, now);
    const session = new PairingSession(input, port, () => clock);
    const accepted = authority.accept(session.request(true));
    if (mutation === 'budget') {
      assert.throws(() => session.finish({ ...accepted.reply, maxFrames: 2 }), /PAIRING_INVALID/);
    } else {
      session.finish(accepted.reply);
      if (mutation === 'expiry') { clock += 600000; }
      else { session.seal({ type: 'ready' }); }
      assert.throws(() => session.seal({ type: 'ready' }), /KEY_EXPIRED/);
    }
    assert.equal(port.cleared, true);
    authority.close();
  }
});

const bodyUrl = 'http://127.0.0.1:12345/ohmate-body-sample';
const bodyRule = () => ({ version: '1', targetId: 'network-main', origin: 'http://127.0.0.1:12345',
  path: '/ohmate-body-sample', contentTypes: ['application/json', 'text/plain'],
  maxBytes: 65536, maxTotalBytes: 262144, ttlMs: 30000 });
const bodyOptions = () => ({ method: 'GET', maxRedirects: 0, usingCache: false });
function bodyResponse(text = '{"count":2,"ok":true,"label":"private-label","Token":42}', type = 'application/json') {
  const response = { responseCode: 200, resultType: 0, result: text,
    header: { 'content-type': type }, connectionExtraInfo: { redirectCount: 0 } };
  for (const key of ['cookies', 'performanceTiming']) {
    Object.defineProperty(response, key, { get: () => { throw Error('unrelated native response must not be read'); } });
  }
  return response;
}
function approveBody(controller, rule = bodyRule()) {
  const review = controller.reviewNetworkBody(JSON.stringify(rule));
  assert.equal(review.scope, 'network.body.capture');
  assert.match(review.planHash, /^[a-f0-9]{64}$/);
  assert.equal(controller.confirmNetworkBody(review.planHash), true);
  return review;
}
test('body capture is closed by default and only applies after its own application confirmation', async (context) => {
  const response = bodyResponse();
  const { controller } = await connectNetwork(context, { request: async () => response });
  assert.equal(controller.networkBodyPreview(), undefined);
  assert.equal(await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary'), response);
  assert.equal(controller.networkBodyPreview(), undefined);
  const review = controller.reviewNetworkBody(JSON.stringify(bodyRule()));
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(controller.networkBodyPreview(), undefined, 'review alone is not consent');
  assert.equal(controller.confirmNetworkBody('0'.repeat(64)), false);
  assert.equal(controller.confirmNetworkBody(review.planHash), true);
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  const preview = controller.networkBodyPreview();
  assert.equal(preview.targetId, 'network-main');
  assert.equal(preview.body, '{"count":2,"ok":true,"label":"[redacted]","Token":"[redacted]"}');
  assert.equal(preview.mode, 'application-local-memory-only');
  assert.equal(preview.authentication, 'not-authenticated');
  assert.equal(controller.confirmNetworkBody(review.planHash), true, 'confirmation is idempotent');
  preview.body = 'mutated';
  assert.notEqual(controller.networkBodyPreview().body, 'mutated');
});
for (const [name, mutateUrl, mutateOptions, classification] of [
  ['unknown', (u) => u, (o) => o, 'unknown'],
  ['authentication', (u) => u, (o) => o, 'authentication'],
  ['other origin', () => 'http://127.0.0.1:12346/ohmate-body-sample', (o) => o, 'ordinary'],
  ['other path', () => 'http://127.0.0.1:12345/other', (o) => o, 'ordinary'],
  ['query', (u) => `${u}?token=excluded`, (o) => o, 'ordinary'],
  ['POST', (u) => u, (o) => ({ ...o, method: 'POST' }), 'ordinary'],
  ['Authorization', (u) => u, (o) => ({ ...o, header: { Authorization: 'excluded' } }), 'ordinary'],
  ['request body', (u) => u, (o) => ({ ...o, body: 'excluded' }), 'ordinary'],
  ['queryParams', (u) => u, (o) => ({ ...o, queryParams: 'excluded' }), 'ordinary'],
  ['extraData', (u) => u, (o) => ({ ...o, extraData: 'excluded' }), 'ordinary'],
  ['custom method', (u) => u, (o) => ({ ...o, customMethod: 'DELETE' }), 'ordinary'],
  ['redirects enabled', (u) => u, (o) => ({ ...o, maxRedirects: 30 }), 'ordinary'],
  ['cache enabled', (u) => u, (o) => ({ ...o, usingCache: true }), 'ordinary'],
]) {
  test(`body capture leaves ${name} request and response untouched`, async (context) => {
    let called = 0, seenOptions, seenUrl;
    const response = nativeRequest().response;
    const { controller } = await connectNetwork(context, { request: async (url, options) => {
      called++; seenOptions = options; seenUrl = url; return response;
    } });
    approveBody(controller);
    const options = mutateOptions(bodyOptions()), url = mutateUrl(bodyUrl);
    assert.equal(await controller.requestNetwork(url, options, classification), response);
    assert.equal(seenUrl, url); assert.equal(seenOptions, options); assert.equal(called, 1);
    assert.equal(controller.networkBodyPreview(), undefined);
  });
}
test('body capture validates exact rules and does not retain a cancelled or replaced review', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  for (const mutation of [
    { targetId: 'other' }, { version: '2' }, { origin: 'http://user:pass@127.0.0.1:12345' },
    { path: '/auth/token' }, { path: '/a/../b' }, { path: '/%61uth' }, { contentTypes: ['text/html'] },
    { maxBytes: 65537 }, { maxTotalBytes: 262145 }, { maxBytes: 0 }, { ttlMs: 30001 }, { extra: true },
  ]) { assert.throws(() => controller.reviewNetworkBody(JSON.stringify({ ...bodyRule(), ...mutation })), /BODY_RULE_INVALID/); }
  const first = controller.reviewNetworkBody(JSON.stringify(bodyRule()));
  const second = controller.reviewNetworkBody(JSON.stringify(bodyRule()));
  assert.notEqual(first.planHash, second.planHash);
  assert.equal(controller.confirmNetworkBody(first.planHash), false);
  assert.equal(controller.confirmNetworkBody(second.planHash), true);
  controller.cancelNetworkBody();
  assert.equal(controller.confirmNetworkBody(second.planHash), false);
  assert.equal(controller.networkBodyPreview(), undefined);
});
for (const [label, response] of [
  ['unknown content type', () => bodyResponse('excluded', 'text/html')],
  ['non UTF8 encoding', () => bodyResponse('excluded', 'text/plain;charset=gbk')],
  ['native object', () => ({ ...bodyResponse(), resultType: 1, result: { secret: 'excluded' } })],
  ['native buffer', () => ({ ...bodyResponse(), resultType: 2, result: new ArrayBuffer(8) })],
  ['redirected response', () => ({ ...bodyResponse(), connectionExtraInfo: { redirectCount: 1 } })],
  ['unknown redirect evidence', () => ({ ...bodyResponse(), connectionExtraInfo: undefined })],
  ['invalid JSON', () => bodyResponse('{invalid')],
  ['oversized UTF8', () => bodyResponse('中'.repeat(21846), 'text/plain')],
]) {
  test(`body capture refuses ${label} while returning the original response`, async (context) => {
    const value = response();
    const { controller } = await connectNetwork(context, { request: async () => value });
    approveBody(controller);
    assert.equal(await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary'), value);
    assert.equal(controller.networkBodyPreview(), undefined);
  });
}
test('body capture consumes raw byte quotas before redaction and keeps only the latest bounded preview', async (context) => {
  const response = bodyResponse('中', 'text/plain');
  const { controller } = await connectNetwork(context, { request: async () => response });
  approveBody(controller, { ...bodyRule(), maxBytes: 3, maxTotalBytes: 6 });
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(controller.networkBodyPreview().body, '[redacted]');
  assert.equal(controller.networkBodyPreview().capturedBytes, 3);
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(controller.networkBodyPreview().capturedBytes, 6);
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(controller.networkBodyPreview(), undefined, 'quota exhaustion clears previous body');
});
test('body capture never retains late native completions after cancellation or replacement', async (context) => {
  let finish;
  const { controller } = await connectNetwork(context, { request: () => new Promise((resolve) => { finish = resolve; }) });
  approveBody(controller);
  const pending = controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(typeof finish, 'function', 'native request actually started');
  controller.cancelNetworkBody();
  approveBody(controller);
  const response = bodyResponse();
  finish(response); assert.equal(await pending, response);
  assert.equal(controller.networkBodyPreview(), undefined);
});
for (const reason of ['USER_REVOKED', 'BACKGROUND', 'BUILD_CHANGED']) {
  test(`body capture clears the review and preview synchronously on ${reason}`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
    const review = approveBody(controller);
    await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
    assert(controller.networkBodyPreview());
    const closing = controller.stop(reason);
    assert.equal(controller.networkBodyPreview(), undefined);
    assert.equal(controller.state.networkBodyPlanHash, '');
    assert.equal(controller.confirmNetworkBody(review.planHash), false);
    await closing;
  });
}
test('body capture checks TTL without waiting for timers and never writes body in events or exports', async (context) => {
  const { controller, socket, accepted } = await connectNetwork(context, { request: async () => bodyResponse() });
  approveBody(controller, { ...bodyRule(), ttlMs: 1000 });
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  const preview = controller.networkBodyPreview();
  assert(preview);
  context.mock.timers.tick(1000); await settle();
  assert.equal(controller.networkBodyPreview(), undefined);
  assert.equal(controller.state.networkBodyPlanHash, '');
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent[2]));
  assert(!JSON.stringify(event).includes('private-label'));
  assert(!JSON.stringify(event).includes('redacted'));
  ackEvent(socket, accepted, event); await settle();
  context.mock.timers.tick(1000); await settle();
  accepted.channel.open(socket.sent[3]);
  approveBody(controller);
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert(controller.networkBodyPreview(), 'body is still present while preparing the summary-only export');
  controller.reviewExport();
  assert.equal(controller.state.exportPhase, 'review');
  const destination = path.join(temporary, 'body-excluded-summary.zip');
  globalThis.__kitTest.save = async () => [destination];
  await controller.confirmExport({});
  assert.equal(controller.state.exportPhase, 'saved');
  const content = await readFile(destination);
  verifyProblemPackage(content);
  for (const token of ['private-label', '"Token"', '"count":2', '[redacted]', bodyUrl]) {
    assert(!content.includes(Buffer.from(token)), 'No response body is part of a summary ZIP');
  }
});
for (const mutation of [{ method: 'POST' }, { header: { Authorization: 'excluded' } },
  { maxRedirects: 30 }, { queryParams: 'token=excluded' }]) {
  test(`body capture refuses request-option drift before a native completion: ${Object.keys(mutation)[0]}`, async (context) => {
    let finish;
    const { controller } = await connectNetwork(context, { request: () => new Promise((resolve) => { finish = resolve; }) });
    approveBody(controller);
    const options = bodyOptions();
    const pending = controller.requestNetwork(bodyUrl, options, 'ordinary');
    assert.equal(typeof finish, 'function');
    Object.assign(options, mutation);
    const response = bodyResponse();
    finish(response); assert.equal(await pending, response);
    assert.equal(controller.networkBodyPreview(), undefined);
  });
}
test('body capture never admits a request started before its specific confirmation', async (context) => {
  let finish;
  const { controller } = await connectNetwork(context, { request: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  approveBody(controller);
  const response = nativeRequest().response;
  finish(response); assert.equal(await pending, response);
  assert.equal(controller.networkBodyPreview(), undefined);
});
test('body capture revokes on backward clocks or expiry without timer dispatch', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  const review = approveBody(controller);
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  context.mock.timers.setTime(now - 1);
  assert.equal(controller.networkBodyPreview(), undefined);
  assert.equal(controller.state.networkBodyPreviewText, '');
  assert.equal(controller.confirmNetworkBody(review.planHash), false);
  context.mock.timers.setTime(now + 1);
  const next = approveBody(controller, { ...bodyRule(), ttlMs: 100 });
  context.mock.timers.setTime(now + 102);
  assert.equal(controller.confirmNetworkBody(next.planHash), false);
  assert.equal(controller.networkBodyPreview(), undefined);
  assert.equal(controller.state.networkBodyPlanHash, '');
});
test('body capture limits JSON structure, redacts large numbers, and refuses sensitive response status', async (context) => {
  let response = bodyResponse('{"value":13800138000,"count":2,"password":false}');
  const { controller } = await connectNetwork(context, { request: async () => response });
  approveBody(controller);
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(controller.networkBodyPreview().body, '{"value":"[redacted]","count":2,"password":"[redacted]"}');
  for (const raw of ['['.repeat(34) + '0' + ']'.repeat(34), JSON.stringify(new Array(257).fill(1)),
    '{"key space":"excluded"}', '"\\ud800"']) {
    response = bodyResponse(raw);
    await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
    assert.equal(controller.networkBodyPreview(), undefined);
  }
  for (const status of [302, 401, 402, 403]) {
    response = { ...bodyResponse(), responseCode: status };
    await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
    assert.equal(controller.networkBodyPreview(), undefined);
  }
});
test('body capture stops after 32 samples and does not reset its budget on repeated confirmation', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse('{}') });
  const review = approveBody(controller);
  for (let count = 1; count <= 32; count++) {
    await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
    assert.equal(controller.networkBodyPreview().capturedBytes, count * 2);
    assert.equal(controller.confirmNetworkBody(review.planHash), true);
  }
  await controller.requestNetwork(bodyUrl, bodyOptions(), 'ordinary');
  assert.equal(controller.networkBodyPreview(), undefined);
  assert.equal(controller.state.networkBodyPreviewText, '');
});
test('body capture retains the 256-review bound for the connection and never reuses old consent', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  let first;
  for (let count = 0; count < 256; count++) {
    const review = approveBody(controller);
    first ??= review;
    controller.cancelNetworkBody();
  }
  assert.throws(() => controller.reviewNetworkBody(JSON.stringify(bodyRule())), /BODY_CAPTURE_UNAVAILABLE/);
  assert.equal(controller.confirmNetworkBody(first.planHash), false);
  assert.equal(controller.state.networkBodyPlanHash, '');
});

const mockUrl = 'http://127.0.0.1:12345/ohmate-mock-sample';
const mockOptions = () => ({ method: 'GET', expectDataType: 0, maxLimit: 1024,
  header: { 'x-ohmate-scenario': 'local-demo' } });
const mockRules = () => ({ version: '1', targetId: 'network-main', rules: [{
  ruleId: 'local-demo', priority: 1, origin: 'http://127.0.0.1:12345', method: 'GET',
  path: '/ohmate-mock-sample', headers: { 'x-ohmate-scenario': 'local-demo' }, resourceType: 'fetch',
  response: { kind: 'fixed', status: 202, headers: { 'content-type': 'application/json' },
    body: '{"mockValue":"test-only-body"}', delayMs: 0 },
}] });
const mockSamples = () => [{ requestId: 'sample-1', targetId: 'network-main',
  origin: 'http://127.0.0.1:12345', method: 'GET', path: '/ohmate-mock-sample',
  headers: { 'x-ohmate-scenario': 'local-demo' }, resourceType: 'fetch', sensitivity: 'ordinary' }];
const templateRules = () => {
  const rules = mockRules();
  rules.rules[0].response = { kind: 'template', status: 202, headers: { 'content-type': 'text/plain' },
    template: 'mock {{test.value}} / {{test.value}}',
    variables: { 'test.value': '$& ${notExecuted()} {{test.ignored}}' }, delayMs: 0 };
  return rules;
};
test('ArkTS Mock templates match desktop hashes and stay inert, frozen and private', async (context) => {
  let calls = 0;
  const { controller, socket } = await connectNetwork(context, { request: async () => { calls++; return bodyResponse(); } });
  const rules = templateRules(), original = structuredClone(rules);
  const text = JSON.stringify(rules), samples = JSON.stringify(mockSamples());
  const review = controller.reviewNetworkMock(text, samples);
  const expected = 'mock $& ${notExecuted()} {{test.ignored}} / $& ${notExecuted()} {{test.ignored}}';
  assert.equal(review.payloadHash, createHash('sha256').update(canonicalJson(validateMockRules(rules))).digest('hex'));
  assert.equal(review.responses[0].bodyHash, createHash('sha256').update(canonicalJson(expected)).digest('hex'));
  assert.equal(review.responses[0].kind, 'template');
  rules.rules[0].response.variables['test.value'] = 'CALLER_MUTATION';
  assert.equal(controller.confirmNetworkMock(review.planHash), true);
  const result = await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch');
  assert.equal(result.result, expected);
  assert.equal(result.source, 'application-local-mock');
  assert.equal(calls, 0);
  for (const value of [review, controller.state, socket.sent, controller.networkMockStatus()]) {
    assert.equal(JSON.stringify(value).includes(original.rules[0].response.template), false);
    assert.equal(JSON.stringify(value).includes(expected), false);
    assert.equal(JSON.stringify(value).includes(original.rules[0].response.variables['test.value']), false);
  }
  const changed = controller.reviewNetworkMock(JSON.stringify(rules), samples);
  assert.notEqual(changed.payloadHash, review.payloadHash);
  assert.notEqual(changed.planHash, review.planHash);
  assert.equal(controller.confirmNetworkMock(review.planHash), false);
});
for (const change of [
  { template: '{{test.missing}}' }, { template: '{{request.headers}}' }, { template: '{{test.value}' },
  { template: 'value}}' }, { template: '{{{{test.value}}}}' },
  { variables: { 'test.value': 'x', 'test.unused': 'y' } }, { variables: { 'test.value': 1 } },
  { variables: { 'test.value': '\ud800' } }, { template: '\ud800' },
  { template: '字'.repeat(5500), variables: {} }, { variables: { 'test.value': '字'.repeat(700) } },
  { template: '{{test.value}}'.repeat(65) },
  { template: '{{test.value}}'.repeat(33), variables: { 'test.value': 'x'.repeat(2048) } },
  { body: 'EXTRA_BODY' }, { script: 'EXTRA_CODE' },
]) {
  test('ArkTS template rejects malformed or unbounded data ' + JSON.stringify(change).slice(0, 100), async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
    const rules = templateRules(); Object.assign(rules.rules[0].response, change);
    assert.throws(() => validateMockRules(rules));
    assert.throws(() => controller.reviewNetworkMock(JSON.stringify(rules), JSON.stringify(mockSamples())), /MOCK_RULE_INVALID/);
    assert.equal(controller.networkMockStatus().phase, 'idle');
  });
}
test('ArkTS template rendering observes maxLimit and cancellation without native fallback', async (context) => {
  let calls = 0;
  const { controller } = await connectNetwork(context, { request: async () => { calls++; return bodyResponse(); } });
  const rules = templateRules(), response = rules.rules[0].response;
  response.template = '{{test.value}}'.repeat(32); response.variables['test.value'] = 'x'.repeat(2048);
  approveMock(controller, rules);
  await assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), /MOCK_RESPONSE_QUOTA/);
  assert.equal(calls, 0);
  const delayed = templateRules(); delayed.rules[0].response.delayMs = 25;
  approveMock(controller, delayed);
  const pending = controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch');
  assert.equal(controller.networkMockStatus().pending, 1);
  controller.cancelNetworkMock();
  await assert.rejects(pending, /MOCK_CANCELLED/);
  assert.equal(controller.networkMockStatus().pending, 0);
  assert.equal(calls, 0);
});
test('ArkTS templates reject cumulative expanded bodies and bind exact empty HEAD output', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  const rules = templateRules(), response = rules.rules[0].response;
  response.template = '{{test.value}}'.repeat(32); response.variables['test.value'] = 'x'.repeat(2048);
  rules.rules = Array.from({ length: 5 }, (_, i) => ({ ...rules.rules[0], ruleId: 'r-' + i }));
  assert.throws(() => validateMockRules(rules));
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(rules), '[]'), /MOCK_RULE_INVALID/);
  const head = templateRules(); head.rules[0].method = 'HEAD';
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(head), '[]'), /MOCK_RULE_INVALID/);
  head.rules[0].response.template = '{{test.value}}'; head.rules[0].response.variables['test.value'] = '';
  const review = controller.reviewNetworkMock(JSON.stringify(head), '[]');
  assert.equal(review.responses[0].bodyHash, createHash('sha256').update(canonicalJson('')).digest('hex'));
});
test('page Mock review uses an explicit template and validates its exact result before success', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  pageProducer = controller;
  globalThis.NavPathStack = class {};
  context.after(() => { pageProducer = undefined; delete globalThis.NavPathStack; });
  const page = new ProducerPage();
  let input;
  const realReview = controller.reviewNetworkMock.bind(controller);
  controller.reviewNetworkMock = (text, samples) => { input = JSON.parse(text); return realReview(text, samples); };
  page.reviewMock();
  assert.equal(input.rules[0].response.kind, 'template');
  assert.equal(input.rules[0].response.template, '{"scenario":"{{test.scenario}}"}');
  assert.deepEqual(input.rules[0].response.variables, { 'test.scenario': 'ohmate-local-demo' });
  page.confirmMock();
  controller.requestNetwork = async () => ({ mock: true, source: 'application-local-mock', ruleId: 'local-demo',
    responseCode: 202, result: '{"scenario":"WRONG"}', resultType: 0 });
  await page.probeMock();
  assert.equal(page.mockResult, 'failed');
  assert.equal(JSON.stringify(page).includes('WRONG'), false);
  page.networkPhase = 'idle';
  controller.requestNetwork = async () => ({ mock: true, source: 'application-local-mock', ruleId: 'local-demo',
    responseCode: 202, result: '{"scenario":"ohmate-local-demo"}', resultType: 0 });
  await page.probeMock();
  assert.equal(page.mockResult, 'completed');
});
function approveMock(controller, rules = mockRules(), samples = mockSamples(), ttlMs = 30000) {
  const review = controller.reviewNetworkMock(JSON.stringify(rules), JSON.stringify(samples), ttlMs);
  assert.equal(review.scope, 'network.mock');
  assert.match(review.planHash, /^[a-f0-9]{64}$/);
  assert.equal(controller.confirmNetworkMock(review.planHash), true);
  return review;
}
test('ArkTS Mock requires independent scope confirmation and binds the shared rule contract', async (context) => {
  let calls = 0;
  const native = bodyResponse();
  const { controller } = await connectNetwork(context, { request: async () => { calls++; return native; } });
  assert.equal(controller.networkMockStatus().phase, 'idle');
  assert.equal(await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), native);
  const rules = mockRules(), review = controller.reviewNetworkMock(JSON.stringify(rules), JSON.stringify(mockSamples()));
  assert.equal(review.payloadHash, createHash('sha256').update(canonicalJson(validateMockRules(rules))).digest('hex'));
  assert.deepEqual(review.matches, [{ requestId: 'sample-1', ruleId: 'local-demo', decision: 'mock', reason: null }]);
  assert.equal(await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), native);
  assert.equal(controller.confirmNetworkMock('0'.repeat(64)), false);
  assert.equal(controller.confirmNetworkMock(review.planHash), true);
  const response = await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch');
  assert.equal(calls, 2);
  assert.equal(response.responseCode, 202);
  assert.equal(response.result, rules.rules[0].response.body);
  assert.equal(response.resultType, 0);
  assert.equal(response.cookies, '');
  assert.equal(response.mock, true);
  assert.equal(response.source, 'application-local-mock');
  assert.equal(response.ruleId, 'local-demo');
  assert.ok(Object.values(response.performanceTiming).every(Number.isNaN), 'Mock has no native timing measurement');
  response.header['content-type'] = 'mutated';
  const again = await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch');
  assert.equal(again.header['content-type'], 'application/json');
  assert.equal(controller.networkMockStatus().hits, 2);
  assert.equal(controller.confirmNetworkMock(review.planHash), true);
  assert.equal(controller.networkMockStatus().hits, 2);
  assert.equal(controller.networkMockStatus().authentication, 'not-authenticated');
});
test('ArkTS Mock dry-run uses stable priority order and blocks sensitive samples', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  const rules = mockRules();
  rules.rules.push({ ...structuredClone(rules.rules[0]), ruleId: 'priority-first', priority: 2 });
  rules.rules.push({ ...structuredClone(rules.rules[0]), ruleId: 'priority-tie', priority: 2 });
  const samples = mockSamples();
  samples.push({ ...samples[0], requestId: 'unknown', sensitivity: 'unknown' },
    { ...samples[0], requestId: 'other-path', path: '/other' });
  const review = controller.reviewNetworkMock(JSON.stringify(rules), JSON.stringify(samples));
  assert.deepEqual(review.matches, [
    { requestId: 'sample-1', ruleId: 'priority-first', decision: 'mock', reason: null },
    { requestId: 'unknown', ruleId: null, decision: 'blocked', reason: 'SENSITIVE_REQUEST' },
    { requestId: 'other-path', ruleId: null, decision: 'passthrough', reason: null },
  ]);
  review.matches[0].ruleId = 'mutated';
  assert.equal(controller.confirmNetworkMock(review.planHash), true);
  assert.equal((await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch')).ruleId, 'priority-first');
});
for (const [name, mutate] of [
  ['unknown field', (r) => { r.extra = 'excluded'; }],
  ['wrong target', (r) => { r.targetId = 'other'; }],
  ['duplicate rule', (r) => { r.rules.push(structuredClone(r.rules[0])); }],
  ['query path', (r) => { r.rules[0].path += '?token=excluded'; }],
  ['sensitive path', (r) => { r.rules[0].path = '/login'; }],
  ['mutating method', (r) => { r.rules[0].method = 'POST'; }],
  ['wildcard origin', (r) => { r.rules[0].origin = 'http://*.invalid'; }],
  ['cookie response', (r) => { r.rules[0].response.headers['set-cookie'] = 'excluded'; }],
  ['Authorization match', (r) => { r.rules[0].headers.authorization = 'excluded'; }],
  ['oversize body', (r) => { r.rules[0].response.body = '界'.repeat(22000); }],
  ['HEAD body', (r) => { r.rules[0].method = 'HEAD'; }],
  ['unsupported response', (r) => { r.rules[0].response.kind = 'template'; }],
  ['lone surrogate', (r) => { r.rules[0].response.body = '\ud800'; }],
  ['delay bound', (r) => { r.rules[0].response.delayMs = 3001; }],
]) {
  test(`ArkTS Mock rejects ${name} before confirmation and leaves no raw receipt`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
    const rules = mockRules(); mutate(rules);
    assert.throws(() => controller.reviewNetworkMock(JSON.stringify(rules), JSON.stringify(mockSamples())), /MOCK_RULE_INVALID/);
    assert.equal(controller.networkMockStatus().phase, 'idle');
    assert.ok(!JSON.stringify(controller.state).includes('test-only-body'));
  });
}
for (const [name, requestUrl, options, classification, resourceType] of [
  ['unknown classification', mockUrl, mockOptions(), 'unknown', 'fetch'],
  ['payment', mockUrl, mockOptions(), 'payment', 'fetch'],
  ['wrong origin', mockUrl.replace(':12345', ':12346'), mockOptions(), 'ordinary', 'fetch'],
  ['query', mockUrl + '?token=excluded', mockOptions(), 'ordinary', 'fetch'],
  ['wrong header value', mockUrl, { ...mockOptions(), header: { 'x-ohmate-scenario': 'other' } }, 'ordinary', 'fetch'],
  ['credential header', mockUrl, { ...mockOptions(), header: { Authorization: 'excluded' } }, 'ordinary', 'fetch'],
  ['queryParams', mockUrl, { ...mockOptions(), queryParams: 'token=excluded' }, 'ordinary', 'fetch'],
  ['body', mockUrl, { ...mockOptions(), body: 'excluded' }, 'ordinary', 'fetch'],
  ['extraData', mockUrl, { ...mockOptions(), extraData: 'excluded' }, 'ordinary', 'fetch'],
  ['custom method', mockUrl, { ...mockOptions(), customMethod: 'GET' }, 'ordinary', 'fetch'],
  ['upload', mockUrl, { ...mockOptions(), multiFormDataList: [] }, 'ordinary', 'fetch'],
  ['client certificate', mockUrl, { ...mockOptions(), clientCert: {} }, 'ordinary', 'fetch'],
  ['binary output', mockUrl, { ...mockOptions(), expectDataType: 2 }, 'ordinary', 'fetch'],
  ['unknown resource', mockUrl, mockOptions(), 'ordinary', 'unknown'],
  ['WebSocket', mockUrl, mockOptions(), 'ordinary', 'websocket'],
]) {
  test(`ArkTS Mock ${name} passes the original request and response through`, async (context) => {
    let calls = 0;
    const native = bodyResponse();
    const { controller } = await connectNetwork(context, { request: async (u, o) => {
      calls++; assert.equal(u, requestUrl); assert.equal(o, options); return native;
    } });
    approveMock(controller);
    assert.equal(await controller.requestNetwork(requestUrl, options, classification, resourceType), native);
    assert.equal(calls, 1);
    assert.equal(controller.networkMockStatus().hits, 0);
  });
}
test('ArkTS Mock preserves the original passthrough error and host destroy ownership', async (context) => {
  const failure = new Error('private-business-error');
  let destroyed = false;
  const { controller } = await connectNetwork(context, {
    request: async () => { throw failure; }, destroy: () => { destroyed = true; },
  });
  approveMock(controller);
  await assert.rejects(controller.requestNetwork(mockUrl, mockOptions()), (error) => error === failure);
  await controller.stop();
  assert.equal(destroyed, false);
});
for (const kind of ['timeout', 'network-error']) {
  test(`ArkTS Mock ${kind} delays only the synthetic failure without native fallback`, async (context) => {
    let calls = 0;
    const { controller } = await connectNetwork(context, { request: async () => { calls++; return bodyResponse(); } });
    const rules = mockRules();
    rules.rules[0].response = { kind, delayMs: 50 };
    approveMock(controller, rules);
    const pending = assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'),
      new RegExp(kind === 'timeout' ? 'MOCK_TIMEOUT' : 'MOCK_NETWORK_ERROR'));
    await settle();
    assert.equal(controller.networkMockStatus().pending, 1);
    context.mock.timers.tick(50); await pending;
    assert.equal(calls, 0);
    assert.equal(controller.networkMockStatus().pending, 0);
  });
}
for (const action of ['cancel', 'background', 'new-review', 'expiry', 'clock-rollback']) {
  test(`ArkTS Mock ${action} invalidates pending delays before completion`, async (context) => {
    let calls = 0;
    const { controller } = await connectNetwork(context, { request: async () => { calls++; return bodyResponse(); } });
    const rules = mockRules(); rules.rules[0].response.delayMs = 3000;
    const review = approveMock(controller, rules);
    const pending = assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), /MOCK_CANCELLED/);
    await settle();
    if (action === 'cancel') { controller.cancelNetworkMock(); }
    if (action === 'background') { await controller.stop('APP_BACKGROUND'); }
    if (action === 'new-review') { controller.reviewNetworkMock(JSON.stringify(mockRules()), JSON.stringify(mockSamples())); }
    if (action === 'expiry') { context.mock.timers.setTime(now + 30001); controller.networkMockStatus(); }
    if (action === 'clock-rollback') { context.mock.timers.setTime(now - 1); controller.networkMockStatus(); }
    await pending;
    assert.equal(controller.confirmNetworkMock(review.planHash), false);
    assert.equal(calls, 0);
    assert.equal(controller.networkMockStatus().pending, 0);
    assert.equal(controller.state.networkMockHits, 0);
  });
}
test('ArkTS Mock obeys host body size limits and does not emit platform summaries or body previews', async (context) => {
  let calls = 0;
  const { controller, socket } = await connectNetwork(context, { request: async () => { calls++; return bodyResponse(); } });
  approveMock(controller);
  approveBody(controller, { ...bodyRule(), path: '/ohmate-mock-sample' });
  await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch');
  assert.equal(controller.networkBodyPreview(), undefined);
  assert.equal(controller.networkFile(), undefined);
  assert.equal(socket.sent.length, 2, 'Synthetic Mock data must not produce network frames');
  await assert.rejects(controller.requestNetwork(mockUrl, { ...mockOptions(), maxLimit: 1 }, 'ordinary', 'fetch'), /MOCK_RESPONSE_QUOTA/);
  assert.equal(calls, 0, 'A selected but oversize Mock must not leak into a real request');
  context.mock.timers.tick(1000); await settle();
  controller.reviewExport();
  const target = path.join(temporary, 'mock-excluded.ohmate-problem.zip');
  globalThis.__kitTest.save = async () => [target];
  await controller.confirmExport({});
  const bytes = await readFile(target);
  for (const text of ['test-only-body', 'local-demo', 'ohmate-mock-sample']) {
    assert.equal(bytes.includes(Buffer.from(text)), false);
  }
});
test('ArkTS Mock bounds concurrent delays, cancels all of them, and retains the review tombstone quota', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => { throw Error('must not call native'); } });
  const rules = mockRules(); rules.rules[0].response.delayMs = 3000;
  const first = approveMock(controller, rules);
  const pending = Array.from({ length: 8 }, () =>
    assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), /MOCK_CANCELLED/));
  await settle();
  assert.equal(controller.networkMockStatus().pending, 8);
  await assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), /MOCK_PENDING_QUOTA/);
  controller.cancelNetworkMock();
  await Promise.all(pending);
  for (let count = 1; count < 256; count++) {
    approveMock(controller); controller.cancelNetworkMock();
  }
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(mockRules()), JSON.stringify(mockSamples())), /MOCK_UNAVAILABLE/);
  assert.equal(controller.confirmNetworkMock(first.planHash), false);
});
for (const [name, mutate] of [
  ['null response headers', (r) => { r.rules[0].response.headers = null; }],
  ['surrogate match header', (r) => { r.rules[0].headers.accept = '\ud800'; }],
  ['surrogate response header', (r) => { r.rules[0].response.headers['content-language'] = '\ud800'; }],
  ['surrogate path', (r) => { r.rules[0].path = '/\ud800'; }],
  ['33 rules', (r) => { r.rules = Array.from({ length: 33 }, (_, i) => ({ ...r.rules[0], ruleId: `r-${i}` })); }],
]) {
  test(`ArkTS Mock boundary rejects ${name}`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
    const rules = mockRules(); mutate(rules);
    assert.throws(() => controller.reviewNetworkMock(JSON.stringify(rules), JSON.stringify(mockSamples())), /MOCK_RULE_INVALID/);
    assert.equal(controller.networkMockStatus().phase, 'idle');
  });
}
for (const [name, mutate] of [
  ['duplicate samples', (s) => { s.push(s[0]); }],
  ['129 samples', (s) => { for (let i = 1; i < 129; i++) { s.push({ ...s[0], requestId: `s-${i}` }); } }],
  ['surrogate sample header', (s) => { s[0].headers.accept = '\ud800'; }],
  ['sample extra field', (s) => { s[0].body = 'excluded'; }],
]) {
  test(`ArkTS Mock boundary rejects ${name}`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
    const samples = mockSamples(); mutate(samples);
    assert.throws(() => controller.reviewNetworkMock(JSON.stringify(mockRules()), JSON.stringify(samples)), /MOCK_RULE_INVALID/);
  });
}
for (const method of ['HEAD', 'OPTIONS']) {
  test(`ArkTS Mock boundary supports explicit ${method} without native timing`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => { throw Error('unexpected native'); } });
    const rules = mockRules(); rules.rules[0].method = method; rules.rules[0].response.body = '';
    const samples = mockSamples(); samples[0].method = method;
    approveMock(controller, rules, samples);
    const response = await controller.requestNetwork(mockUrl, { ...mockOptions(), method }, 'ordinary', 'fetch');
    assert.equal(response.result, ''); assert.equal(response.mock, true);
    assert.equal(Object.keys(response.performanceTiming).length, 10);
  });
}
for (const ttlMs of [0, -1, 600001, 1.5]) {
  test(`ArkTS Mock boundary rejects invalid TTL ${ttlMs}`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
    assert.throws(() => approveMock(controller, mockRules(), mockSamples(), ttlMs), /MOCK_RULE_INVALID/);
  });
}
for (const [name, mutate] of [
  ['body added', (o) => { o.body = 'excluded'; }],
  ['certificate added', (o) => { o.clientEncCert = {}; }],
  ['output type changed', (o) => { o.expectDataType = 2; }],
  ['limit changed', (o) => { o.maxLimit = 2048; }],
  ['unused match header changed', (o) => { o.header.accept = 'text/plain'; }],
]) {
  test(`ArkTS Mock boundary cancels delay when ${name}`, async (context) => {
    const { controller } = await connectNetwork(context, { request: async () => { throw Error('unexpected native'); } });
    const rules = mockRules(); rules.rules[0].response.delayMs = 50;
    approveMock(controller, rules);
    const options = mockOptions();
    const pending = assert.rejects(controller.requestNetwork(mockUrl, options, 'ordinary', 'fetch'), /MOCK_CANCELLED/);
    await settle(); mutate(options); context.mock.timers.tick(50); await pending;
    assert.equal(controller.networkMockStatus().pending, 0);
  });
}
test('ArkTS Mock boundary never reads default or credential header values', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  const options = mockOptions();
  Object.defineProperty(options, 'header', { get: () => { throw Error('must not read default headers'); } });
  await controller.requestNetwork(mockUrl, options, 'ordinary', 'fetch');
  approveMock(controller);
  const headers = {};
  Object.defineProperty(headers, 'Authorization', { enumerable: true, get: () => { throw Error('must not read credentials'); } });
  await controller.requestNetwork(mockUrl, { ...mockOptions(), header: headers }, 'ordinary', 'fetch');
  assert.equal(controller.networkMockStatus().hits, 0);
});
test('ArkTS Mock boundary caps hits without restoring an original native request', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => { throw Error('unexpected native'); } });
  const review = approveMock(controller);
  for (let i = 0; i < 128; i++) {
    assert.equal((await controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch')).mock, true);
  }
  assert.equal(controller.confirmNetworkMock(review.planHash), true);
  await assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), /MOCK_HIT_QUOTA/);
  assert.equal(controller.networkMockStatus().hits, 128);
});
test('ArkTS Mock boundary binds raw rule and sample hashes, revision and fixed expiry', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  const rules = JSON.stringify(mockRules()), samples = JSON.stringify(mockSamples());
  const first = controller.reviewNetworkMock(rules, samples);
  const second = controller.reviewNetworkMock(rules + ' ', samples);
  assert.equal(first.payloadHash, second.payloadHash); assert.notEqual(first.planHash, second.planHash);
  assert.equal(controller.confirmNetworkMock(first.planHash), false);
  const third = controller.reviewNetworkMock(rules, samples + ' ');
  assert.equal(second.samplesHash, third.samplesHash); assert.notEqual(second.planHash, third.planHash);
  assert.equal(controller.confirmNetworkMock(third.planHash), true);
  context.mock.timers.setTime(now + 29000);
  assert.equal(controller.confirmNetworkMock(third.planHash), true);
  context.mock.timers.setTime(now + 30000);
  assert.equal(controller.confirmNetworkMock(third.planHash), false);
  assert.equal(controller.networkMockStatus().phase, 'idle');
});
test('ArkTS Mock quota checks UTF-8 byte budgets for rules and supplied samples', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  const rules = mockRules();
  rules.rules = Array.from({ length: 32 }, (_, i) => ({ ...structuredClone(rules.rules[0]),
    ruleId: `r-${i}`, response: { ...rules.rules[0].response, body: '界'.repeat(2800) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(rules)) > 262144);
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(rules), '[]'), /MOCK_RULE_INVALID/);
  const samples = Array.from({ length: 128 }, (_, i) => ({ ...mockSamples()[0], requestId: `s-${i}`,
    headers: { accept: '界'.repeat(256), 'content-type': '界'.repeat(256), 'x-ohmate-scenario': '界'.repeat(256) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(samples)) > 262144);
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(mockRules()), JSON.stringify(samples)), /MOCK_RULE_INVALID/);
  for (const [rulesText, samplesText] of [
    [JSON.stringify(mockRules()) + ' '.repeat(262144), '[]'],
    [JSON.stringify(mockRules()), '[]' + ' '.repeat(262144)],
  ]) {
    assert.throws(() => controller.reviewNetworkMock(rulesText, samplesText), /MOCK_RULE_INVALID/);
  }
});
test('ArkTS Mock quota accepts a 64 KiB body and rejects one additional byte', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => { throw Error('unexpected native'); } });
  const rules = mockRules(); rules.rules[0].response.body = 'x'.repeat(65536);
  approveMock(controller, rules);
  const response = await controller.requestNetwork(mockUrl, { ...mockOptions(), maxLimit: 65536 }, 'ordinary', 'fetch');
  assert.equal(Buffer.byteLength(response.result), 65536);
  rules.rules[0].response.body += 'x';
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(rules), '[]'), /MOCK_RULE_INVALID/);
});
test('ArkTS Mock quota invalidates pending responses when a replacement review is malformed', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => { throw Error('unexpected native'); } });
  const rules = mockRules(); rules.rules[0].response.delayMs = 3000;
  const review = approveMock(controller, rules);
  const pending = assert.rejects(controller.requestNetwork(mockUrl, mockOptions(), 'ordinary', 'fetch'), /MOCK_CANCELLED/);
  await settle();
  assert.throws(() => controller.reviewNetworkMock('{', '[]'), /MOCK_RULE_INVALID/);
  await pending; assert.equal(controller.confirmNetworkMock(review.planHash), false);
});
test('ArkTS Mock quota binds the connection deadline even with a ten-minute requested TTL', async (context) => {
  const { controller, epoch } = await connectNetwork(context, { request: async () => bodyResponse() });
  controller.session.limits.expiresAt = now + 1000;
  const review = approveMock(controller, mockRules(), mockSamples(), 600000);
  assert.equal(review.expiresAt, now + 1000);
  controller.epoch = epoch + '-changed';
  assert.equal(controller.confirmNetworkMock(review.planHash), false);
  assert.equal(controller.networkMockStatus().phase, 'idle');
});
test('ArkTS Mock quota retains failed review attempts and cannot renew the registration owner', async (context) => {
  const { controller } = await connectNetwork(context, { request: async () => bodyResponse() });
  for (let i = 0; i < 256; i++) {
    assert.throws(() => controller.reviewNetworkMock('{', '[]'), /MOCK_RULE_INVALID/);
  }
  assert.throws(() => controller.reviewNetworkMock(JSON.stringify(mockRules()), '[]'), /MOCK_UNAVAILABLE/);
});
test('ArkTS Mock does not inspect headers of an ordinary-classified sensitive path', async (context) => {
  let headerReads = 0;
  const native = bodyResponse();
  const { controller } = await connectNetwork(context, { request: async () => native });
  approveMock(controller);
  const options = mockOptions();
  Object.defineProperty(options, 'header', { get: () => { headerReads++; return { accept: 'excluded' }; } });
  assert.equal(await controller.requestNetwork('http://127.0.0.1:12345/login', options, 'ordinary', 'fetch'), native);
  assert.equal(headerReads, 0);
  assert.equal(controller.networkMockStatus().hits, 0);
});

const resourceUrl = 'http://127.0.0.1:12345/kit-readonly.css';
function resourceEntry() {
  return { url: resourceUrl, mimeType: 'text/css', body: '/* ohmate-local-resource */', sensitivity: 'ordinary' };
}
function resourceFileFixture() {
  const bytes = Buffer.from('/* ohmate-local-file */\n');
  const calls = []; let position = 0; let closeFails = false;
  const manager = {
    getRawFdSync(name) { calls.push(['open', name]); return { fd: 7, offset: 0, length: bytes.length }; },
    closeRawFdSync(name) { calls.push(['close', name]); if (closeFails) throw Error('private-native-error'); },
  };
  const fileIo = {
    WhenceType: { SEEK_SET: 0 },
    lseek(_fd, offset) { position = offset; return offset; },
    readSync(_fd, buffer, options) {
      const count = Math.min(options.length, bytes.length - position);
      new Uint8Array(buffer).set(bytes.subarray(position, position + count)); position += count; return count;
    },
  };
  const entry = { url: resourceUrl, mimeType: 'text/css', sensitivity: 'ordinary',
    name: 'ohmate-resources/readonly.css', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  return { bytes, calls, manager, fileIo, entry, closeFails: (value) => { closeFails = value; } };
}
test('ArkTS resource files Controller registers verified text and exposes only resource metadata', async (context) => {
  const f = resourceFileFixture(); const source = nativeWeb();
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    globalThis.__kitTest.fileIo = f.fileIo;
    controller.registerWebFiles(source.controller, 'web-main', controlledWebUrl, f.manager, [f.entry]);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  assert.equal(fixture.controller.webResourceCatalog()[0].bodyHash, f.entry.sha256);
  assert.equal(fixture.controller.webResourceFilesPending(), false);
  assert.equal(JSON.stringify(fixture.controller.webResourceCatalog()).includes(f.entry.name), false);
  assert.deepEqual(f.calls, [['open', f.entry.name], ['close', f.entry.name]]);
  approveResource(fixture.controller);
  globalThis.WebResourceResponse = TestWebResponse;
  context.after(() => { delete globalThis.WebResourceResponse; });
  assert.equal(fixture.controller.interceptWebResource(resourceRequest()).body, f.bytes.toString('utf8'));
});
test('ArkTS resource files Controller keeps failed descriptor close across background and blocks pairing', async (context) => {
  const f = resourceFileFixture(); f.closeFails(true);
  const fixture = controllerFixture(context); const owner = fixture.controller;
  owner.review(fixture.text); globalThis.__kitTest.fileIo = f.fileIo;
  assert.throws(() => owner.registerWebFiles(nativeWeb().controller, 'web-main',
    controlledWebUrl, f.manager, [f.entry]), /RESOURCE_FILE_CLOSE_REQUIRED/);
  assert.equal(owner.webResourceFilesPending(), true);
  assert.throws(() => owner.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl),
    /RESOURCE_FILE_CLOSE_REQUIRED/);
  assert.throws(() => owner.review('{}'), /RESOURCE_FILE_CLOSE_REQUIRED/);
  let sockets = 0; globalThis.__kitTest.socketFactory = () => { sockets++; return fixture.socket; };
  await owner.confirm();
  assert.equal(sockets, 0);
  await owner.stop('BACKGROUND');
  assert.equal(owner.state.phase, 'cleanup-failed');
  assert.equal(owner.state.reason, 'RESOURCE_FILE_CLOSE_REQUIRED');
  assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
  f.closeFails(false); await owner.stop();
  assert.equal(owner.webResourceFilesPending(), false);
  assert.equal(owner.state.phase, 'stopped');
  assert.equal(f.calls.filter(([name]) => name === 'close').length, 2);
});
test('ArkTS resource files Controller refuses acquisition during an active connection before native reads', async (context) => {
  const fixture = await connectResource(context); const f = resourceFileFixture();
  assert.throws(() => fixture.controller.registerWebFiles(nativeWeb().controller, 'web-main',
    controlledWebUrl, f.manager, [f.entry]), /INVALID_STATE/);
  assert.deepEqual(f.calls, []);
});
for (const failed of [false, true]) {
  test(`ArkTS resource files page prepares packaged hash manifest and closes on failure ${failed}`, async (context) => {
    const manager = {}; const calls = [];
    pageProducer = {
      state: { connectionTarget: 'ws://127.0.0.1:12345/bridge/v1' },
      registerNetwork() {}, registerUi() {}, registerReplay() {}, review() {},
      registerWeb() { throw Error('memory fallback forbidden'); },
      registerWebFiles(_web, target, source, actualManager, entries, consoleAllowed, storageAccess, schemeOwned) {
        calls.push(['files']);
        assert.equal(target, 'web-main'); assert.equal(source, controlledWebUrl); assert.equal(actualManager, manager);
        assert.equal(consoleAllowed, true); assert.equal(storageAccess.enabled(), false);
        assert.equal(schemeOwned, true);
        assert.deepEqual(entries, [{ url: resourceUrl, mimeType: 'text/css', sensitivity: 'ordinary',
          name: 'ohmate-resources/readonly.css', bytes: 28,
          sha256: '437faf21ac9c64146bfdcd9c8950ebc585b6da21b074f9664620bbe357aa2142' }]);
        if (failed) throw Error('RESOURCE_FILE_CLOSE_REQUIRED');
      },
      async stop(reason) { calls.push(['stop', reason]); },
    };
    globalThis.NavPathStack = class {};
    context.after(() => { pageProducer = undefined; delete globalThis.NavPathStack; delete globalThis.__kitTest.createHttp; });
    globalThis.__kitTest.createHttp = () => ({ destroy() {} });
    const page = new ProducerPage();
    page.getUIContext = () => ({ getHostContext: () => ({ resourceManager: manager }) });
    page.invitationText = 'private-test-invitation';
    page.prepare(); await settle();
    assert.deepEqual(calls, failed ? [['files'], ['stop', 'RESOURCE_PREPARE_FAILED']] : [['files']]);
    assert.equal(page.resourceFailed, failed);
    assert.equal(page.invitationText, '');
  });
}
function resourceControllerStream() {
  let scheme; let clearFails = false; let clears = 0;
  globalThis.__kitTest.resourceStreamWebview = {
    WebSchemeHandler: class {
      constructor() { scheme = this; }
      onRequestStart(callback) { this.start = callback; }
      onRequestStop(callback) { this.stop = callback; }
    },
    WebSchemeHandlerResponse: class {
      setUrl() {} setStatus() {} setStatusText() {} setMimeType() {} setEncoding() {} setHeaderByName() {}
    },
  };
  const source = nativeWeb();
  source.controller.setWebSchemeHandler = (name) => assert.equal(name, 'http');
  source.controller.clearWebSchemeHandler = () => { clears++; if (clearFails) throw Error('private-clear'); };
  const request = {
    getRequestUrl: () => resourceUrl, getRequestMethod: () => 'GET', isMainFrame: () => false,
    getFrameUrl: () => controlledWebUrl, getReferrer: () => '', getHttpBodyStream: () => null,
    getRequestResourceType: () => 13, getHeader: () => [{ headerKey: 'Accept' }],
  };
  return { source, request, scheme: () => scheme, clearFails: (value) => { clearFails = value; }, clears: () => clears };
}
test('ArkTS resource stream Controller cancels on navigation and keeps exact request owner across stop', async (context) => {
  const f = resourceControllerStream();
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(f.source.controller, 'web-main', controlledWebUrl, [resourceEntry()], false, undefined, true);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  const controller = fixture.controller;
  assert.equal(controller.attachWebResourceStream(), true); approveResource(controller);
  let chunks = 0; let fails = 0;
  const handler = { didReceiveResponse() {}, didReceiveResponseBody() { chunks++; },
    didFinish() {}, didFail() { fails++; } };
  assert.equal(f.scheme().start(f.request, handler), true);
  assert.throws(() => controller.reviewWebResource(JSON.stringify(resourceRule(controller)), '[]'),
    /RESOURCE_STREAM_CLOSE_REQUIRED/);
  controller.webPageBegin(controlledWebUrl);
  await settle(); assert.equal(chunks, 0); assert.equal(fails, 1);
  await controller.stop('BACKGROUND');
  assert.equal(controller.state.phase, 'cleanup-failed');
  assert.equal(controller.state.reason, 'RESOURCE_STREAM_CLOSE_REQUIRED');
  assert.equal(controller.webResourceStreamPending(), true);
  assert.throws(() => controller.review(fixture.text), /RESOURCE_STREAM_CLOSE_REQUIRED/);
  assert.throws(() => controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl),
    /RESOURCE_STREAM_CLOSE_REQUIRED/);
  f.scheme().stop(f.request);
  await controller.stop();
  assert.equal(controller.state.phase, 'stopped'); assert.equal(controller.webResourceStreamPending(), false);
  assert.equal(f.clears(), 1);
});
test('ArkTS resource stream Controller retains failed clear and retries on explicit stop', async (context) => {
  const f = resourceControllerStream();
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(f.source.controller, 'web-main', controlledWebUrl, [resourceEntry()], false, undefined, true);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  assert.equal(fixture.controller.attachWebResourceStream(), true);
  f.clearFails(true); await fixture.controller.stop('BACKGROUND');
  assert.equal(fixture.controller.state.phase, 'cleanup-failed');
  assert.equal(fixture.controller.webResourceStreamPending(), true);
  await fixture.controller.stop('BACKGROUND'); assert.equal(f.clears(), 1);
  f.clearFails(false); await fixture.controller.stop();
  assert.equal(fixture.controller.state.phase, 'stopped'); assert.equal(f.clears(), 2);
});
async function connectResource(context, entries = [resourceEntry()]) {
  const source = nativeWeb();
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(source.controller, 'web-main', controlledWebUrl, entries);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  return { ...fixture, source };
}
function resourceRule(controller) {
  const entry = controller.webResourceCatalog()[0];
  return { version: '1', targetId: 'web-main', resourceId: entry.resourceId, url: entry.url, method: 'GET' };
}
function resourceSamples() {
  return [{ requestId: 'sample-1', url: resourceUrl, method: 'GET', mainFrame: false, redirect: false }];
}
function approveResource(controller, rule = resourceRule(controller), samples = resourceSamples(), ttlMs = 30000) {
  const review = controller.reviewWebResource(JSON.stringify(rule), JSON.stringify(samples), ttlMs);
  assert.equal(controller.confirmWebResource(review.planHash), true);
  return review;
}
function resourceRequest(overrides = {}) {
  return { getRequestUrl: () => resourceUrl, getRequestMethod: () => 'GET', isMainFrame: () => false,
    isRedirect: () => false, getRequestHeader: () => [{ headerKey: 'Accept',
      get headerValue() { throw Error('request header values must remain unread'); } }], ...overrides };
}
class TestWebResponse {
  setResponseData(value) { this.body = value; }
  setResponseEncoding(value) { this.encoding = value; }
  setResponseMimeType(value) { this.mime = value; }
  setResponseCode(value) { this.status = value; }
  setReasonMessage(value) { this.reason = value; }
  setResponseHeader(value) { this.headers = value; }
  setResponseIsReady(value) { this.ready = value; }
}
test('ArkTS resource override defaults to original callback without inspecting the request', async (context) => {
  const { controller } = await connectResource(context, []);
  const original = { native: true }; let calls = 0;
  assert.equal(controller.interceptWebResource({}, () => { calls++; return original; }), original);
  assert.equal(calls, 1); assert.deepEqual(controller.webResourceCatalog(), []);
});
test('ArkTS resource override reviews bounded metadata and returns a complete native response only after confirmation', async (context) => {
  globalThis.WebResourceResponse = TestWebResponse;
  context.after(() => { delete globalThis.WebResourceResponse; });
  const { controller } = await connectResource(context);
  const catalog = controller.webResourceCatalog();
  assert.match(catalog[0].resourceId, /^[0-9a-f]{32}$/);
  assert.equal(catalog[0].body, undefined);
  const rule = resourceRule(controller);
  const review = controller.reviewWebResource(JSON.stringify(rule), JSON.stringify(resourceSamples()));
  assert.equal(review.scope, 'arkweb.resources.override'); assert.equal(review.expectedHits, 1);
  assert.equal(review.bytes, Buffer.byteLength(resourceEntry().body));
  assert.equal(review.coverage, 'registered-allowlist;request-intercepted;frame-type-unverified');
  assert.equal(JSON.stringify(review).includes(resourceEntry().body), false);
  const original = {};
  assert.equal(controller.interceptWebResource(resourceRequest(), () => original), original);
  assert.equal(controller.confirmWebResource('0'.repeat(64)), false);
  assert.equal(controller.webResourceStatus().phase, 'review');
  assert.equal(controller.confirmWebResource(review.planHash), true);
  let originalCalls = 0;
  const response = controller.interceptWebResource(resourceRequest(), () => { originalCalls++; return original; });
  assert.equal(response.body, resourceEntry().body); assert.equal(response.mime, 'text/css');
  assert.equal(response.status, 200); assert.equal(response.reason, 'OK'); assert.equal(response.encoding, 'UTF-8');
  assert.equal(response.ready, true); assert.equal(originalCalls, 0);
  assert.deepEqual(response.headers, [
    { headerKey: 'Cache-Control', headerValue: 'no-store' },
    { headerKey: 'X-Content-Type-Options', headerValue: 'nosniff' },
    { headerKey: 'X-OHMate-Resource', headerValue: rule.resourceId },
  ]);
  assert.equal(controller.webResourceStatus().hits, 1);
  controller.cancelWebResource();
  assert.equal(controller.interceptWebResource(resourceRequest(), () => original), original);
  assert.equal(controller.confirmWebResource(review.planHash), false);
});
for (const [name, overrides] of [
  ['main frame', { isMainFrame: () => true }],
  ['redirect', { isRedirect: () => true }],
  ['POST', { getRequestMethod: () => 'POST' }],
  ['foreign origin', { getRequestUrl: () => 'https://example.test/kit-readonly.css' }],
  ['query', { getRequestUrl: () => resourceUrl + '?token=excluded' }],
  ['encoded path', { getRequestUrl: () => resourceUrl.replace('kit', '%6bit') }],
  ['cookie', { getRequestHeader: () => [{ headerKey: 'Cookie', get headerValue() { throw Error('private'); } }] }],
  ['unknown header', { getRequestHeader: () => [{ headerKey: 'X-Private', get headerValue() { throw Error('private'); } }] }],
]) {
  test(`ArkTS resource override passes through ${name} preserving the original response`, async (context) => {
    const { controller } = await connectResource(context);
    approveResource(controller);
    const original = {};
    assert.equal(controller.interceptWebResource(resourceRequest(overrides), () => original), original);
    assert.equal(controller.webResourceStatus().hits, 0);
  });
}
for (const reason of ['APP_BACKGROUND', 'USER_REVOKED', 'KEY_EXPIRED', 'WEB_SOURCE_REMOVED']) {
  test(`ArkTS resource override invalidates on ${reason}`, async (context) => {
    const { controller } = await connectResource(context);
    const review = approveResource(controller);
    await controller.stop(reason);
    assert.equal(controller.confirmWebResource(review.planHash), false);
    const original = {};
    assert.equal(controller.interceptWebResource(resourceRequest(), () => original), original);
  });
}
test('ArkTS resource override expires synchronously and repeated confirmation cannot extend TTL', async (context) => {
  const { controller } = await connectResource(context);
  const review = approveResource(controller);
  context.mock.timers.tick(29999);
  assert.equal(controller.confirmWebResource(review.planHash), true);
  context.mock.timers.tick(1);
  assert.equal(controller.confirmWebResource(review.planHash), false);
  assert.equal(controller.webResourceStatus().phase, 'idle');
});
test('ArkTS resource override revokes before page rebuild and source changes never revive old consent', async (context) => {
  const { controller, source } = await connectResource(context);
  const review = approveResource(controller);
  controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  assert.equal(controller.confirmWebResource(review.planHash), false);
  approveResource(controller);
  source.controller.getUrl = () => 'https://foreign.example/';
  assert.equal(controller.webResourceStatus().phase, 'idle');
  source.controller.getUrl = () => controlledWebUrl;
  assert.equal(controller.webResourceStatus().phase, 'idle');
});
test('ArkTS resource override preserves exact host errors and does not run fallback after selected construction failure', async (context) => {
  const { controller } = await connectResource(context);
  const original = new Error('host-private-failure');
  assert.throws(() => controller.interceptWebResource({}, () => { throw original; }), (error) => error === original);
  approveResource(controller);
  globalThis.WebResourceResponse = class { constructor() { throw Error('platform-private'); } };
  context.after(() => { delete globalThis.WebResourceResponse; });
  let calls = 0;
  assert.throws(() => controller.interceptWebResource(resourceRequest(), () => { calls++; }),
    /RESOURCE_RESPONSE_FAILED/);
  assert.equal(calls, 0); assert.equal(controller.webResourceStatus().phase, 'idle');
});
test('ArkTS resource override rejects wrong id, extra fields, malformed replacement and unknown sample fields', async (context) => {
  const { controller } = await connectResource(context);
  const review = approveResource(controller);
  for (const rule of [
    { ...resourceRule(controller), resourceId: '0'.repeat(32) },
    { ...resourceRule(controller), body: 'forbidden' },
    { ...resourceRule(controller), url: 'file:///private/example' },
  ]) {
    assert.throws(() => controller.reviewWebResource(JSON.stringify(rule), '[]'), /RESOURCE_RULE_INVALID/);
    assert.equal(controller.confirmWebResource(review.planHash), false);
  }
  assert.throws(() => controller.reviewWebResource(JSON.stringify(resourceRule(controller)),
    JSON.stringify([{ ...resourceSamples()[0], body: 'forbidden' }])), /RESOURCE_RULE_INVALID/);
});
test('ArkTS resource override freezes host resources and defensive catalog copies', async (context) => {
  const entry = resourceEntry();
  const { controller } = await connectResource(context, [entry]);
  entry.body = 'changed'; entry.url = 'file:///private/example';
  const catalog = controller.webResourceCatalog(); catalog[0].url = 'changed';
  approveResource(controller);
  globalThis.WebResourceResponse = TestWebResponse;
  context.after(() => { delete globalThis.WebResourceResponse; });
  assert.equal(controller.interceptWebResource(resourceRequest()).body, resourceEntry().body);
});
test('ArkTS resource override stays out of frames, summaries and problem export', async (context) => {
  const fixture = await connectResource(context);
  approveResource(fixture.controller);
  globalThis.WebResourceResponse = TestWebResponse;
  context.after(() => { delete globalThis.WebResourceResponse; });
  const before = fixture.socket.sent.length;
  fixture.controller.interceptWebResource(resourceRequest());
  assert.equal(fixture.socket.sent.length, before);
  assert.equal(fixture.controller.networkFile(), undefined);
  assert.equal(fixture.controller.webNetworkFile(), undefined);
  context.mock.timers.tick(1000); await settle(); acknowledge(fixture, 1);
  fixture.controller.reviewExport();
  assert.equal(fixture.controller.state.exportPhase, 'review');
  assert.equal(Buffer.from(fixture.controller.exportBytes).includes(Buffer.from(resourceEntry().body)), false);
});
for (const [name, entries] of [
  ['foreign origin', [{ ...resourceEntry(), url: 'https://example.test/style.css' }]],
  ['query', [{ ...resourceEntry(), url: resourceUrl + '?secret=excluded' }]],
  ['fragment', [{ ...resourceEntry(), url: resourceUrl + '#excluded' }]],
  ['file scheme', [{ ...resourceEntry(), url: 'file:///private/excluded.css' }]],
  ['traversal', [{ ...resourceEntry(), url: resourceUrl.replace('kit-readonly', '../kit-readonly') }]],
  ['backslash', [{ ...resourceEntry(), url: resourceUrl.replace('kit-readonly', '\\kit-readonly') }]],
  ['encoded separator', [{ ...resourceEntry(), url: resourceUrl.replace('kit-readonly', '%2fkit-readonly') }]],
  ['sensitive path', [{ ...resourceEntry(), url: resourceUrl.replace('kit-readonly', 'login') }]],
  ['unknown classification', [{ ...resourceEntry(), sensitivity: 'unknown' }]],
  ['HTML', [{ ...resourceEntry(), mimeType: 'text/html' }]],
  ['script', [{ ...resourceEntry(), mimeType: 'application/javascript' }]],
  ['field extension', [{ ...resourceEntry(), file: '/private/excluded.css' }]],
  ['duplicate URL', [resourceEntry(), resourceEntry()]],
  ['body over limit', [{ ...resourceEntry(), body: 'x'.repeat(65537) }]],
  ['decoded lone surrogate', [{ ...resourceEntry(), body: '\ud800' }]],
  ['entry over limit', Array.from({ length: 33 }, (_, i) => ({ ...resourceEntry(), url: resourceUrl + i }))],
  ['total bytes over limit', Array.from({ length: 5 }, (_, i) => ({ ...resourceEntry(), url: resourceUrl + i, body: 'x'.repeat(65536) }))],
]) {
  test(`ArkTS resource boundary rejects ${name} at host registration`, (context) => {
    const { controller } = controllerFixture(context);
    assert.throws(() => controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl, entries));
    assert.deepEqual(controller.webResourceCatalog(), []);
  });
}
test('ArkTS resource boundary binds raw rule/sample hashes, identity, epoch and page revision', async (context) => {
  const { controller } = await connectResource(context);
  const rule = JSON.stringify(resourceRule(controller)), samples = JSON.stringify(resourceSamples());
  const first = controller.reviewWebResource(rule, samples);
  const second = controller.reviewWebResource(rule + ' ', samples + ' ');
  assert.notEqual(second.planHash, first.planHash);
  assert.equal(first.payloadHash, second.payloadHash); assert.equal(first.samplesHash, second.samplesHash);
  assert.equal(controller.confirmWebResource(first.planHash), false);
  controller.epoch += '-foreign';
  assert.equal(controller.confirmWebResource(second.planHash), false);
  assert.equal(controller.webResourceStatus().phase, 'idle');
  const third = controller.reviewWebResource(rule, samples);
  controller.session.negotiated.identity.buildId = 'unverified:changed';
  assert.equal(controller.confirmWebResource(third.planHash), false);
});
test('ArkTS resource boundary detects clock rollback and never restores the old plan', async (context) => {
  const { controller } = await connectResource(context);
  const review = approveResource(controller);
  context.mock.timers.setTime(now - 1);
  assert.equal(controller.confirmWebResource(review.planHash), false);
  context.mock.timers.setTime(now + 1);
  assert.equal(controller.confirmWebResource(review.planHash), false);
});
test('ArkTS resource boundary keeps the session deadline and consumes malformed attempts', async (context) => {
  const { controller } = await connectResource(context);
  controller.session.limits.expiresAt = now + 1000;
  const review = approveResource(controller, resourceRule(controller), resourceSamples(), 600000);
  assert.equal(review.expiresAt, now + 1000);
  for (let i = 1; i < 256; i++) {
    assert.throws(() => controller.reviewWebResource('{', '[]'), /RESOURCE_RULE_INVALID/);
  }
  assert.throws(() => controller.reviewWebResource(JSON.stringify(resourceRule(controller)), '[]'), /RESOURCE_UNAVAILABLE/);
});
test('ArkTS resource boundary allows 128 hits without resetting on confirm and refuses native fallback at quota', async (context) => {
  const { controller } = await connectResource(context);
  const review = approveResource(controller);
  globalThis.WebResourceResponse = TestWebResponse;
  context.after(() => { delete globalThis.WebResourceResponse; });
  for (let i = 0; i < 128; i++) {
    assert.equal(controller.confirmWebResource(review.planHash), true);
    assert.equal(controller.interceptWebResource(resourceRequest()).ready, true);
  }
  let fallback = 0;
  assert.throws(() => controller.interceptWebResource(resourceRequest(), () => { fallback++; }), /RESOURCE_RESPONSE_QUOTA/);
  assert.equal(fallback, 0); assert.equal(controller.webResourceStatus().hits, 128);
});
test('ArkTS resource boundary allows exact 1 MiB responses and rejects the next without fallback', async (context) => {
  const { controller } = await connectResource(context, [{ ...resourceEntry(), body: 'x'.repeat(65536) }]);
  approveResource(controller);
  globalThis.WebResourceResponse = TestWebResponse;
  context.after(() => { delete globalThis.WebResourceResponse; });
  for (let i = 0; i < 16; i++) controller.interceptWebResource(resourceRequest());
  assert.equal(controller.webResourceStatus().bytes, 1048576);
  assert.throws(() => controller.interceptWebResource(resourceRequest()), /RESOURCE_RESPONSE_QUOTA/);
});
test('ArkTS resource boundary rejects 129 samples, duplicate ids and invalid TTL', async (context) => {
  const { controller } = await connectResource(context);
  const rule = JSON.stringify(resourceRule(controller));
  for (const samples of [
    Array.from({ length: 129 }, (_, i) => ({ ...resourceSamples()[0], requestId: 'sample-' + i })),
    [resourceSamples()[0], resourceSamples()[0]],
  ]) assert.throws(() => controller.reviewWebResource(rule, JSON.stringify(samples)), /RESOURCE_RULE_INVALID/);
  for (const ttl of [0, -1, 0.5, 600001, NaN]) {
    assert.throws(() => controller.reviewWebResource(rule, '[]', ttl), /RESOURCE_RULE_INVALID/);
  }
});
test('ArkTS resource boundary ignores header values and refuses duplicates or malformed native headers', async (context) => {
  const { controller } = await connectResource(context);
  approveResource(controller);
  for (const headers of [null, [], [{ headerKey: 'ACCEPT' }, { headerKey: 'accept' }], [null], [{ headerKey: 3 }]]) {
    if (Array.isArray(headers) && headers.length === 0) continue;
    const original = {};
    assert.equal(controller.interceptWebResource(resourceRequest({ getRequestHeader: () => headers }), () => original), original);
  }
});
test('ArkTS resource boundary rejects a request changed during header inspection before constructing a response', async (context) => {
  const { controller } = await connectResource(context);
  approveResource(controller);
  let currentUrl = resourceUrl, constructed = 0, fallback = 0;
  globalThis.WebResourceResponse = class extends TestWebResponse { constructor() { super(); constructed++; } };
  context.after(() => { delete globalThis.WebResourceResponse; });
  const request = resourceRequest({ getRequestUrl: () => currentUrl,
    getRequestHeader: () => { currentUrl = 'https://foreign.example/style.css'; return []; } });
  assert.throws(() => controller.interceptWebResource(request, () => { fallback++; }), /RESOURCE_CANCELLED/);
  assert.equal(constructed, 0); assert.equal(fallback, 0);
});
test('ArkTS resource boundary rejects revocation inside response construction without returning stale bytes', async (context) => {
  const { controller } = await connectResource(context);
  approveResource(controller);
  globalThis.WebResourceResponse = class extends TestWebResponse {
    setResponseData(value) { super.setResponseData(value); controller.cancelWebResource(); }
  };
  context.after(() => { delete globalThis.WebResourceResponse; });
  assert.throws(() => controller.interceptWebResource(resourceRequest()), /RESOURCE_RESPONSE_FAILED/);
  assert.equal(controller.webResourceStatus().phase, 'idle');
});

async function connectConsole(context, allowed = true) {
  const source = nativeWeb();
  const calls = [];
  let result = async () => ({ getType: () => 2, getNumber: () => 2 });
  source.controller.runJavaScriptExt = (code) => { calls.push(code); return result(); };
  const fixture = await connectUi(context, undefined, ({ controller }) => {
    controller.registerWeb(source.controller, 'web-main', controlledWebUrl, [], allowed);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  return { ...fixture, source, calls, result: (fn) => { result = fn; } };
}
test('Console execution stays default closed and needs independent review, confirmation and execution', async (context) => {
  const fixture = await connectConsole(context, false);
  assert.throws(() => fixture.controller.reviewConsole('1 + 1'), /CONSOLE_UNAVAILABLE/);
  assert.equal(fixture.calls.length, 0);
});
test('Console command is bound, single use and excluded from transport and explicit export', async (context) => {
  const fixture = await connectConsole(context);
  const { controller } = fixture;
  const review = controller.reviewConsole('1 + 1');
  assert.equal(review.scope, 'arkweb.console.execute'); assert.equal(review.risk, 'R3');
  assert.match(review.commandId, /^[a-f0-9]{32}$/); assert.match(review.planHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(review).includes('1 + 1'), false);
  assert.equal(await controller.executeConsole(review.planHash), false);
  assert.equal(controller.confirmConsole(review.planHash), true);
  assert.equal(await controller.executeConsole(review.planHash), true);
  assert.deepEqual(fixture.calls, ['1 + 1']);
  assert.equal(controller.consoleStatus().phase, 'completed');
  assert.equal(controller.consoleStatus().resultType, 'number');
  assert.equal(controller.confirmConsole(review.planHash), false);
  assert.equal(await controller.executeConsole(review.planHash), false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.socket.sent.length, 2);
  context.mock.timers.tick(1000); await settle();
  controller.reviewExport();
  const zip = controller.exportBytes;
  assert.ok(zip.length > 0);
  assert.equal(Buffer.from(zip).includes(Buffer.from('1 + 1')), false);
  assert.equal(Buffer.from(zip).includes(Buffer.from(review.commandId)), false);
});
for (const code of ['', ' '.repeat(5), 'x'.repeat(4097), '汉'.repeat(1366), '\ud800']) {
  test('Console rejects invalid/oversized UTF-8 code ' + JSON.stringify(code.slice(0, 8)), async (context) => {
    const fixture = await connectConsole(context);
    assert.throws(() => fixture.controller.reviewConsole(code), /CONSOLE_CODE_INVALID/);
    assert.equal(fixture.calls.length, 0);
  });
}
for (const action of ['cancel', 'navigation', 'source', 'debug', 'expiry', 'rollback', 'background']) {
  test('Console consent cannot execute after ' + action, async (context) => {
    const fixture = await connectConsole(context);
    const review = fixture.controller.reviewConsole('1 + 1');
    assert.equal(fixture.controller.confirmConsole(review.planHash), true);
    if (action === 'cancel') { fixture.controller.cancelConsole(); }
    if (action === 'navigation') { fixture.controller.webPageBegin(controlledWebUrl); fixture.controller.webPageEnd(controlledWebUrl); }
    if (action === 'source') { fixture.source.controller.getUrl = () => 'http://127.0.0.1:12345/login'; }
    if (action === 'debug') { globalThis.__kitTest.debug = false; }
    if (action === 'expiry') { context.mock.timers.setTime(review.expiresAt); }
    if (action === 'rollback') { context.mock.timers.setTime(now - 1); }
    if (action === 'background') { await fixture.controller.stop('APP_BACKGROUND'); }
    assert.equal(await fixture.controller.executeConsole(review.planHash), false);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.controller.consoleStatus().phase, 'idle');
  });
}
test('Console timeout discards late output and retains native owner until settlement', async (context) => {
  const fixture = await connectConsole(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const review = fixture.controller.reviewConsole('1 + 1');
  fixture.controller.confirmConsole(review.planHash);
  const waiting = fixture.controller.executeConsole(review.planHash);
  await settle(); assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.controller.consoleStatus().phase, 'running');
  context.mock.timers.tick(3000); await settle();
  assert.equal(await waiting, false);
  assert.equal(fixture.controller.consoleStatus().phase, 'timeout');
  assert.equal(fixture.controller.consoleStatus().nativePending, true);
  assert.throws(() => fixture.controller.reviewConsole('2 + 2'), /CONSOLE_CAPTURE_BUSY/);
  assert.equal(await fixture.controller.captureWebDom(), false);
  assert.throws(() => fixture.controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl), /WEB_CAPTURE_BUSY/);
  await fixture.controller.stop();
  assert.throws(() => fixture.controller.review(fixture.text), /WEB_CAPTURE_BUSY/);
  finish({ getType: () => { throw Error('late output must not be read'); } }); await settle();
  assert.equal(fixture.controller.consoleStatus().nativePending, false);
  assert.equal(fixture.controller.consoleStatus().phase, 'idle');
});
test('Console type result masks string and never serializes unsupported result/error bodies', async (context) => {
  const fixture = await connectConsole(context);
  fixture.result(async () => ({ getType: () => 1, getString: () => 'PRIVATE_TEST_ONLY',
    getErrorDescription: () => { throw Error('error body must not be read'); } }));
  let review = fixture.controller.reviewConsole('"PRIVATE_TEST_ONLY"');
  fixture.controller.confirmConsole(review.planHash);
  assert.equal(await fixture.controller.executeConsole(review.planHash), true);
  const status = fixture.controller.consoleStatus();
  assert.equal(status.resultType, 'string'); assert.equal(status.bytes, 17);
  assert.equal(JSON.stringify(status).includes('PRIVATE_TEST_ONLY'), false);
  context.mock.timers.tick(1000); context.mock.timers.setTime(now + 1000); await settle();
  fixture.result(async () => ({ getType: () => 4,
    getArrayBuffer: () => { throw Error('arraybuffer body must not be read'); } }));
  review = fixture.controller.reviewConsole('new ArrayBuffer(16)');
  fixture.controller.confirmConsole(review.planHash);
  assert.equal(await fixture.controller.executeConsole(review.planHash), true);
  assert.equal(fixture.controller.consoleStatus().resultType, 'unsupported');
});
test('Console origin drift during return-value reading rejects old output', async (context) => {
  const fixture = await connectConsole(context);
  fixture.result(async () => ({ getType: () => 1, getString: () => {
    fixture.source.controller.getUrl = () => 'https://example.invalid/login'; return 'TEST_ONLY';
  } }));
  const review = fixture.controller.reviewConsole('"TEST_ONLY"');
  fixture.controller.confirmConsole(review.planHash);
  assert.equal(await fixture.controller.executeConsole(review.planHash), false);
  assert.equal(fixture.controller.consoleStatus().phase, 'idle');
});
for (const source of Array.from({ length: 13 }, (_, i) => i)) {
  test('Console source accepts SDK category ' + source + ' only from the registered page script', async (context) => {
    const fixture = await connectWeb(context);
    fixture.controller.observeWebConsole({ ...nativeConsoleMessage(), getSource: () => source,
      getSourceId: () => controlledWebUrl.replace('.html', '.js'), getLineNumber: () => 8 });
    context.mock.timers.tick(1000); await settle();
    const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
    assert.equal(event.channel, 'arkweb.console');
    assert.equal(event.payload.summary, 'source-' + source + ';script;line-8;frame-column-unverified;[MEMORY_ONLY]');
    assert.equal(JSON.stringify(event).includes('/kit-readonly'), false);
  });
}
for (const change of [
  { getSource: () => -1 }, { getSource: () => 13 }, { getSource: () => NaN },
  { getSource: () => 1.5 }, { getSource: () => { throw Error('TEST_ONLY'); } },
  { getSourceId: () => 'https://example.invalid/kit-readonly.js' },
  { getSourceId: () => controlledWebUrl + '?token=TEST_ONLY' },
  { getSourceId: () => controlledWebUrl.replace('kit-readonly.html', 'login') },
  { getSourceId: () => '' }, { getLineNumber: () => -1 }, { getLineNumber: () => Infinity },
  { getLineNumber: () => 1000001 }, { getMessageLevel: () => 6 },
]) {
  test('Console source rejects invalid source metadata ' + JSON.stringify(Object.keys(change)), async (context) => {
    const fixture = await connectWeb(context);
    fixture.controller.observeWebConsole({ ...nativeConsoleMessage(), ...change });
    context.mock.timers.tick(1000); await settle();
    const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
    assert.equal(event.channel, 'hidebug'); assert.equal(fixture.controller.webConsoleFile(), undefined);
  });
}
test('Console source rechecks the page and navigation revision after native metadata getters', async (context) => {
  const fixture = await connectWeb(context);
  fixture.controller.observeWebConsole({ ...nativeConsoleMessage(), getLineNumber: () => {
    fixture.controller.webPageBegin(controlledWebUrl); fixture.controller.webPageEnd(controlledWebUrl); return 1;
  } });
  context.mock.timers.tick(1000); await settle();
  assert.equal(fixture.accepted.channel.open(fixture.socket.sent.at(-1)).channel, 'hidebug');
});
for (const result of [
  { getType: () => 1, getString: () => 'x'.repeat(4097) },
  { getType: () => 1, getString: () => '汉'.repeat(1366) },
  { getType: () => 1, getString: () => '\ud800' },
  { getType: () => 2, getNumber: () => Infinity },
  { getType: () => 3, getBoolean: () => 'wrong' },
  { getType: () => 6 }, { getType: () => '1' },
  { getType: () => { throw Error('PRIVATE_TEST_ONLY'); } },
]) {
  test('Console result rejects invalid native output ' + Object.keys(result).join(','), async (context) => {
    const fixture = await connectConsole(context); fixture.result(async () => result);
    const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
    assert.equal(await fixture.controller.executeConsole(review.planHash), false);
    assert.equal(fixture.controller.consoleStatus().phase, 'failed');
    assert.equal(JSON.stringify(fixture.controller.consoleStatus()).includes('PRIVATE_TEST_ONLY'), false);
    assert.equal(fixture.calls.length, 1);
    assert.equal(await fixture.controller.executeConsole(review.planHash), false);
  });
}
test('Console wrong hash, review replacement and caller mutation cannot authorize or replay a command', async (context) => {
  const fixture = await connectConsole(context);
  const first = fixture.controller.reviewConsole('1 + 1');
  assert.equal(fixture.controller.confirmConsole('0'.repeat(64)), false);
  assert.equal(await fixture.controller.executeConsole(first.planHash), false);
  const second = fixture.controller.reviewConsole('2 + 2');
  assert.notEqual(first.planHash, second.planHash); assert.notEqual(first.commandId, second.commandId);
  assert.equal(fixture.controller.confirmConsole(first.planHash), false);
  second.planHash = first.planHash;
  assert.equal(fixture.controller.confirmConsole(second.planHash), false);
  assert.equal(fixture.calls.length, 0);
});
test('Console cancellation before native dispatch prevents invocation', async (context) => {
  const fixture = await connectConsole(context);
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  const waiting = fixture.controller.executeConsole(review.planHash);
  fixture.controller.cancelConsole(); await settle();
  assert.equal(await waiting, false); assert.equal(fixture.calls.length, 0);
});
test('Console cancellation during native execution ends waiting and drops result getters', async (context) => {
  const fixture = await connectConsole(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  const waiting = fixture.controller.executeConsole(review.planHash); await settle();
  fixture.controller.cancelConsole(); await settle();
  assert.equal(await waiting, false); assert.equal(fixture.controller.state.consoleNativePending, true);
  finish({ getType: () => { throw Error('late getter must not be read'); } }); await settle();
  assert.equal(fixture.controller.state.consoleNativePending, false);
  assert.equal(fixture.controller.consoleStatus().phase, 'idle');
});
test('Console attempts stay bounded across cancel, failed code and duplicate confirmation', async (context) => {
  const fixture = await connectConsole(context);
  for (let i = 0; i < 255; i++) {
    assert.throws(() => fixture.controller.reviewConsole(''), /CONSOLE_CODE_INVALID/);
    fixture.controller.cancelConsole();
  }
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  fixture.controller.confirmConsole(review.planHash);
  assert.equal(await fixture.controller.executeConsole(review.planHash), true);
  fixture.controller.cancelConsole();
  assert.throws(() => fixture.controller.reviewConsole('2 + 2'), /CONSOLE_UNAVAILABLE/);
  assert.equal(fixture.calls.length, 1);
});
test('Console does not reset cumulative output budget after cancel and enforces execution frequency', async (context) => {
  const fixture = await connectConsole(context);
  fixture.result(async () => ({ getType: () => 1, getString: () => 'x'.repeat(4096) }));
  for (let i = 0; i < 17; i++) {
    context.mock.timers.setTime(now + i * 1000);
    const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
    assert.equal(await fixture.controller.executeConsole(review.planHash), i < 16);
    if (i === 0) {
      const next = fixture.controller.reviewConsole('2 + 2'); fixture.controller.confirmConsole(next.planHash);
      assert.equal(await fixture.controller.executeConsole(next.planHash), false);
      assert.equal(fixture.calls.length, 1);
    }
    fixture.controller.cancelConsole();
  }
  assert.equal(fixture.calls.length, 17);
});
test('Console execution invalidates an earlier DOM snapshot and frozen export before native effects', async (context) => {
  const fixture = await connectConsole(context);
  context.mock.timers.tick(1000); await settle();
  acknowledge(fixture, fixture.controller.state.unacknowledged); await settle();
  assert.equal(await fixture.controller.captureWebDom(), true);
  acknowledge(fixture, fixture.controller.state.unacknowledged); await settle();
  assert.ok(fixture.controller.webDomFile());
  fixture.controller.reviewExport(); assert.equal(fixture.controller.state.exportPhase, 'review');
  let observed;
  fixture.result(async () => {
    observed = { dom: fixture.controller.webDomFile(), exportPhase: fixture.controller.state.exportPhase };
    return { getType: () => 2, getNumber: () => 2 };
  });
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  assert.equal(await fixture.controller.executeConsole(review.planHash), true);
  assert.deepEqual(observed, { dom: undefined, exportPhase: 'idle' });
  assert.equal(fixture.controller.webDomFile(), undefined);
});
for (const value of [null, undefined, 'PRIVATE_TEST_ONLY', new Error('PRIVATE_TEST_ONLY')]) {
  test('Console native rejection never leaks or rejects the public operation ' + typeof value, async (context) => {
    const fixture = await connectConsole(context);
    fixture.result(() => Promise.reject(value));
    const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
    assert.equal(await fixture.controller.executeConsole(review.planHash), false);
    assert.equal(fixture.controller.consoleStatus().phase, 'failed');
    assert.equal(fixture.controller.consoleStatus().reason, 'CONSOLE_EXECUTION_FAILED');
    assert.equal(fixture.controller.consoleStatus().nativePending, false);
  });
}

async function connectStorage(context, screenshotAllowed = false, storageAccess) {
  const source = nativeWeb();
  source.controller.isIncognitoMode = () => true;
  const calls = [];
  let result = async () => 'test-a=PRIVATE_TEST_ONLY; test-b=SECOND_TEST_ONLY';
  globalThis.__kitTest.cookies = (...args) => { calls.push(args); return result(); };
  const fixture = await connectUi(context, undefined, ({ controller, uiContext }) => {
    if (screenshotAllowed) { controller.registerUi(uiContext, 'bridge_capture_root', 'page-main', true); }
    controller.registerWeb(source.controller, 'web-main', controlledWebUrl, [], true, storageAccess);
    controller.webPageBegin(controlledWebUrl); controller.webPageEnd(controlledWebUrl);
  });
  return { ...fixture, source, calls, result: (fn) => { result = fn; } };
}
const controlledStorageKeys = [
  { area: 'local', key: 'ohmate-test-local', sensitivity: 'ordinary' },
  { area: 'session', key: 'ohmate-test-session', sensitivity: 'ordinary' },
];
async function connectControlledStorage(context, allowed = true, keys = controlledStorageKeys) {
  let enabled = allowed;
  const access = { enabled: () => enabled, entries: structuredClone(keys) };
  const fixture = await connectStorage(context, false, access);
  const scripts = [];
  let result = () => Promise.resolve({ getType: () => 1, getString: () => JSON.stringify({
    url: controlledWebUrl,
    entries: keys.map((item) => ({ area: item.area, key: item.key, value: 'PRIVATE_TEST_VALUE' })),
  }) });
  fixture.source.controller.runJavaScriptExt = (code) => { scripts.push(code); return result(); };
  return { ...fixture, scripts, access, enabled: (value) => { enabled = value; }, result: (fn) => { result = fn; } };
}
test('Controlled Storage defaults closed and requires current explicit host permission', async (context) => {
  const fixture = await connectControlledStorage(context, false);
  assert.equal(await fixture.controller.captureControlledStorage(), false);
  assert.equal(fixture.scripts.length, 0); assert.equal(fixture.calls.length, 0);
  fixture.enabled(true);
  assert.equal(await fixture.controller.captureControlledStorage(), true);
  assert.equal(fixture.scripts.length, 1);
});
test('Controlled Storage reads exact allowlisted keys and keeps raw values out of public state and archives', async (context) => {
  const fixture = await connectControlledStorage(context);
  assert.equal(await fixture.controller.captureControlledStorage(), true);
  const snapshot = fixture.controller.webStorageSnapshot();
  assert.equal(snapshot.localEntryCount, 1); assert.equal(snapshot.sessionEntryCount, 1);
  assert.equal(snapshot.cookieSource, 'not-captured');
  assert.equal(snapshot.localStorage, 'allowlist-only');
  assert.equal(fixture.calls.length, 0);
  assert(!JSON.stringify(fixture.controller.state).includes('PRIVATE_TEST_VALUE'));
  assert(!JSON.stringify(snapshot).includes('ohmate-test-local'));
  assert.equal(await fixture.controller.publishWebStorage(), false);
  assert.equal(fixture.controller.webStorageFile(), undefined);
  assert.equal(fixture.socket.sent.length, 2);
  const local = new Map([['ohmate-test-local', 'PRIVATE_TEST_VALUE'], ['unlisted', 'DO_NOT_READ']]);
  const session = new Map([['ohmate-test-session', null]]);
  const read = [];
  const port = (area, map) => ({ getItem: (key) => { read.push([area, key]); return map.get(key) ?? null; } });
  const scriptResult = Function('location', 'window', 'return ' + fixture.scripts[0])(
    { href: controlledWebUrl }, { localStorage: port('local', local), sessionStorage: port('session', session) });
  assert.deepEqual(JSON.parse(scriptResult).entries.map((item) => item.value), ['PRIVATE_TEST_VALUE', null]);
  assert.deepEqual(read, [['local', 'ohmate-test-local'], ['session', 'ohmate-test-session']]);
});
for (const mutation of ['url', 'extra', 'order', 'duplicate', 'area', 'key', 'value', 'oversize', 'utf8', 'message-type']) {
  test('Controlled Storage rejects untrusted projection ' + mutation, async (context) => {
    const fixture = await connectControlledStorage(context);
    const raw = { url: controlledWebUrl, entries: controlledStorageKeys.map((item) =>
      ({ area: item.area, key: item.key, value: 'PRIVATE_TEST_VALUE' })) };
    if (mutation === 'url') raw.url += '?changed';
    if (mutation === 'extra') raw.extra = 'DO_NOT_READ';
    if (mutation === 'order') raw.entries.reverse();
    if (mutation === 'duplicate') raw.entries[1] = raw.entries[0];
    if (mutation === 'area') raw.entries[0].area = 'cookie';
    if (mutation === 'key') raw.entries[0].key = 'unlisted';
    if (mutation === 'value') raw.entries[0].value = {};
    if (mutation === 'oversize') raw.entries[0].value = 'x'.repeat(1025);
    if (mutation === 'utf8') raw.entries[0].value = '\ud800';
    fixture.result(async () => ({ getType: () => mutation === 'message-type' ? 2 : 1,
      getString: () => JSON.stringify(raw) }));
    assert.equal(await fixture.controller.captureControlledStorage(), false);
    assert.equal(fixture.controller.webStorageSnapshot(), undefined);
    assert.equal(fixture.controller.state.storageReason, 'STORAGE_CAPTURE_FAILED');
    assert(!JSON.stringify(fixture.controller.state).includes('PRIVATE_TEST_VALUE'));
  });
}
for (const action of ['permission', 'url', 'incognito', 'document', 'background', 'debug', 'identity', 'epoch', 'expiry', 'cancel']) {
  test('Controlled Storage discards native values after ' + action, async (context) => {
    const fixture = await connectControlledStorage(context);
    let finish;
    fixture.result(() => new Promise((resolve) => { finish = resolve; }));
    const operation = fixture.controller.captureControlledStorage(); await settle();
    assert.equal(typeof finish, 'function');
    if (action === 'permission') fixture.enabled(false);
    if (action === 'url') fixture.source.controller.getUrl = () => controlledWebUrl + '?changed';
    if (action === 'incognito') fixture.source.controller.isIncognitoMode = () => false;
    if (action === 'document') fixture.controller.webPageBegin(controlledWebUrl);
    if (action === 'background') await fixture.controller.stop();
    if (action === 'debug') globalThis.__kitTest.debug = false;
    if (action === 'identity') fixture.controller.session.negotiated.identity.process = 'changed';
    if (action === 'epoch') fixture.controller.epoch = 'changed';
    if (action === 'expiry') context.mock.timers.tick(30000);
    if (action === 'cancel') fixture.controller.cancelWebStorage();
    finish({ getType: () => 1, getString: () => { throw Error('Stale native values must not be accessed'); } });
    assert.equal(await operation, false);
    assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  });
}
test('Controlled Storage timeout keeps the native lock and shares the Cookie rate budget', async (context) => {
  const fixture = await connectControlledStorage(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const operation = fixture.controller.captureControlledStorage(); await settle();
  context.mock.timers.tick(3000); await settle();
  assert.equal(await operation, false);
  assert.equal(fixture.controller.state.storagePhase, 'timeout');
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(await fixture.controller.captureControlledStorage(), false);
  assert.throws(() => fixture.controller.reviewConsole('0'), /CONSOLE_CAPTURE_BUSY/);
  finish({ getType: () => 1, getString: () => { throw Error('Late value must not be accessed'); } });
  await settle(); assert.equal(fixture.controller.state.storageNativePending, false);
  fixture.result(async () => ({ getType: () => 1, getString: () => JSON.stringify({
    url: controlledWebUrl, entries: controlledStorageKeys.map((item) => ({ area: item.area, key: item.key, value: null })),
  }) }));
  assert.equal(await fixture.controller.captureControlledStorage(), true);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  context.mock.timers.tick(1000);
  fixture.enabled(false);
  assert.equal(await fixture.controller.captureWebStorage(), true);
});
for (const action of ['permission', 'incognito', 'document', 'identity', 'epoch', 'expiry', 'rollback', 'cancel']) {
  test('Controlled Storage clears raw memory synchronously on ' + action, async (context) => {
    const fixture = await connectControlledStorage(context);
    assert.equal(await fixture.controller.captureControlledStorage(), true);
    assert.equal(fixture.controller.webStorage.controlledValues.length, 2);
    const previous = fixture.controller.webStorage.controlledValues;
    if (action === 'permission') fixture.enabled(false);
    if (action === 'incognito') fixture.source.controller.isIncognitoMode = () => false;
    if (action === 'document') fixture.controller.webPageBegin(controlledWebUrl);
    if (action === 'identity') fixture.controller.session.negotiated.identity.process = 'changed';
    if (action === 'epoch') fixture.controller.epoch = 'changed';
    if (action === 'expiry') context.mock.timers.setTime(now + 30000);
    if (action === 'rollback') context.mock.timers.setTime(now - 1);
    if (action === 'cancel') fixture.controller.cancelWebStorage();
    assert.equal(fixture.controller.webStorageSnapshot(), undefined);
    assert.equal(fixture.controller.webStorage.controlledValues.length, 0);
    assert(previous.every((item) => item.value === null));
    if (action === 'rollback') {
      context.mock.timers.setTime(now + 1000);
      assert.equal(await fixture.controller.captureControlledStorage(), false);
    }
  });
}
for (const keys of [[], [...controlledStorageKeys, controlledStorageKeys[0]],
  [{ area: 'cookie', key: 'ohmate-test-local', sensitivity: 'ordinary' }],
  [{ area: 'local', key: 'access-token', sensitivity: 'ordinary' }],
  [{ area: 'local', key: 'ohmate-test-local', sensitivity: 'secret' }],
  [{ area: 'local', key: 'ohmate-test-local', sensitivity: 'ordinary', extra: true }],
  Array.from({ length: 17 }, (_, index) => ({ area: 'local', key: 'ohmate-test-' + index, sensitivity: 'ordinary' }))]) {
  test('Controlled Storage refuses invalid host allowlist ' + JSON.stringify(keys).slice(0, 100), (context) => {
    const fixture = controllerFixture(context);
    assert.throws(() => fixture.controller.registerWeb(nativeWeb().controller, 'web-main', controlledWebUrl,
      [], false, { enabled: () => true, entries: keys }), /STORAGE_ACCESS_INVALID/);
  });
}
test('Controlled Storage captures absent keys and empty strings without conflating them or reading unlisted entries', async (context) => {
  const fixture = await connectControlledStorage(context);
  fixture.result(async () => ({ getType: () => 1, getString: () => JSON.stringify({
    url: controlledWebUrl, entries: [
      { area: 'local', key: 'ohmate-test-local', value: '' },
      { area: 'session', key: 'ohmate-test-session', value: null },
    ],
  }) }));
  fixture.access.entries[0].key = 'unlisted';
  assert.equal(await fixture.controller.captureControlledStorage(), true);
  assert.equal(fixture.controller.webStorageSnapshot().localEntryCount, 1);
  assert.equal(fixture.controller.webStorageSnapshot().sessionEntryCount, 0);
  assert(!fixture.scripts[0].includes('unlisted'), 'Registration must take a defensive allowlist copy');
});
test('Controlled Storage denial cannot cancel an unrelated Cookie native operation', async (context) => {
  const fixture = await connectControlledStorage(context, false);
  let finish;
  globalThis.__kitTest.cookies = () => new Promise((resolve) => { finish = resolve; });
  const operation = fixture.controller.captureWebStorage(); await settle();
  assert.equal(await fixture.controller.captureControlledStorage(), false);
  assert.equal(fixture.controller.state.storagePhase, 'reading');
  finish('a=PRIVATE_TEST_VALUE'); assert.equal(await operation, true);
});
test('Controlled Storage cancellation before dispatch never invokes page script', async (context) => {
  const fixture = await connectControlledStorage(context);
  const operation = fixture.controller.captureControlledStorage();
  fixture.controller.cancelWebStorage();
  assert.equal(await operation, false); assert.equal(fixture.scripts.length, 0);
});
test('Controlled Storage checks source again before accessing the raw message getter', async (context) => {
  const fixture = await connectControlledStorage(context);
  let getters = 0;
  fixture.result(async () => ({
    getType: () => { fixture.enabled(false); return 1; },
    getString: () => { getters++; return 'PRIVATE_TEST_VALUE'; },
  }));
  assert.equal(await fixture.controller.captureControlledStorage(), false);
  assert.equal(getters, 0);
});
test('Controlled Storage includes failed page reads in the shared 256-attempt connection budget', async (context) => {
  const fixture = await connectControlledStorage(context);
  fixture.result(async () => { throw Error('PRIVATE_TEST_ERROR'); });
  for (let index = 0; index < 256; index++) {
    context.mock.timers.setTime(now + index * 1000);
    assert.equal(await fixture.controller.captureControlledStorage(), false);
    fixture.controller.cancelWebStorage();
  }
  context.mock.timers.setTime(now + 256000);
  fixture.enabled(false);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(await fixture.controller.captureControlledStorage(), false);
  assert.equal(fixture.scripts.length, 256); assert.equal(fixture.calls.length, 0);
});
test('Controlled Storage permission keeps Cookie disabled-scope metadata honest', async (context) => {
  const fixture = await connectControlledStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(fixture.calls.length, 0);
  fixture.enabled(false);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  fixture.enabled(true);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  assert.equal(await fixture.controller.publishWebStorage(), false);
  assert.equal(fixture.controller.webStorageFile(), undefined);
});
test('Controlled Storage does not claim a storage area outside the host allowlist', async (context) => {
  const fixture = await connectControlledStorage(context, true, [controlledStorageKeys[0]]);
  assert.equal(await fixture.controller.captureControlledStorage(), true);
  assert.equal(fixture.controller.webStorageSnapshot().localStorage, 'allowlist-only');
  assert.equal(fixture.controller.webStorageSnapshot().sessionStorage, 'disabled');
  assert.equal(fixture.controller.webStorageSnapshot().sessionEntryCount, 0);
});
test('Controlled Storage rejects a UTF-8 projection above 4 KiB despite fewer than 4096 characters', async (context) => {
  const fixture = await connectControlledStorage(context);
  fixture.result(async () => ({ getType: () => 1, getString: () => JSON.stringify({
    url: controlledWebUrl, entries: controlledStorageKeys.map((item) => ({ area: item.area, key: item.key, value: '中'.repeat(1024) })),
  }) }));
  assert.equal(await fixture.controller.captureControlledStorage(), false);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  assert.equal(fixture.controller.webStorage.controlledValues.length, 0);
});
test('Controlled Storage raw values are cleared before separately confirmed Console effects', async (context) => {
  const fixture = await connectControlledStorage(context);
  assert.equal(await fixture.controller.captureControlledStorage(), true);
  fixture.source.controller.runJavaScriptExt = async () => {
    assert.equal(fixture.controller.webStorage.controlledValues.length, 0);
    assert.equal(fixture.controller.webStorageSnapshot(), undefined);
    return { getType: () => 2, getNumber: () => 2 };
  };
  const review = fixture.controller.reviewConsole('1 + 1');
  assert.equal(fixture.controller.confirmConsole(review.planHash), true);
  assert.equal(await fixture.controller.executeConsole(review.planHash), true);
});
test('Storage requires explicit reading and returns masked URL-related incognito Cookie metadata only', async (context) => {
  const fixture = await connectStorage(context);
  const { controller } = fixture;
  assert.equal(controller.webStorageSnapshot(), undefined);
  assert.equal(fixture.calls.length, 0);
  assert.equal(await controller.captureWebStorage(), true);
  assert.deepEqual(fixture.calls, [[controlledWebUrl, true, false]]);
  const snapshot = controller.webStorageSnapshot();
  assert.equal(snapshot.targetId, 'web-main');
  assert.equal(snapshot.cookieEntryCount, 2);
  assert.equal(snapshot.cookieSource, 'url-related-incognito-unpartitioned');
  assert.equal(snapshot.summary, '[MEMORY_ONLY]');
  assert.equal(snapshot.attributes, 'not-captured');
  assert.equal(snapshot.localStorage, 'disabled');
  assert.equal(snapshot.sessionStorage, 'disabled');
  assert.equal(snapshot.indexedDB, 'not-supported');
  assert.equal(snapshot.cacheStorage, 'not-supported');
  assert.equal(snapshot.quota, 'unavailable');
  assert.equal(JSON.stringify(snapshot).includes('test-a'), false);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_TEST_ONLY'), false);
  assert.equal(fixture.socket.sent.length, 2, 'Raw storage must remain outside transport');
  snapshot.cookieEntryCount = 99;
  assert.equal(controller.webStorageSnapshot().cookieEntryCount, 2, 'Return defensive metadata');
});
test('Storage treats an empty native Cookie list as captured zero entries', async (context) => {
  const fixture = await connectStorage(context);
  fixture.result(async () => '');
  assert.equal(await fixture.controller.captureWebStorage(), true);
  assert.equal(fixture.controller.webStorageSnapshot().cookieEntryCount, 0);
  assert.equal(fixture.controller.state.storagePhase, 'completed');
});
for (const value of ['x'.repeat(4097), 'a=' + '汉'.repeat(1366), 'a=\ud800',
  Array.from({ length: 65 }, (_, i) => 'test' + i + '=fixture').join(';'), 'missing-pair',
  'test=fixture;', '=fixture', null, {}, 3]) {
  test('Storage rejects malformed or oversized Cookie projection ' + typeof value + '-' + String(value).slice(0, 12),
    async (context) => {
      const fixture = await connectStorage(context);
      fixture.result(async () => value);
      assert.equal(await fixture.controller.captureWebStorage(), false);
      assert.equal(fixture.controller.webStorageSnapshot(), undefined);
      assert.equal(fixture.controller.state.storagePhase, 'failed');
      assert.equal(fixture.controller.state.storageReason, 'STORAGE_CAPTURE_FAILED');
    });
}
for (const action of ['navigation', 'source', 'debug', 'incognito', 'expiry', 'rollback', 'background']) {
  test('Storage refuses native Cookie access after ' + action, async (context) => {
    const fixture = await connectStorage(context);
    if (action === 'navigation') { fixture.controller.webPageBegin(controlledWebUrl); }
    if (action === 'source') { fixture.source.controller.getUrl = () => 'https://example.invalid/login'; }
    if (action === 'debug') { globalThis.__kitTest.debug = false; }
    if (action === 'incognito') { fixture.source.controller.isIncognitoMode = () => false; }
    if (action === 'expiry') { context.mock.timers.setTime(now + 600000); }
    if (action === 'rollback') { context.mock.timers.setTime(now - 1); }
    if (action === 'background') { await fixture.controller.stop('APP_BACKGROUND'); }
    assert.equal(await fixture.controller.captureWebStorage(), false);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  });
}
test('Storage timeout clears the snapshot but retains native ownership and discards late values', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebStorage();
  await settle(); assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.controller.state.storagePhase, 'reading');
  context.mock.timers.tick(3000); await settle();
  assert.equal(await waiting, false);
  assert.equal(fixture.controller.state.storagePhase, 'timeout');
  assert.equal(fixture.controller.state.storageNativePending, true);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(await fixture.controller.captureWebDom(), false);
  assert.throws(() => fixture.controller.reviewConsole('1 + 1'), /CONSOLE_CAPTURE_BUSY/);
  await fixture.controller.stop();
  assert.throws(() => fixture.controller.review(fixture.text), /WEB_CAPTURE_BUSY/);
  finish({ toString: () => { throw Error('Late Cookie values must not be projected'); } });
  await settle();
  assert.equal(fixture.controller.state.storageNativePending, false);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
});
test('Storage cancellation during native read does not unlock its owner or restore late metadata', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebStorage(); await settle();
  fixture.controller.cancelWebStorage(); await settle();
  assert.equal(await waiting, false);
  assert.equal(fixture.controller.state.storageNativePending, true);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  finish('test=PRIVATE_TEST_ONLY'); await settle();
  assert.equal(fixture.controller.state.storageNativePending, false);
  assert.equal(fixture.controller.state.storagePhase, 'idle');
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
});
test('Storage snapshot expires synchronously and cannot survive URL or incognito drift', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  context.mock.timers.setTime(now + 30000);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  assert.equal(fixture.controller.state.storagePhase, 'idle');
  context.mock.timers.setTime(now + 31000);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  fixture.source.controller.isIncognitoMode = () => false;
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
});
test('Storage enforces one native read per second and retains the 256-attempt connection budget after cancel', async (context) => {
  const fixture = await connectStorage(context);
  fixture.result(async () => '');
  assert.equal(await fixture.controller.captureWebStorage(), true);
  fixture.controller.cancelWebStorage();
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(fixture.calls.length, 1);
  for (let i = 1; i < 256; i++) {
    context.mock.timers.setTime(now + i * 1000);
    assert.equal(await fixture.controller.captureWebStorage(), true);
    fixture.controller.cancelWebStorage();
  }
  context.mock.timers.setTime(now + 256000);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(fixture.calls.length, 256);
});
for (const action of ['navigation', 'source', 'debug', 'incognito', 'expiry', 'rollback', 'background']) {
  test('Storage discards native settlement after ' + action, async (context) => {
    const fixture = await connectStorage(context);
    let finish;
    fixture.result(() => new Promise((resolve) => { finish = resolve; }));
    const waiting = fixture.controller.captureWebStorage(); await settle();
    if (action === 'navigation') { fixture.controller.webPageBegin(controlledWebUrl); fixture.controller.webPageEnd(controlledWebUrl); }
    if (action === 'source') { fixture.source.controller.getUrl = () => 'https://example.invalid/login'; }
    if (action === 'debug') { globalThis.__kitTest.debug = false; }
    if (action === 'incognito') { fixture.source.controller.isIncognitoMode = () => false; }
    if (action === 'expiry') { context.mock.timers.setTime(now + 600000); }
    if (action === 'rollback') { context.mock.timers.setTime(now - 1); }
    if (action === 'background') { await fixture.controller.stop('APP_BACKGROUND'); }
    finish({ toString: () => { throw Error('Invalidated Cookie projection must not run'); } }); await settle();
    assert.equal(await waiting, false);
    assert.equal(fixture.controller.webStorageSnapshot(), undefined);
    assert.equal(fixture.controller.state.storagePhase, 'idle');
    assert.equal(fixture.controller.state.storageNativePending, false);
  });
}
for (const value of [null, undefined, 'PRIVATE_TEST_ONLY', new Error('PRIVATE_TEST_ONLY')]) {
  test('Storage native rejection is a fixed failure without raw error text ' + typeof value, async (context) => {
    const fixture = await connectStorage(context); fixture.result(() => Promise.reject(value));
    assert.equal(await fixture.controller.captureWebStorage(), false);
    assert.equal(fixture.controller.state.storageReason, 'STORAGE_CAPTURE_FAILED');
    assert.equal(fixture.controller.state.storageNativePending, false);
    assert.equal(JSON.stringify(fixture.controller.state).includes('PRIVATE_TEST_ONLY'), false);
  });
}
test('Storage cancel before dispatch prevents native invocation', async (context) => {
  const fixture = await connectStorage(context);
  const waiting = fixture.controller.captureWebStorage(); fixture.controller.cancelWebStorage();
  await settle();
  assert.equal(await waiting, false); assert.equal(fixture.calls.length, 0);
});
test('Storage budget includes failures and cannot be reset by cancelling', async (context) => {
  const fixture = await connectStorage(context); fixture.result(async () => 'invalid');
  for (let i = 0; i < 256; i++) {
    context.mock.timers.setTime(now + i * 1000);
    assert.equal(await fixture.controller.captureWebStorage(), false);
    assert.equal(fixture.controller.state.storagePhase, 'failed');
    fixture.controller.cancelWebStorage();
  }
  context.mock.timers.setTime(now + 256000); fixture.result(async () => '');
  assert.equal(await fixture.controller.captureWebStorage(), false); assert.equal(fixture.calls.length, 256);
});
test('Storage does not restore an owner after a backward clock returns to normal', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  context.mock.timers.setTime(now - 1);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  context.mock.timers.setTime(now + 1000);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  assert.equal(fixture.calls.length, 1);
});
test('Storage expiration timer uses the original read deadline rather than settlement time', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebStorage(); await settle();
  context.mock.timers.setTime(now + 2000); await settle();
  finish('test=PRIVATE_TEST_ONLY'); await settle(); assert.equal(await waiting, true);
  context.mock.timers.tick(28000); await settle();
  assert.equal(fixture.controller.state.storagePhase, 'idle');
  assert.equal(fixture.controller.state.storageCookieEntries, 0);
});
test('Storage Console execution clears an earlier Cookie snapshot before effects', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  let observed;
  fixture.source.controller.runJavaScriptExt = async () => {
    observed = fixture.controller.webStorageSnapshot();
    return { getType: () => 2, getNumber: () => 2 };
  };
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  assert.equal(await fixture.controller.executeConsole(review.planHash), true);
  assert.equal(observed, undefined); assert.equal(fixture.controller.webStorageSnapshot(), undefined);
});
test('Storage cancellation does not cancel an unrelated native Console wait', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.source.controller.runJavaScriptExt = () => new Promise((resolve) => { finish = resolve; });
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  const waiting = fixture.controller.executeConsole(review.planHash); await settle();
  fixture.controller.cancelWebStorage();
  assert.equal(await fixture.controller.captureWebStorage(), false); assert.equal(fixture.calls.length, 0);
  finish({ getType: () => 2, getNumber: () => 2 }); await settle();
  assert.equal(await waiting, true);
});
test('Storage Console cancellation does not release or cancel an unrelated Cookie wait', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebStorage(); await settle();
  fixture.controller.cancelConsole();
  assert.equal(fixture.controller.state.storageNativePending, true);
  assert.equal(await fixture.controller.captureWebStorage(), false);
  finish('test=PRIVATE_TEST_ONLY'); await settle();
  assert.equal(await waiting, true); assert.equal(fixture.controller.webStorageSnapshot().cookieEntryCount, 1);
});
test('Storage cannot run while a DOM native owner remains pending', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.source.read(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebDom(); await settle();
  assert.equal(await fixture.controller.captureWebStorage(), false); assert.equal(fixture.calls.length, 0);
  context.mock.timers.tick(3000); await settle(); assert.equal(await waiting, false);
  assert.equal(await fixture.controller.captureWebStorage(), false); assert.equal(fixture.calls.length, 0);
  finish('{}'); await settle();
});
test('Storage keeps the screenshot native API untouched during a Cookie read', async (context) => {
  const fixture = await connectStorage(context, true);
  fixture.controller.reviewScreenshot();
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebStorage(); await settle();
  assert.equal(await fixture.controller.confirmScreenshot(), false);
  fixture.controller.cancelWebStorage(); await settle(); assert.equal(await waiting, false);
  assert.equal(await fixture.controller.confirmScreenshot(), false);
  finish(''); await settle();
});
test('Storage valid boundary does not conflate same-name URL-related cookies', async (context) => {
  const fixture = await connectStorage(context);
  fixture.result(async () => 'a=' + 'x'.repeat(4094));
  assert.equal(await fixture.controller.captureWebStorage(), true);
  context.mock.timers.setTime(now + 1000);
  fixture.result(async () => Array.from({ length: 64 }, () => 'test=').join('; '));
  assert.equal(await fixture.controller.captureWebStorage(), true);
  assert.equal(fixture.controller.webStorageSnapshot().cookieEntryCount, 64);
});
test('Storage visible native pending tracks a Console owner through cancellation and settlement', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.source.controller.runJavaScriptExt = () => new Promise((resolve) => { finish = resolve; });
  const review = fixture.controller.reviewConsole('1 + 1'); fixture.controller.confirmConsole(review.planHash);
  const waiting = fixture.controller.executeConsole(review.planHash); await settle();
  assert.equal(fixture.controller.state.storageNativePending, true);
  fixture.controller.cancelConsole(); await settle(); assert.equal(await waiting, false);
  assert.equal(fixture.controller.state.storageNativePending, true);
  finish({ getType: () => { throw Error('Late getter must not run'); } }); await settle();
  assert.equal(fixture.controller.state.storageNativePending, false);
});
test('Storage and Console visible native pending track a Cookie owner until settlement', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.result(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebStorage(); await settle();
  assert.equal(fixture.controller.state.consoleNativePending, true);
  fixture.controller.cancelWebStorage(); await settle(); assert.equal(await waiting, false);
  assert.equal(fixture.controller.state.consoleNativePending, true);
  finish(''); await settle();
  assert.equal(fixture.controller.state.consoleNativePending, false);
});
test('Storage visible native pending tracks a DOM timeout until native settlement', async (context) => {
  const fixture = await connectStorage(context);
  let finish;
  fixture.source.read(() => new Promise((resolve) => { finish = resolve; }));
  const waiting = fixture.controller.captureWebDom(); await settle();
  assert.equal(fixture.controller.state.storageNativePending, true);
  context.mock.timers.tick(3000); await settle(); assert.equal(await waiting, false);
  assert.equal(fixture.controller.state.storageNativePending, true);
  finish('{}'); await settle();
  assert.equal(fixture.controller.state.storageNativePending, false);
});
test('Storage snapshot cannot escape a later source recheck during state projection', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  let reads = 0;
  fixture.source.controller.getUrl = () => ++reads === 1 ? controlledWebUrl : 'https://example.invalid/login';
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
  assert.equal(fixture.controller.state.storageCookieEntries, 0);
  assert.equal(fixture.controller.state.storagePhase, 'idle');
});

const cookieMetadataSummary = 'url-related-incognito-unpartitioned;attributes-not-captured;local-session-disabled;' +
  'indexeddb-cache-not-supported;quota-unavailable;[MEMORY_ONLY]';
test('Storage publishing requires a current read, sends only bounded metadata and shares ACK ownership', async (context) => {
  const fixture = await connectStorage(context);
  const { controller, accepted, socket } = fixture;
  assert.equal(await controller.publishWebStorage(), false);
  assert.equal(fixture.calls.length, 0);
  assert.equal(await controller.captureWebStorage(), true);
  assert.equal(socket.sent.length, 2, 'Reading alone must not persist Storage history');
  assert.equal(await controller.publishWebStorage(), true);
  const event = EventEnvelopeSchema.parse(accepted.channel.open(socket.sent.at(-1)));
  assert.equal(event.channel, 'arkweb.storage'); assert.equal(event.capability, 'arkweb.storage.read');
  assert.equal(event.sequence, 1); assert.equal(controller.state.unacknowledged, 1);
  assert.deepEqual(event.payload, { targetId: 'web-main', entryCount: 2, summary: cookieMetadataSummary });
  assert.equal(await controller.publishWebStorage(), false);
  assert.equal(await controller.captureUi(), false);
  const file = controller.webStorageFile();
  assert.equal(file.path, 'arkweb.jsonl'); assert.equal(file.records.length, 1);
  assert.deepEqual(file.source, { id: 'registered-web-cookie', kind: 'platform-api',
    api: 'WebCookieManager.fetchCookie', provenance: 'peer-reported' });
  assert.equal(file.records[0].fingerprint, undefined);
  assert.equal(file.status, 'summary-only'); assert.equal(file.sampled, true);
  const { fingerprint: _fingerprint, ...identity } = accepted.negotiated.identity;
  buildKitProfile({ files: [file] }, identity);
  assert.equal(JSON.stringify(file).includes('PRIVATE_TEST_ONLY'), false);
  assert.equal(JSON.stringify(file).includes('test-a'), false);
  file.records[0].payload.entryCount = 99;
  assert.equal(controller.webStorageFile().records[0].payload.entryCount, 2);
  acknowledge(fixture, 1); await settle();
  assert.equal(await controller.publishWebStorage(), false, 'A read may be published only once');
  assert.equal(await controller.captureUi(), true);
  assert.equal(accepted.channel.open(socket.sent.at(-1)).sequence, 2);
});
test('Storage published zero Cookies remains one captured summary record', async (context) => {
  const fixture = await connectStorage(context); fixture.result(async () => '');
  assert.equal(await fixture.controller.captureWebStorage(), true);
  assert.equal(await fixture.controller.publishWebStorage(), true);
  const event = fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  assert.equal(event.payload.entryCount, 0);
  assert.equal(fixture.controller.webStorageFile().records.length, 1);
});
for (const action of ['cancel', 'navigate', 'url', 'incognito', 'debug', 'expire', 'rollback', 'stop']) {
  test('Storage cannot publish or export stale metadata after ' + action, async (context) => {
    const fixture = await connectStorage(context);
    assert.equal(await fixture.controller.captureWebStorage(), true);
    assert.equal(await fixture.controller.publishWebStorage(), true);
    fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
    if (action === 'cancel') { fixture.controller.cancelWebStorage(); }
    if (action === 'navigate') { fixture.controller.webPageBegin(controlledWebUrl); }
    if (action === 'url') { fixture.source.controller.getUrl = () => 'https://example.invalid/changed'; }
    if (action === 'incognito') { fixture.source.controller.isIncognitoMode = () => false; }
    if (action === 'debug') { globalThis.__kitTest.debug = false; }
    if (action === 'expire') { context.mock.timers.setTime(now + 30000); }
    if (action === 'rollback') { context.mock.timers.setTime(now - 1); }
    if (action === 'stop') { await fixture.controller.stop(); }
    assert.equal(fixture.controller.webStorageFile(), undefined);
    assert.equal(await fixture.controller.publishWebStorage(), false);
  });
}
test('Storage send failure clears both local count and export evidence without claiming ACK', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  fixture.socket.send = async () => false;
  assert.equal(await fixture.controller.publishWebStorage(), false);
  assert.equal(fixture.controller.state.phase, 'stopped');
  assert.equal(fixture.controller.webStorageFile(), undefined);
  assert.equal(fixture.controller.webStorageSnapshot(), undefined);
});
test('Storage capture replacement clears published evidence and requires a new explicit send', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  assert.equal(await fixture.controller.publishWebStorage(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
  context.mock.timers.setTime(now + 1000);
  fixture.result(async () => 'new=TEST_ONLY');
  assert.equal(await fixture.controller.captureWebStorage(), true);
  assert.equal(fixture.controller.webStorageFile(), undefined);
  assert.equal(await fixture.controller.publishWebStorage(), true);
  assert.equal(fixture.accepted.channel.open(fixture.socket.sent.at(-1)).sequence, 2);
  assert.equal(fixture.controller.webStorageFile().records[0].payload.entryCount, 1);
  assert.equal(fixture.controller.webStorageFile().dropped, 1);
});
test('Storage explicit export includes the sent metadata, unknown domains and no raw Cookie data', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureCpu(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
  assert.equal(await fixture.controller.captureWebStorage(), true);
  fixture.controller.reviewExport();
  assert.equal(fixture.controller.state.exportWebStorage, false, 'Unsent local snapshots are not manufactured as Kit records');
  fixture.controller.cancelExport();
  assert.equal(await fixture.controller.publishWebStorage(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  fixture.controller.reviewExport(); assert.equal(fixture.controller.state.exportWebStorage, true);
  const destination = path.join(temporary, 'storage-export.zip');
  globalThis.__kitTest.save = async () => [destination];
  await fixture.controller.confirmExport({});
  const bytes = await readFile(destination);
  const result = verifyProblemPackage(bytes);
  const signal = new AbortController().signal;
  const zip = await readProblemZipAt(bytes.length, async (offset, length) => bytes.subarray(offset, offset + length), signal);
  const page = await verifyProblemArchive(zip, signal, { domain: 'arkweb', after: 0, limit: 256 });
  assert.equal(result.kit.files.find((file) => file.domain === 'arkweb').source.api, 'WebCookieManager.fetchCookie');
  assert.equal(result.kit.domains.find((domain) => domain.domain === 'arkweb').count, 1);
  assert.equal(result.kit.domains.find((domain) => domain.domain === 'web-targets').status, 'not-captured');
  assert.equal(page.kitPage.records[0].record.payload.summary, cookieMetadataSummary);
  assert.equal(page.kitPage.records[0].record.payload.entryCount, 2);
  assert.equal(result.session.deviceProvenance, 'peer-asserted');
  for (const text of ['PRIVATE_TEST_ONLY', 'SECOND_TEST_ONLY', 'test-a', controlledWebUrl]) {
    assert.equal(bytes.includes(Buffer.from(text)), false);
  }
});
for (const action of ['cancel', 'expire', 'source', 'replacement', 'console']) {
  test('Storage frozen export cannot survive ' + action + ' while the Picker is pending', async (context) => {
    const fixture = await connectStorage(context);
    assert.equal(await fixture.controller.captureCpu(), true);
    fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
    assert.equal(await fixture.controller.captureWebStorage(), true);
    assert.equal(await fixture.controller.publishWebStorage(), true);
    fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 2); await settle();
    fixture.controller.reviewExport(); assert.equal(fixture.controller.state.exportWebStorage, true);
    let resolve;
    globalThis.__kitTest.save = () => new Promise((done) => { resolve = done; });
    const destination = path.join(temporary, 'storage-revoked-' + action + '.zip');
    const saving = fixture.controller.confirmExport({}); await settle(); assert.equal(typeof resolve, 'function');
    if (action === 'cancel') { fixture.controller.cancelWebStorage(); }
    if (action === 'expire') { context.mock.timers.setTime(now + 30000); }
    if (action === 'source') { fixture.source.controller.isIncognitoMode = () => false; }
    if (action === 'replacement') {
      context.mock.timers.setTime(now + 1000);
      assert.equal(await fixture.controller.captureWebStorage(), true);
    }
    if (action === 'console') {
      fixture.source.controller.runJavaScriptExt = async () => ({ getType: () => 2, getNumber: () => 0 });
      const review = fixture.controller.reviewConsole('0'); fixture.controller.confirmConsole(review.planHash);
      assert.equal(await fixture.controller.executeConsole(review.planHash), true);
    }
    resolve([destination]); await saving;
    assert.equal(fs.existsSync(destination), false, 'Revoked metadata must not reach FileIO');
    assert.notEqual(fixture.controller.state.exportPhase, 'saved');
  });
}
for (const action of ['cancel', 'source', 'expiry', 'stop']) {
  test('Storage late transport completion never restores evidence after ' + action, async (context) => {
    const fixture = await connectStorage(context);
    assert.equal(await fixture.controller.captureWebStorage(), true);
    let resolve;
    const originalSend = fixture.socket.send.bind(fixture.socket);
    fixture.socket.send = async (text) => { await originalSend(text); return new Promise((done) => { resolve = done; }); };
    const publishing = fixture.controller.publishWebStorage(); await settle();
    fixture.accepted.channel.open(fixture.socket.sent.at(-1));
    assert.equal(typeof resolve, 'function'); assert.equal(fixture.controller.webStorageFile(), undefined);
    if (action === 'cancel') { fixture.controller.cancelWebStorage(); }
    if (action === 'source') { fixture.source.controller.isIncognitoMode = () => false; }
    if (action === 'expiry') { context.mock.timers.setTime(now + 30000); }
    if (action === 'stop') { await fixture.controller.stop(); }
    resolve(true); assert.equal(await publishing, false);
    assert.equal(fixture.controller.webStorageFile(), undefined);
    assert.equal(await fixture.controller.publishWebStorage(), false);
  });
}
test('Storage sending does not renew the dispatch expiry and cannot bypass a pending metrics owner', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureWebStorage(), true);
  context.mock.timers.setTime(now + 29000);
  assert.equal(await fixture.controller.publishWebStorage(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
  context.mock.timers.setTime(now + 30000);
  assert.equal(fixture.controller.webStorageFile(), undefined);
  let finish;
  globalThis.__kitTest.cpu = () => new Promise((done) => { finish = done; });
  const cpu = fixture.controller.captureCpu(); await settle();
  assert.equal(await fixture.controller.publishWebStorage(), false);
  finish(10); await cpu;
});
test('Storage archive rejects fabricated attributes, values, source, scope, counts and clocks before building bytes', async (context) => {
  const fixture = await connectStorage(context);
  assert.equal(await fixture.controller.captureCpu(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1)); acknowledge(fixture, 1); await settle();
  assert.equal(await fixture.controller.captureWebStorage(), true);
  assert.equal(await fixture.controller.publishWebStorage(), true);
  fixture.accepted.channel.open(fixture.socket.sent.at(-1));
  const bridge = path.dirname(controllerEntry);
  const output = path.join(temporary, 'storage-archive-validation.mjs');
  await build({ stdin: { contents: "export { makeMemoryProblem } from './KitProblemArchive';",
    resolveDir: bridge, loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'esm',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'] });
  const { makeMemoryProblem } = await import(pathToFileURL(output));
  const memory = fixture.controller.memoryFile();
  for (const alter of [
    (file) => { file.records[0].payload.value = 'PRIVATE_TEST_ONLY'; },
    (file) => { file.records[0].payload.attributes = { httpOnly: true }; },
    (file) => { file.records[0].payload.entryCount = 65; },
    (file) => { file.records[0].payload.entryCount = -1; },
    (file) => { file.records[0].payload.entryCount = 0.5; },
    (file) => { file.records[0].payload.summary += ';PRIVATE_TEST_ONLY'; },
    (file) => { file.records[0].payload.targetId = 'foreign'; },
    (file) => { file.records[0].sessionEpoch = 'foreign'; },
    (file) => { file.records[0].channel = 'arkweb.dom'; },
    (file) => { file.source.api = 'WebStorage.getOrigins'; },
    (file) => { file.source.kind = 'registered-adapter'; },
    (file) => { file.records[0].sequence = 0; },
    (file) => { file.records[0].fingerprint = '0'.repeat(64); },
    (file) => { file.records[0].clockId = 'foreign'; },
    (file) => { file.records[0].monotonicNs = '-1'; },
    (file) => { file.records[0].wallTimeUtc = 'invalid'; },
    (file) => { file.dropped = file.records[0].sequence; },
  ]) {
    const storage = fixture.controller.webStorageFile(); alter(storage);
    assert.throws(() => makeMemoryProblem(memory, new NodePort(), undefined, undefined,
      { dom: undefined, console: undefined, navigation: undefined, storage }), /EXPORT_SAMPLE_INVALID/);
  }
});
// Register dependent fixtures after every top-level constant is initialized.
registerSemanticReplayControllerTests({ connectSnapshot, NodePort });
registerSemanticReplayPageTests({ ProducerPage, setProducer: (value) => { pageProducer = value; } });
registerM3ControllerConsentTests({ connectConsole, connectNetwork, bodyRule, bodyOptions, bodyResponse, bodyUrl, now, settle });
});
