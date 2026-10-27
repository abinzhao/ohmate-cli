/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Real private files, actual ETS save host/owner, substituted SDK transport.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'ohmate-archive-file-'));
const states = [], handles = new Map(), uriStates = new Map();
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
};
globalThis.canIUse = () => true;
globalThis.__ArchiveNative = {
  async select(context, bound, options) {
    const state = context.state;
    assert.equal(bound, state.bound);
    assert.equal(options.autoCreateEmptyFile, false);
    assert.deepEqual(options.newFileNames, ['problem-1.ohmate-problem.zip']);
    state.calls.push('picker');
    if (state.pickPending) { state.pickSeen.resolve(); await state.pickPending.promise; }
    return state.uris ?? [state.uri];
  },
  async open(uri, flags) {
    const state = uriStates.get(uri); assert(state, 'only private Picker destinations');
    assert.equal(flags & constants.O_TRUNC, 0, 'must not truncate');
    state.calls.push('open');
    const handle = await open(fileURLToPath(uri), flags, 0o600);
    handles.set(handle.fd, { handle, state }); return { fd: handle.fd };
  },
  async stat(fd) {
    const entry = handles.get(fd), stat = await entry.handle.stat();
    entry.state.calls.push('stat'); return stat;
  },
  async write(fd, buffer) {
    const { handle, state } = handles.get(fd);
    state.calls.push('write');
    if (state.writePending) { state.writeSeen.resolve(); await state.writePending.promise; }
    if (state.failWrite) throw Error('private-write-failure');
    const count = Math.min(buffer.byteLength, state.partial ?? buffer.byteLength);
    if (count === 0) return 0;
    return (await handle.write(new Uint8Array(buffer), 0, count)).bytesWritten;
  },
  async fsync(fd) {
    const { handle, state } = handles.get(fd); state.calls.push('fsync'); await handle.sync();
  },
  async close(file) {
    const { handle, state } = handles.get(file.fd);
    state.calls.push('close'); assert.equal(file.fd, handle.fd);
    if (state.failClose) throw Error('private-close-failure');
    await handle.close(); handles.delete(file.fd);
  },
};
await build({
  entryPoints: [
    fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/host-integration/HarmonyArchiveSaveHost.ets', import.meta.url)),
    fileURLToPath(new URL('../kit/ohmatekit/src/main/ets/host-integration/ArchiveSaveOwner.ets', import.meta.url)),
  ],
  outdir: path.join(directory, 'built'), bundle: true, platform: 'node', format: 'esm',
  outExtension: { '.js': '.mjs' }, loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts'],
  plugins: [{ name: 'owned-file-sdk', setup(builder) {
    builder.onResolve({ filter: /^@kit\./ }, args => ({ path: args.path, namespace: 'shim' }));
    builder.onLoad({ filter: /.*/, namespace: 'shim' }, args => ({
      contents: args.path === '@kit.CoreFileKit' ?
        'export const picker={DocumentViewPicker:class{constructor(context,bound){this.context=context;this.bound=bound}' +
        'save(options){return globalThis.__ArchiveNative.select(this.context,this.bound,options)}}};' +
        'export const fileIo={OpenMode:{READ_WRITE:2,CREATE:512*8,NOFOLLOW:256,NONBLOCK:4},' +
        'open:(...args)=>globalThis.__ArchiveNative.open(...args),stat:(fd)=>globalThis.__ArchiveNative.stat(fd),' +
        'write:(...args)=>globalThis.__ArchiveNative.write(...args),fsync:(fd)=>globalThis.__ArchiveNative.fsync(fd),' +
        'close:(file)=>globalThis.__ArchiveNative.close(file)};' : '',
      loader: 'js',
    }));
  } }],
});
// Node flags are obtained explicitly; shim must use actual platform flags.
const { constants } = await import('node:fs');
// Replace the open facade to translate declared SDK flags without weakening NOFOLLOW.
const originalOpen = globalThis.__ArchiveNative.open;
globalThis.__ArchiveNative.open = (uri, flags) => {
  assert.equal(flags, 2 | 4096 | 256 | 4);
  return originalOpen(uri, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK);
};
const { HarmonyArchiveSaveHost } = await import(pathToFileURL(path.join(directory, 'built/HarmonyArchiveSaveHost.mjs')));
const { ArchiveSaveOwner } = await import(pathToFileURL(path.join(directory, 'built/ArchiveSaveOwner.mjs')));
async function subject(initial) {
  const destination = path.join(directory, 'document-' + states.length);
  if (initial !== undefined) await writeFile(destination, initial, { mode: 0o600 });
  const state = { destination, uri: pathToFileURL(destination).href, bound: {}, calls: [],
    pickSeen: deferred(), writeSeen: deferred() };
  const host = new HarmonyArchiveSaveHost({ state }, state.bound);
  const owner = new ArchiveSaveOwner(host, () => 100);
  state.owner = owner; states.push(state); uriStates.set(state.uri, state); return state;
}
const save = (state, bytes = new Uint8Array([80, 75, 3, 4])) =>
  state.owner.save(bytes, 'problem-1.ohmate-problem.zip', () => true);
