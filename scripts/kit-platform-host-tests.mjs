/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
// Actual ETS and private Node files. The Kit API shim is not device evidence.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = await fs.mkdtemp(path.join(tmpdir(), 'ohmate-platform-host-'));
const subjects = [];
const nativeCanIUse = globalThis.canIUse;
globalThis.canIUse = name => !sdk.state.unsupported.has(name);
after(() => {
  if (nativeCanIUse === undefined) delete globalThis.canIUse;
  else globalThis.canIUse = nativeCanIUse;
});
after(async () => {
  await api?.OHMateKit?.dispose();
  for (const host of subjects) await host.dispose();
  assert.equal(sdk.state.fds.size, 0); assert.equal(sdk.state.locks.size, 0);
});
after(() => fs.rm(directory, { recursive: true, force: true }));
const shim = path.join(directory, 'sdk-shim.mjs');
await fs.writeFile(shim, `
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const handles = new Map(), locks = new Map(); let number = 100;
export const state = { failSync: false, partial: false, fds: handles, locks, writes: 0, tick: 1000, wallOffset:0,
  failSyncPath: '', failIndexRename: false, failUnlinkAfter: -1, unlinks: 0, unsupported: new Set(),
  failDataOpen: 0, failDataRename: 0, failTempRmdir: 0, failPublishedStat: 0,
  syncPending: undefined, syncEntered: undefined, readPending: undefined, readEntered: undefined };
const absent = error => { if (error.code === 'ENOENT') error.code = 13900002; throw error; };
const stat = s => ({ size: s.size, mtime: s.mtimeMs / 1000,
  isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink() });
export const fileIo = {
  OpenMode: { READ_ONLY:0, WRITE_ONLY:1, READ_WRITE:2, CREATE:64, TRUNC:512, DIR:65536, NOFOLLOW:131072, NONBLOCK:2048 },
  async lstat(p) {
    if (p.endsWith('/problems/problem-retry.json') && state.failPublishedStat-- > 0) throw Error('stat');
    return fs.lstat(p).then(stat).catch(absent);
  },
  async stat(fd) { return (await handles.get(fd).handle.stat()).isFile ?
    stat(await handles.get(fd).handle.stat()) : undefined; },
  async mkdir(p) { return fs.mkdir(p, { mode: 0o700 }); },
  async mkdtemp(p) { return fs.mkdtemp(p.replace(/XXXXXX$/, '')); },
  async listFile(p, options) { return (await fs.readdir(p)).slice(0, options?.listNum || undefined); },
  async open(p, mode = 0) {
    if (p.endsWith('/data') && state.failDataOpen-- > 0) throw Error('open');
    const s = await fs.lstat(p).catch(e => e.code === 'ENOENT' ? undefined : Promise.reject(e));
    if (mode & 131072 && s?.isSymbolicLink()) throw Error('symlink');
    const handle = await fs.open(p, mode & 64 ? (mode & 512 ? 'w+' : 'a+') : mode & 3 ? 'r+' : 'r', 0o600);
    const fd = ++number, item = { fd, handle, path: p };
    item.tryLock = () => { if (locks.has(p)) throw Error('locked'); locks.set(p, fd); };
    item.unlock = () => { if (locks.get(p) === fd) locks.delete(p); };
    handles.set(fd, item); return item;
  },
  async read(fd, buffer) {
    if (state.readPending) { const pending = state.readPending; state.readPending = undefined;
      state.readEntered?.(); await pending; }
    return (await handles.get(fd).handle.read(new Uint8Array(buffer), 0, buffer.byteLength)).bytesRead;
  },
  async write(fd, buffer) {
    state.writes++; const b = typeof buffer === 'string' ? Buffer.from(buffer) : Buffer.from(buffer);
    return (await handles.get(fd).handle.write(b.subarray(0, state.partial ? Math.max(1, b.length >>> 1) : b.length))).bytesWritten;
  },
  async fsync(fd) {
    if (state.syncPending) { const pending = state.syncPending; state.syncPending = undefined;
      state.syncEntered?.(); await pending; }
    if (state.failSync || state.failSyncPath && handles.get(fd).path.endsWith(state.failSyncPath)) throw Error('sync');
    await handles.get(fd).handle.sync();
  },
  async close(f) { const item = handles.get(typeof f === 'number' ? f : f.fd); item.unlock(); await item.handle.close(); handles.delete(item.fd); },
  async rename(a,b) {
    if (state.failIndexRename && b.endsWith('/index.json')) throw Error('index');
    if (a.endsWith('/data') && state.failDataRename-- > 0) throw Error('rename');
    await fs.rename(a,b);
  },
  async unlink(p) {
    if (state.failUnlinkAfter >= 0 && state.unlinks++ >= state.failUnlinkAfter) throw Error('unlink');
    await fs.unlink(p).catch(absent);
  },
  async rmdir(p) {
    if (p.includes('/temp/') && state.failTempRmdir-- > 0) throw Error('rmdir');
    await fs.rmdir(p).catch(absent);
  }
};
export const util = { generateRandomUUID: () => randomUUID(),
  TextEncoder: class { static create() { return new this(); } encodeInto(input) { return new TextEncoder().encode(input); } },
  TextDecoder: class { static create() { return new this(); } decodeToString(data) { return new TextDecoder('utf-8', { fatal:true }).decode(data); } } };
export const systemDateTime = { TimeType: { STARTUP:0 }, getUptime: () => state.tick, getTime: () => Date.now() + state.wallOffset };
export const cryptoFramework = { createMd: () => { const hash = createHash('sha256');
  return { updateSync: ({data}) => hash.update(data), digestSync: () => ({data:new Uint8Array(hash.digest())}) }; } };
`, { flag: 'wx', mode: 0o600 });
const sdk = await import(pathToFileURL(shim));
let api;
try {
  await build({ entryPoints: [fileURLToPath(new URL('../kit/ohmatekit/Index.ets', import.meta.url))],
    outfile: path.join(directory, 'kit.mjs'), bundle: true, format: 'esm', platform: 'node',
    loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'],
    plugins: [{ name: 'private-kit-shim', setup(builder) {
      builder.onResolve({ filter: /^@kit\./ }, () => ({ path: shim, external: true }));
    } }] });
  api = await import(pathToFileURL(path.join(directory, 'kit.mjs')));
} catch (_) {}
test('single HAR exposes the production context start and sandbox host', () => {
  assert.equal(typeof api?.OHMateKit?.start, 'function');
  assert.equal(typeof api?.HarmonySandboxHost, 'function');
});
if (api?.HarmonySandboxHost) {
  async function host(filesDir) {
    filesDir ??= await fs.mkdtemp(path.join(directory, 'sandbox-'));
    const item = new api.HarmonySandboxHost(filesDir, new api.CoreOptions());
    subjects.push(item); await item.recover(); return item;
  }
  const envelope = (item, sequence = 1) => {
    const payload = JSON.stringify({ schemaVersion: '1.0', sessionId: item.sessionId(), buildId: '',
      buildVerification: 'unverified-build', firstSequence: sequence, lastSequence: sequence,
      events: [{ sequence, name: 'active', priority: 'high', source: 'recorder',
        sessionId: item.sessionId(), clock: item.now(), fields: {} }],
      loss: { dropped:0, criticalDropped:0, firstSequence:0, lastSequence:0, rangeKind:'envelope' } });
    return JSON.stringify({ schemaVersion:'1.0', bytes:item.byteLength(payload), sha256:item.hash(payload), payload });
  };
  test('sandbox segments survive restart and a corrupt derived index is rebuilt', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'restart-'));
    const first = await host(filesDir), text = envelope(first);
    assert.equal(await first.append(text), 'synced');
    await first.dispose();
    await fs.writeFile(path.join(filesDir, 'ohmate-kit', 'index.json'), 'corrupt');
    const second = await host(filesDir);
    assert.deepEqual(await second.recover(), [text]);
    assert.equal(JSON.parse(await fs.readFile(path.join(filesDir, 'ohmate-kit', 'index.json'))).schemaVersion, '1.1');
    await second.dispose();
  });
  test('an uncertain segment is reconciled by content without duplicate append', async () => {
    const item = await host(), text = envelope(item);
    sdk.state.failSync = true;
    assert.equal(await item.append(text), 'uncertain');
    sdk.state.failSync = false;
    assert.equal(await item.append(text), 'synced');
    assert.deepEqual(await item.recover(), [text]);
    await item.dispose();
  });
  test('a staged retry cannot replace its payload or bypass the original byte reservation', async () => {
    const item = await host(), first = '{"first":true}';
    try {
      sdk.state.failSync = true;
      assert.equal(await item.saveProblem('problem-staged', first), 'uncertain');
      const reserved = item.accountedStorageBytes();
      sdk.state.failSync = false;
      assert.equal(await item.saveProblem('problem-staged', '{"replacement":"' + 'x'.repeat(5000) + '"}'), 'uncertain');
      assert.equal(item.accountedStorageBytes(), reserved);
      assert.equal(await item.saveProblem('problem-staged', first), 'synced');
      assert.deepEqual(await item.recoverProblems(), [first]);
    } finally { sdk.state.failSync = false; await item.dispose(); }
  });
  test('partial writes complete before publishing and problems recover by verified envelopes', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'partial-')), item = await host(filesDir);
    sdk.state.partial = true;
    assert.equal(await item.saveProblem('problem-test-1', '{"redacted":true}'), 'synced');
    sdk.state.partial = false;
    await item.dispose();
    const next = await host(filesDir);
    assert.deepEqual(await next.recoverProblems(), ['{"redacted":true}']);
    assert.equal(await next.deleteProblem('problem-test-1'), true);
    assert.deepEqual(await next.recoverProblems(), []);
    await next.dispose();
  });
  test('a second sandbox owner cannot steal the file lock', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'lock-')), first = await host(filesDir);
    const second = new api.HarmonySandboxHost(filesDir, new api.CoreOptions()); subjects.push(second);
    await assert.rejects(second.recover());
    await second.dispose();
    assert(sdk.state.locks.size > 0);
    await first.dispose();
    const third = await host(filesDir); await third.dispose();
  });
  test('sandbox symlinks and path escapes never write outside the owned root', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'symlink-'));
    const outside = await fs.mkdtemp(path.join(directory, 'outside-'));
    await fs.symlink(outside, path.join(filesDir, 'ohmate-kit'));
    const item = new api.HarmonySandboxHost(filesDir, new api.CoreOptions()); subjects.push(item);
    await assert.rejects(item.recover());
    assert.deepEqual(await fs.readdir(outside), []);
    await item.dispose();
    const normal = await host();
    assert.equal(await normal.saveProblem('../private', '{}'), 'uncertain');
    await normal.dispose();
  });
  test('disposal bounds its wait and keeps pending native ownership until the callback finishes', async () => {
    const item = await host();
    let release, entered;
    sdk.state.syncPending = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    sdk.state.syncEntered = entered;
    const operation = item.append(envelope(item));
    await ready;
    try {
      await item.dispose();
      assert.equal(item.resourcesReleased(), false);
      assert(sdk.state.fds.size > 0 && sdk.state.locks.size > 0);
    } finally { release(); sdk.state.syncEntered = undefined; }
    assert.equal(await operation, 'uncertain');
    await item.dispose();
    assert.equal(item.resourcesReleased(), true);
  });
  test('host configuration is copied and cannot expand its disk quota after construction', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'immutable-'));
    const options = new api.CoreOptions(); options.maxStorageBytes = 65536;
    const item = new api.HarmonySandboxHost(filesDir, options); subjects.push(item); await item.recover();
    options.maxStorageBytes = 5242880;
    const segment = JSON.parse(JSON.parse(envelope(item)).payload);
    segment.padding = 'x'.repeat(50000);
    const payload = JSON.stringify(segment);
    const text = JSON.stringify({ schemaVersion:'1.0', bytes:item.byteLength(payload), sha256:item.hash(payload), payload });
    assert.equal(await item.append(text), 'uncertain');
    await item.dispose();
  });
  test('long system uptime uses a precise session delta and detects rollback', async () => {
    sdk.state.tick = 200 * 86400000;
    const item = await host(), first = item.now();
    assert(Number.isSafeInteger(first.monotonicNs));
    sdk.state.tick += 3;
    assert.equal(item.now().monotonicNs - first.monotonicNs, 3000000);
    sdk.state.tick -= 4;
    assert.throws(() => item.now());
    sdk.state.tick = 1000; await item.dispose();
  });
  test('missing storage, clock or digest SysCaps cannot start a sandbox recorder', async () => {
    for (const capability of ['SystemCapability.FileManagement.File.FileIO', 'SystemCapability.MiscServices.Time',
      'SystemCapability.Security.CryptoFramework']) {
      const filesDir = await fs.mkdtemp(path.join(directory, 'syscap-'));
      sdk.state.unsupported.add(capability);
      try {
        assert.throws(() => new api.HarmonySandboxHost(filesDir, new api.CoreOptions()));
        assert.deepEqual(await fs.readdir(filesDir), []);
      } finally { sdk.state.unsupported.clear(); }
    }
  });
  test('session manifests are derived, bounded, accounted and rebuilt without inventing exit causes', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'session-manifest-'));
    const item = await host(filesDir), text = envelope(item);
    assert.equal(await item.append(text), 'synced');
    const manifestPath = path.join(filesDir, 'ohmate-kit', 'sessions', item.sessionId(), 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(manifest.sessionId, item.sessionId());
    assert.equal(manifest.lifecycleEvidence, 'segment-records-only');
    assert.equal(manifest.buildVerification, 'unverified-build');
    assert.equal(manifest.segments.length, 1);
    assert.equal(manifest.segments[0].bytes, Buffer.byteLength(text));
    assert(!Object.hasOwn(manifest, 'exitReason'));
    await item.dispose(); await fs.writeFile(manifestPath, '{}');
    const next = await host(filesDir);
    assert.deepEqual(await next.recover(), [text]);
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')).segments, manifest.segments);
    try {
      sdk.state.wallOffset = 8 * 86400000;
      assert.equal((await next.prune()).code, 'PRUNED');
      assert.deepEqual(await fs.readdir(path.join(filesDir, 'ohmate-kit', 'sessions')), []);
    } finally { sdk.state.wallOffset = 0; await next.dispose(); }
  });
  test('disposal preserves the lock until a started recovery read has settled', async () => {
    const item = await host(), text = envelope(item); await item.append(text);
    let release, entered;
    sdk.state.readPending = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; }); sdk.state.readEntered = entered;
    const recovery = item.recover(); await ready;
    try { await item.dispose(); assert.equal(item.resourcesReleased(), false); assert(sdk.state.locks.size > 0); }
    finally { release(); sdk.state.readEntered = undefined; }
    await assert.rejects(recovery); await item.dispose(); assert.equal(item.resourcesReleased(), true);
  });
  test('seven-day pruning deletes only old owned records and keeps recent problems', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'retention-')), item = await host(filesDir);
    await item.append(envelope(item));
    await item.saveProblem('problem-old-1', '{"old":true}');
    await item.saveProblem('problem-new-1', '{"new":true}');
    const old = new Date(Date.now() - 8 * 86400000);
    await fs.utimes(path.join(filesDir, 'ohmate-kit', 'problems', 'problem-old-1.json'), old, old);
    await item.dispose();
    const next = await host(filesDir), result = await next.prune();
    assert.equal(result.code, 'PRUNED'); assert.deepEqual(result.deletedProblems, ['problem-old-1']);
    assert.deepEqual(await next.recoverProblems(), ['{"new":true}']);
    assert.equal((await next.recover()).length, 1);
    await next.dispose();
  });
  const resetFaults = () => {
    sdk.state.failSyncPath = ''; sdk.state.failIndexRename = false;
    sdk.state.failUnlinkAfter = -1; sdk.state.unlinks = 0; sdk.state.wallOffset = 0;
    sdk.state.failDataOpen = 0; sdk.state.failDataRename = 0; sdk.state.failTempRmdir = 0; sdk.state.failSync = false;
    sdk.state.failPublishedStat = 0;
  };
  test('long sessions reject metadata overflow before committing an unrecoverable segment', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'long-session-')), item = await host(filesDir);
    let accepted = 0;
    try {
      for (let sequence = 1; sequence <= 300; sequence++) {
        if (await item.append(envelope(item, sequence)) !== 'synced') break;
        accepted++;
      }
      assert(accepted > 0 && accepted <= 256);
      const root = path.join(filesDir, 'ohmate-kit');
      const names = await fs.readdir(path.join(root, 'sessions', item.sessionId()));
      assert.equal(names.filter(name => name.endsWith('.seg')).length, accepted,
        'rejected append must not publish a segment beyond the recoverable metadata budget');
      await item.dispose();
      const next = await host(filesDir);
      assert.equal((await next.recover()).length, accepted);
      assert((await fs.stat(path.join(root, 'index.json'))).size <= 32768);
      await next.dispose();
    } finally { await item.dispose(); }
  });
  test('a default session can use all 256 segment slots and recover unchanged bytes', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'full-segment-budget-')), item = await host(filesDir);
    const texts = [];
    try {
      for (let sequence = 1; sequence <= 256; sequence++) {
        const text = envelope(item, sequence);
        assert.equal(await item.append(text), 'synced', `metadata must not exhaust the segment budget at ${sequence}`);
        texts.push(text);
      }
      assert.equal(await item.append(envelope(item, 257)), 'uncertain');
      for (let number = 0; number < 20; number++) {
        assert.equal(await item.saveProblem('problem-budget-' + number, '{}'), 'synced');
      }
      const root = path.join(filesDir, 'ohmate-kit');
      assert.equal((await fs.readdir(path.join(root, 'sessions', item.sessionId()))).filter(name => name.endsWith('.seg')).length, 256);
      assert.deepEqual(await fs.readdir(path.join(root, 'temp')), []);
      await item.dispose();
      const next = await host(filesDir);
      try {
        assert.deepEqual(await next.recover(), texts);
        assert.deepEqual(await next.recoverProblems(), Array(20).fill('{}'));
        for (const file of ['index.json', `sessions/${item.sessionId()}/manifest.json`]) {
          assert((await fs.stat(path.join(root, file))).size <= 32768);
        }
        let total = 0;
        for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
        }
        assert.equal(next.accountedStorageBytes(), total);
        assert(total < new api.CoreOptions().maxStorageBytes);
      } finally { await next.dispose(); }
    } finally { await item.dispose(); }
  });
  test('a segment rewrite must extend the exact stored event prefix', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'segment-rewrite-')); const item = await host(filesDir);
    const clock = { clockId: 'test-clock', bootId: 'test-boot', monotonicNs: 1000000,
      wallTimeUtc: '2026-10-26T00:00:00.000Z' };
    const build = (first, names) => {
      const events = names.map((name, offset) => ({ sequence: first + offset, name, priority: 'high',
        source: 'recorder', sessionId: item.sessionId(), clock, fields: {} }));
      const payload = JSON.stringify({ schemaVersion: '1.0', sessionId: item.sessionId(), buildId: '',
        buildVerification: 'unverified-build', firstSequence: first, lastSequence: first + names.length - 1,
        events, loss: { dropped: 0, criticalDropped: 0, firstSequence: 0, lastSequence: 0, rangeKind: 'envelope' } });
      return JSON.stringify({ schemaVersion: '1.0', bytes: item.byteLength(payload), sha256: item.hash(payload), payload });
    };
    try {
      const target = path.join(filesDir, 'ohmate-kit', 'sessions', item.sessionId(), 'segment-000000000001.seg');
      assert.equal(await item.append(build(1, ['active'])), 'synced');
      const original = await fs.readFile(target, 'utf8');
      assert.equal(await item.append(build(1, ['heartbeat'])), 'uncertain', 'a changed prefix must never replace evidence');
      assert.equal(await fs.readFile(target, 'utf8'), original);
      const extended = build(1, ['active', 'heartbeat']);
      assert.equal(await item.append(build(1, ['active', 'active'])), 'uncertain',
        'plain append still refuses a same-path rewrite');
      assert.equal(await item.extendSegment(extended), 'synced');
      const root = path.join(filesDir, 'ohmate-kit');
      assert.deepEqual(await fs.readdir(path.join(root, 'sessions', item.sessionId())),
        ['manifest.json', 'segment-000000000001.seg']);
      assert.deepEqual(await item.recover(), [extended]);
      let total = 0;
      for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
      }
      assert.equal(item.accountedStorageBytes(), total);
      assert.deepEqual(await fs.readdir(path.join(root, 'temp')), []);
    } finally { await item.dispose(); }
  });
  test('a long rolling session keeps recording before the 256-segment hard cap', async () => {
    // RED: low-rate sessions reached the hard segment count at roughly 250 KB while
    // more than 4.9 MiB of the documented storage budget stayed unused.
    const filesDir = await fs.mkdtemp(path.join(directory, 'rolling-session-'));
    const options = new api.CoreOptions();
    options.sampling = 1; options.maxRecords = 16; options.criticalReserveRecords = 4;
    options.maxBufferBytes = 16384; options.criticalReserveBytes = 4096;
    options.flushIntervalMs = 60000; options.closeTimeoutMs = 1000;
    const item = new api.HarmonySandboxHost(filesDir, options); subjects.push(item);
    const core = new api.OHMateCore(item);
    assert.equal(core.registerSchema({ name: 'app.metric',
      fields: [{ key: 'value', kind: 'number', minimum: 0, maximum: 1000000 }] }).code, 'REGISTERED');
    assert.equal((await core.start(options)).code, 'STARTED');
    try {
      let recorded = 0;
      for (let round = 0; round < 300; round++) {
        for (let index = 0; index < 4; index++) {
          assert.equal(core.mark('app.metric', { value: recorded++ }).code, 'RECORDED');
        }
        assert.equal((await core.flush()).code, 'FLUSHED', `round ${round} must not exhaust the segment budget`);
      }
      const health = core.getHealth();
      assert.equal(health.storage, 'available');
      assert.equal(health.dropped, 0);
      const folder = path.join(filesDir, 'ohmate-kit', 'sessions', item.sessionId());
      const segments = (await fs.readdir(folder)).filter(name => name.endsWith('.seg'));
      assert(segments.length >= 2 && segments.length < 256, 'rolling must keep every record under the segment budget');
      let total = 0;
      for (const entry of await fs.readdir(path.join(filesDir, 'ohmate-kit'), { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
      }
      assert(total < options.maxStorageBytes);
      await core.dispose(); await item.dispose();
      const next = await host(filesDir);
      const events = (await next.recover()).flatMap(text => JSON.parse(JSON.parse(text).payload).events);
      assert.equal(events.length, 1202, 'active, 1200 ordinary and close records stay recoverable');
      assert.equal(new Set(events.map(event => event.sequence)).size, 1202);
      await next.dispose();
    } finally { await core.dispose(); await item.dispose(); }
  });
  test('grouped restart inventory preserves multiple sessions, problems and failed staging files', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'grouped-inventory-')), texts = [];
    let item;
    try {
      for (let session = 0; session < 8; session++) {
        item = await host(filesDir);
        for (let sequence = 1; sequence <= 24; sequence++) {
          const text = envelope(item, sequence);
          assert.equal(await item.append(text), 'synced'); texts.push(text);
        }
        if (session < 7) await item.dispose();
      }
      for (let number = 0; number < 20; number++) {
        assert.equal(await item.saveProblem('problem-grouped-' + number, '{}'), 'synced');
      }
      sdk.state.failSync = true;
      for (let sequence = 25; sequence <= 87; sequence++) {
        assert.equal(await item.append(envelope(item, sequence)), 'uncertain');
      }
      resetFaults();
      const root = path.join(filesDir, 'ohmate-kit');
      assert.equal((await fs.readdir(path.join(root, 'temp'))).length, 63);
      await item.dispose();
      item = await host(filesDir);
      assert.deepEqual((await item.recover()).sort(), texts.sort());
      assert.deepEqual(await item.recoverProblems(), Array(20).fill('{}'));
      const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8'));
      const indexed = index.directories.flatMap(group => group.files.map(file => group.path + '/' + file.name));
      const expected = [];
      let total = 0;
      for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const absolute = path.join(entry.parentPath, entry.name);
        const relative = path.relative(root, absolute);
        total += (await fs.stat(absolute)).size;
        if (!['owner.lock', 'index.json'].includes(relative)) expected.push(relative);
      }
      assert.deepEqual(indexed.sort(), expected.sort());
      assert.equal(item.accountedStorageBytes(), total);
      assert((await fs.stat(path.join(root, 'index.json'))).size <= 32768);
    } finally { resetFaults(); await item?.dispose(); }
  });
  test('legacy full-path metadata rebuilds as local names without changing segment evidence', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'legacy-metadata-')), item = await host(filesDir);
    const text = envelope(item), session = item.sessionId(), root = path.join(filesDir, 'ohmate-kit');
    try {
      assert.equal(await item.append(text), 'synced');
      const segmentPath = `sessions/${session}/segment-000000000001.seg`;
      const stat = await fs.stat(path.join(root, segmentPath));
      const entry = { path: segmentPath, kind: 'segment', bytes: stat.size, modifiedSeconds: stat.mtimeMs / 1000 };
      await item.dispose();
      await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({ schemaVersion: '1.0', entries: [entry] }));
      await fs.writeFile(path.join(root, 'sessions', session, 'manifest.json'), JSON.stringify({
        schemaVersion: '1.0', sessionId: session, buildVerification: 'unverified-build',
        lifecycleEvidence: 'segment-records-only', segments: [entry]
      }));
      const next = await host(filesDir);
      try {
        assert.deepEqual(await next.recover(), [text]);
        const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8'));
        assert.equal(index.schemaVersion, '1.1');
        const group = index.directories.find(group => group.path === `sessions/${session}`);
        assert.equal(group.files.filter(file => file.name.endsWith('.seg')).length, 1);
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'sessions', session, 'manifest.json'), 'utf8'));
        assert.equal(manifest.schemaVersion, '1.1');
        assert.deepEqual(manifest.segments, [{ name: 'segment-000000000001.seg', bytes: entry.bytes,
          modifiedSeconds: entry.modifiedSeconds }]);
        assert.equal(manifest.lifecycleEvidence, 'segment-records-only');
      } finally { await next.dispose(); }
    } finally { await item.dispose(); }
  });
  test('new sessions and problems cannot cross their restart scan bounds', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'session-bound-')), first = await host(filesDir);
    const root = path.join(filesDir, 'ohmate-kit');
    for (let i = 0; i < 64; i++) await fs.mkdir(path.join(root, 'sessions', 'session-existing-' + i));
    await first.dispose();
    const next = await host(filesDir);
    try {
      assert.equal(await next.append(envelope(next)), 'uncertain');
      assert.equal((await fs.readdir(path.join(root, 'sessions'))).length, 64);
    } finally { await next.dispose(); }
    const problemDir = await fs.mkdtemp(path.join(directory, 'problem-bound-'));
    const options = new api.CoreOptions(); options.maxProblems = 2;
    const bounded = new api.HarmonySandboxHost(problemDir, options); subjects.push(bounded);
    try {
      await bounded.recover();
      assert.equal(await bounded.saveProblem('problem-one', '{}'), 'synced');
      assert.equal(await bounded.saveProblem('problem-two', '{}'), 'synced');
      assert.equal(await bounded.saveProblem('problem-three', '{}'), 'uncertain');
      assert.equal((await bounded.recoverProblems()).length, 2);
    } finally { await bounded.dispose(); }
  });
  test('pending writes reserve a recovery staging slot and remain restartable at saturation', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'pending-bound-')), item = await host(filesDir);
    try {
      sdk.state.failSync = true;
      for (let i = 0; i < 70; i++) assert.equal(await item.saveProblem('problem-pending-' + i, '{}'), 'uncertain');
      const root = path.join(filesDir, 'ohmate-kit');
      assert((await fs.readdir(path.join(root, 'temp'))).length <= 63);
      resetFaults(); await item.dispose();
      const next = await host(filesDir);
      assert.deepEqual(await next.recoverProblems(), []); await next.dispose();
    } finally { resetFaults(); await item.dispose(); }
  });
  test('63 failed segment writes leave one usable metadata slot at restart', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'segment-pending-bound-')), item = await host(filesDir);
    try {
      sdk.state.failSync = true;
      for (let sequence = 1; sequence <= 70; sequence++) {
        assert.equal(await item.append(envelope(item, sequence)), 'uncertain');
      }
      assert.equal((await fs.readdir(path.join(filesDir, 'ohmate-kit', 'temp'))).length, 63);
      resetFaults(); await item.dispose();
      const next = await host(filesDir);
      assert.deepEqual(await next.recover(), []); await next.dispose();
    } finally { resetFaults(); await item.dispose(); }
  });
  test('pending records near the metadata limit cannot poison restart inventory', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'mixed-metadata-bound-')), item = await host(filesDir);
    let accepted = 0;
    try {
      for (let sequence = 1; sequence <= 190; sequence++) {
        if (await item.append(envelope(item, sequence)) !== 'synced') break;
        accepted++;
      }
      assert.equal(accepted, 190);
      sdk.state.failSync = true;
      for (let sequence = 191; sequence <= 260; sequence++) await item.append(envelope(item, sequence));
      resetFaults(); await item.dispose();
      const next = await host(filesDir);
      assert.equal((await next.recover()).length, accepted);
      assert((await fs.stat(path.join(filesDir, 'ohmate-kit', 'index.json'))).size <= 32768);
      await next.dispose();
    } finally { resetFaults(); await item.dispose(); }
  });
  test('invalid startup clocks and unsafe session nanoseconds fail before returning evidence', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'invalid-clock-'));
    try {
      for (const tick of [-1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        sdk.state.tick = tick;
        assert.throws(() => new api.HarmonySandboxHost(filesDir, new api.CoreOptions()));
        assert.deepEqual(await fs.readdir(filesDir), []);
      }
      sdk.state.tick = 1000;
      const item = await host(filesDir);
      try {
        sdk.state.tick += 105 * 86400000;
        assert.throws(() => item.now(), 'unsafe session deltas must not become timestamp evidence');
      } finally { await item.dispose(); }
    } finally { sdk.state.tick = 1000; }
  });
  for (const fault of ['open', 'rename', 'rmdir', 'published-stat']) {
    test(`an explicit retry reconciles a staged ${fault} failure without an orphan`, async () => {
      const filesDir = await fs.mkdtemp(path.join(directory, 'pending-' + fault + '-')), item = await host(filesDir);
      try {
        if (fault === 'open') sdk.state.failDataOpen = 1;
        if (fault === 'rename') sdk.state.failDataRename = 1;
        if (fault === 'rmdir') sdk.state.failTempRmdir = 1;
        if (fault === 'published-stat') sdk.state.failPublishedStat = 1;
        assert.equal(await item.saveProblem('problem-retry', '{}'), 'uncertain');
        resetFaults();
        if (fault === 'open') {
          sdk.state.failUnlinkAfter = 0;
          assert.equal(await item.saveProblem('problem-retry', '{}'), 'uncertain');
          resetFaults();
        }
        assert.equal(await item.saveProblem('problem-retry', '{}'), 'synced');
        assert.deepEqual(await item.recoverProblems(), ['{}']);
        assert.deepEqual(await fs.readdir(path.join(filesDir, 'ohmate-kit', 'temp')), []);
        let total = 0;
        for (const entry of await fs.readdir(path.join(filesDir, 'ohmate-kit'), { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
        }
        assert.equal(item.accountedStorageBytes(), total, 'retry must not reserve a published file twice');
        await item.dispose();
        const next = await host(filesDir);
        assert.deepEqual(await next.recoverProblems(), ['{}']); await next.dispose();
      } finally { resetFaults(); await item.dispose(); }
    });
  }
  const storageSubject = async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'fault-boundary-'));
    const item = await host(filesDir), core = new api.OHMateCore(item);
    const options = new api.CoreOptions(); options.flushIntervalMs = 60000;
    assert.equal((await core.start(options)).code, 'STARTED');
    core.recordFault('freeze');
    const first = await core.createProblem(), second = await core.createProblem();
    assert.equal(first.code, 'PROBLEM_CREATED'); assert.equal(second.code, 'PROBLEM_CREATED');
    return { filesDir, item, core, ids: [first.problemId, second.problemId] };
  };
  test('root metadata participates in quota and is never followed through a symlink', async () => {
    for (const name of ['owner.lock', 'index.json']) {
      const filesDir = await fs.mkdtemp(path.join(directory, 'metadata-quota-'));
      const root = path.join(filesDir, 'ohmate-kit'); await fs.mkdir(root);
      await fs.writeFile(path.join(root, name), Buffer.alloc(65536));
      const options = new api.CoreOptions(); options.maxStorageBytes = 65536;
      const item = new api.HarmonySandboxHost(filesDir, options); subjects.push(item);
      await assert.rejects(item.recover(), 'root files must not bypass the storage limit');
      await item.dispose();
      const linkDir = await fs.mkdtemp(path.join(directory, 'metadata-link-'));
      const outside = path.join(directory, name + '-outside');
      await fs.writeFile(outside, 'UNCHANGED');
      await fs.mkdir(path.join(linkDir, 'ohmate-kit'));
      await fs.symlink(outside, path.join(linkDir, 'ohmate-kit', name));
      const linked = new api.HarmonySandboxHost(linkDir, options); subjects.push(linked);
      await assert.rejects(linked.recover());
      assert.equal(await fs.readFile(outside, 'utf8'), 'UNCHANGED'); await linked.dispose();
    }
  });
  test('stable host accounting includes root index and lock and matches every stored file', async () => {
    const { filesDir, item, core } = await storageSubject();
    try {
      await core.prune();
      const root = path.join(filesDir, 'ohmate-kit');
      let total = 0;
      for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
      }
      assert.equal(core.getHealth().storageAccountedBytes, total);
      assert.equal(core.getHealth().storageAccounting, 'host-reported');
      assert(total > core.getHealth().storageBytes + core.getHealth().problemBytes);
    } finally { await core.dispose(); await item.dispose(); }
  });
  test('prune removes expired empty session directories and retries a failed final directory sync', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'empty-sessions-'));
    const first = await host(filesDir);
    const root = path.join(filesDir, 'ohmate-kit'), old = new Date(Date.now() - 8 * 86400000);
    for (let i = 0; i < 64; i++) {
      const session = path.join(root, 'sessions', 'session-old-' + i);
      await fs.mkdir(session); await fs.utimes(session, old, old);
    }
    await first.dispose();
    const next = await host(filesDir);
    assert.equal((await next.prune()).code, 'PRUNED');
    assert.deepEqual(await fs.readdir(path.join(root, 'sessions')), []);
    await next.saveProblem('problem-expired', '{}');
    await next.dispose();
    const last = await host(filesDir);
    try {
      sdk.state.wallOffset = 8 * 86400000; sdk.state.failSyncPath = '/problems';
      assert.equal((await last.prune()).code, 'PRUNE_UNCERTAIN');
      resetFaults(); sdk.state.wallOffset = 8 * 86400000; sdk.state.failSyncPath = '/problems';
      assert.equal((await last.prune()).code, 'PRUNE_UNCERTAIN', 'a no-record retry must still sync the deleted directory');
      resetFaults(); assert.equal((await last.prune()).code, 'PRUNED');
    } finally { resetFaults(); await last.dispose(); }
  });
  for (const fault of ['unlink', 'directory-sync', 'index-publish']) {
    test(`uncertain deletion at ${fault} revokes every review and a retry reconciles the disk`, async () => {
      const { item, core, ids } = await storageSubject(), id = ids[0];
      const review = core.reviewArchive(id), before = core.getHealth().problemBytes;
      assert.equal(review.code, 'ARCHIVE_REVIEWED');
      try {
        if (fault === 'unlink') sdk.state.failUnlinkAfter = 0;
        if (fault === 'directory-sync') sdk.state.failSyncPath = '/problems';
        if (fault === 'index-publish') sdk.state.failIndexRename = true;
        assert.equal((await core.deleteProblem(id)).code, 'PROBLEM_DELETE_UNCERTAIN');
        assert.equal(core.reviewArchive(id).code, 'PROBLEM_NOT_FOUND');
        assert.equal(core.reviewExport(id).code, 'PROBLEM_NOT_FOUND');
        assert.equal(core.exportArchive(id, review.reviewHash).code, 'PROBLEM_NOT_FOUND');
        assert.equal(core.getHealth().problemBytes, before, 'uncertain deletion retains its Core reservation');
        resetFaults();
        assert.equal((await item.recoverProblems()).length, fault === 'unlink' ? 2 : 1);
        assert.equal((await core.deleteProblem(id)).code, 'PROBLEM_DELETED');
        assert.equal(core.listProblems().length, 1);
        assert(core.getHealth().problemBytes < before);
        assert.equal((await item.recoverProblems()).length, 1);
      } finally { resetFaults(); await core.dispose(); await item.dispose(); }
    });
    test(`prune at ${fault} reports partial deletion and cannot export removed problems`, async () => {
      const { item, core, ids } = await storageSubject(), review = core.reviewArchive(ids[0]);
      assert.equal(review.code, 'ARCHIVE_REVIEWED');
      try {
        sdk.state.wallOffset = 8 * 86400000;
        if (fault === 'unlink') sdk.state.failUnlinkAfter = 1;
        if (fault === 'directory-sync') sdk.state.failSyncPath = '/problems';
        if (fault === 'index-publish') sdk.state.failIndexRename = true;
        assert.equal((await core.prune()).code, 'PRUNE_UNCERTAIN');
        assert.equal(core.getProblem(ids[0]), undefined);
        assert.equal(core.reviewArchive(ids[0]).code, 'PROBLEM_NOT_FOUND');
        assert.equal(core.reviewExport(ids[0]).code, 'PROBLEM_NOT_FOUND');
        assert.equal(core.exportArchive(ids[0], review.reviewHash).code, 'PROBLEM_NOT_FOUND');
        assert.equal(core.listProblems().length, fault === 'index-publish' ? 0 : 1);
        resetFaults();
        assert.equal((await item.recoverProblems()).length, fault === 'index-publish' ? 0 : 1);
        sdk.state.wallOffset = 8 * 86400000;
        assert.equal((await core.prune()).code, 'PRUNED');
        assert.equal(core.getHealth().problemBytes, 0);
        assert.deepEqual(await item.recoverProblems(), []);
      } finally { resetFaults(); await core.dispose(); await item.dispose(); }
    });
  }
  test('context start is idempotent and disposal releases every host handle', async () => {
    const filesDir = await fs.mkdtemp(path.join(directory, 'context-'));
    const context = { filesDir }, options = new api.CoreOptions(); options.flushIntervalMs = 60000;
    assert.equal((await api.OHMateKit.start(context, { ...options, token:'private' })).code, 'OPTIONS_INVALID');
    const start = api.OHMateKit.start(context, options);
    assert.equal(api.OHMateKit.start(context, options), start);
    assert.equal((await start).code, 'STARTED');
    assert.equal((await api.OHMateKit.start({ filesDir: filesDir + '-other' }, options)).code, 'START_CONTEXT_CONFLICT');
    assert.equal(api.OHMateKit.getHealth().clockEvidence, 'system-startup-ms-session-scope');
    api.OHMateKit.recordFault('freeze');
    const made = await api.OHMateKit.createProblem(); assert.equal(made.code, 'PROBLEM_CREATED');
    const review = api.OHMateKit.reviewExport(made.problemId); assert.equal(review.code, 'EXPORT_REVIEWED');
    try {
      sdk.state.wallOffset = 8 * 86400000;
      assert.equal((await api.OHMateKit.prune()).code, 'PRUNED');
      assert.equal(api.OHMateKit.listProblems().length, 0);
      assert.equal(api.OHMateKit.exportProblem(made.problemId, review.reviewHash).code, 'PROBLEM_NOT_FOUND');
      assert.equal(api.OHMateKit.getHealth().problemBytes, 0);
    } finally { sdk.state.wallOffset = 0; }
    await api.OHMateKit.dispose();
    assert.equal(sdk.state.fds.size, 0); assert.equal(sdk.state.locks.size, 0);
  });
}