after(async () => {
  for (const state of states) {
    state.failClose = false; state.pickPending?.resolve(); state.writePending?.resolve();
    state.owner.cancel(); await settle();
    for (let index = 0; index < 20 && state.owner.getState() === 'cleanup-required'; index++) {
      await state.owner.retryCleanup(); await new Promise(done => setImmediate(done));
    }
  }
  assert.equal(handles.size, 0, 'all native file owners released before private tree removal');
  delete globalThis.__ArchiveNative; delete globalThis.canIUse;
  await rm(directory, { recursive: true, force: true });
});
test('SDK save writes exact private-file bytes through short writes, fsync and original close', async () => {
  const state = await subject(); state.partial = 2;
  const bytes = new Uint8Array([80, 75, 3, 4, 10, 20, 30]);
  assert.equal(await save(state, bytes), 'SAVE_HOST_REPORTED');
  assert.deepEqual([...await readFile(state.destination)], [...bytes]);
  assert.equal(state.calls.filter(call => call === 'write').length, 4);
  assert.deepEqual(state.calls.slice(-2), ['fsync', 'close']);
});
test('an existing nonempty document is rejected without truncation, overwrite or deletion', async () => {
  const state = await subject('original-public-fixture');
  assert.equal(await save(state), 'SAVE_FAILED');
  assert.equal(await readFile(state.destination, 'utf8'), 'original-public-fixture');
  assert(!state.calls.includes('write') && !state.calls.includes('fsync'));
});
test('late Picker after cancellation creates no file and remains for explicit cleanup', async () => {
  const state = await subject(); state.pickPending = deferred();
  const saving = save(state); await state.pickSeen.promise;
  state.owner.cancel(); assert.equal(await saving, 'SAVE_CANCELLED');
  state.pickPending.resolve(); await settle();
  assert.equal(state.calls.includes('open'), false);
  await assert.rejects(readFile(state.destination), { code: 'ENOENT' });
  assert.equal(await state.owner.retryCleanup(), true);
});
test('failed close retains the exact real descriptor until explicit cleanup; no extra write', async () => {
  const state = await subject(); state.failClose = true;
  assert.equal(await save(state), 'SAVE_CLEANUP_REQUIRED');
  assert.equal(handles.size, 1);
  const calls = state.calls.length; state.owner.getState(); assert.equal(state.calls.length, calls);
  state.failClose = false; assert.equal(await state.owner.retryCleanup(), true);
  assert.equal(handles.size, 0); assert.equal(state.calls.filter(call => call === 'write').length, 1);
});
test('a cancelled pending short write cannot fsync or continue; cleanup keeps the partial user file', async () => {
  const state = await subject(); state.partial = 2; state.writePending = deferred();
  const saving = save(state); await state.writeSeen.promise;
  state.owner.cancel(); assert.equal(await saving, 'SAVE_CANCELLED');
  assert.equal(await state.owner.retryCleanup(), false);
  state.writePending.resolve();
  for (let index = 0; index < 20; index++) await new Promise(done => setImmediate(done));
  assert.equal(await state.owner.retryCleanup(), true);
  assert.deepEqual([...await readFile(state.destination)], [80, 75]);
  assert.equal(state.calls.filter(call => call === 'write').length, 1);
  assert.equal(state.calls.includes('fsync'), false);
});
test('zero writes and native failures preserve visible failure and close without automatic resume', async () => {
  for (const failure of ['zero', 'throw']) {
    const state = await subject(); state.partial = 0; state.failWrite = failure === 'throw';
    assert.equal(await save(state), 'SAVE_FAILED');
    assert.equal(state.calls.filter(call => call === 'write').length, 1);
    assert.deepEqual([...await readFile(state.destination)], []);
    assert.equal(state.calls.includes('fsync'), false);
  }
});
test('missing SysCap and malformed destinations never open user files', async () => {
  const absent = await subject(); globalThis.canIUse = () => false;
  try { assert.equal(await save(absent), 'SAVE_UNAVAILABLE'); } finally { globalThis.canIUse = () => true; }
  assert.equal(absent.calls.length, 0);
  for (const uris of [['https://example.invalid/file'], ['file://a', 'file://b'], ['file://a\n']]) {
    const state = await subject(); state.uris = uris;
    assert.equal(await save(state), 'SAVE_FAILED'); assert.equal(state.calls.includes('open'), false);
  }
});
