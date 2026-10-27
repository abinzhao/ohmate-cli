/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import * as clocks from '../debug-protocol/clock-segments.js';
import * as files from './journal-files.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import { EventJournal } from './event-journal.js';
import { JournalSegmentSchema } from './journal-schemas.js';
import type { JournalEvent } from './journal-schemas.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-journal-incremental-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function start(version = '1.3', count = 3, maxEvents = 4096) {
  const handshake = createHandshake(identity, { resumeWindow: 2 });
  const store = await EventJournal.create(root, randomUUID(), handshake, {
    ...(version !== '1.1' ? { resume: { peer: handshake, epoch: 'epoch-1' } } : {}),
    segmented: ['1.3', '1.4'].includes(version), maxEvents,
    ...(version === '1.4' ? { retention: 'rolling-v1' as const } : {}),
  });
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  const accepted = Array.from({ length: count }, (_, n) => receiver.accept(event(n + 1)));
  if (['1.3', '1.4'].includes(version) && count) { await store.appendBatch(accepted); }
  else { for (const item of accepted) { await store.append(item); } }
  return { store, receiver, handshake, read: () => EventJournal.read(root, store.sessionId, store.streamId) };
}

it.each(['1.1', '1.2', '1.3'])('reuses only byte-verified %s history and recalculates only appended clocks', async (version) => {
  const { store, receiver, read } = await start(version);
  const clock = vi.spyOn(clocks, 'advanceClock'), disk = vi.spyOn(files, 'readJournalFile');
  const first = await read();
  expect(clock.mock.calls.length, 'cold history must map each record exactly once').toBe(3);
  clock.mockClear(); disk.mockClear();
  expect(await read()).toEqual(first);
  expect(clock.mock.calls.length, 'unchanged verified history must not remap clocks').toBe(0);
  const names = disk.mock.calls.map(([file]) => file.slice(store.root.length + 1));
  expect(names).toContain('checkpoint.json');
  expect(names).toContain('manifest.json');
  expect(names).toEqual(expect.arrayContaining(version === '1.3'
    ? ['00000001-00000003.seg'] : ['00000001.json', '00000002.json', '00000003.json']));
  await store.append(receiver.accept(event(4))); clock.mockClear();
  const next = await read();
  expect(next.events.map((record) => record.index)).toEqual([1, 2, 3, 4]);
  expect(clock.mock.calls.length, 'a newly committed suffix maps only its own clock').toBe(1);
});

it('does not expose mutable verified state to callers', async () => {
  const { read } = await start();
  const first = await read();
  first.events[0].clock.segment = 999;
  first.events[0].event.payload = { level: 'info', summary: 'changed' };
  first.manifest.handshake.identity.buildId = 'changed';
  const again = await read();
  expect(again.events[0].clock.segment).toBe(1);
  expect(again.events[0].event.payload).toEqual({ level: 'info', summary: 'Redacted fixture summary' });
  expect(again.manifest.handshake.identity.buildId).toBe(identity.buildId);
});

it.each(['tamper', 'missing-tail', 'uncommitted-tail', 'checkpoint', 'unknown-entry'])('rejects warm-cache %s', async (change) => {
  const { store, read } = await start();
  await read();
  const segment = join(store.root, '00000001-00000003.seg');
  if (change === 'tamper') { await writeFile(segment, '{}'); }
  else if (change === 'missing-tail') { await rm(segment); }
  else if (change === 'uncommitted-tail') {
    await writeFile(join(store.root, '00000004-00000004.seg'), await readFile(segment), { mode: 0o600 });
  } else if (change === 'checkpoint') { await writeFile(join(store.root, 'checkpoint.json'), '{}'); }
  else { await writeFile(join(store.root, 'unknown.json'), '{}', { mode: 0o600 }); }
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
});

it.each(['symlink', 'hardlink', 'permissions'])('rechecks warm-cache %s safety before returning evidence', async (change) => {
  const { store, read } = await start();
  await read();
  const file = join(store.root, '00000001-00000003.seg'), outside = join(root, 'outside');
  if (change === 'permissions') { await chmod(file, 0o644); }
  else {
    await writeFile(outside, await readFile(file), { mode: 0o600 });
    await rm(file);
    if (change === 'symlink') { await symlink(outside, file); } else { await link(outside, file); }
  }
  await expect(read()).rejects.toThrow('JOURNAL_UNSAFE');
});

async function rewrite(store: EventJournal, name: string, mutate: (record: JournalEvent) => void) {
  const file = join(store.root, name), segment = JSON.parse(await readFile(file, 'utf8'));
  mutate(segment.records.at(-1));
  let previousHash = segment.records[0].previousHash;
  for (const record of segment.records) {
    record.previousHash = previousHash;
    const { hash: _hash, ...body } = record; void _hash;
    record.hash = hashContract(body); previousHash = record.hash;
  }
  segment.bytes = Buffer.byteLength(JSON.stringify(segment.records));
  const { hash: _hash, ...body } = segment; void _hash;
  segment.hash = hashContract(body);
  const old = await readFile(file), text = JSON.stringify(segment);
  await writeFile(file, text);
  const checkpointFile = join(store.root, 'checkpoint.json'), checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  checkpoint.lastHash = previousHash; checkpoint.bytes += Buffer.byteLength(text) - old.length;
  await writeFile(checkpointFile, JSON.stringify(checkpoint));
}

it.each(['clock', 'epoch', 'version', 'message-id'])('validates new %s evidence after a verified prefix even with rewritten hashes', async (change) => {
  const { store, receiver, read } = await start();
  await read();
  await store.append(receiver.accept(event(4)));
  await rewrite(store, '00000004-00000004.seg', (record) => {
    if (change === 'clock') { record.clock.mergeable = false; }
    else if (change === 'epoch') { record.event.sessionEpoch = 'unknown-epoch'; }
    else if (change === 'version') { record.event.protocolVersion = '1.0'; }
    else { record.event.messageId = 'fixture-message-3'; }
  });
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
});

it('invalidates a changed prefix and does not retain partially validated suffixes after failure', async () => {
  const { store, receiver, read } = await start();
  await read();
  await store.appendBatch([receiver.accept(event(4)), receiver.accept(event(5))]);
  const file = join(store.root, '00000004-00000005.seg'), checkpoint = join(store.root, 'checkpoint.json');
  const bytes = await readFile(file), anchor = await readFile(checkpoint);
  await rewrite(store, '00000004-00000005.seg', (record) => { record.clock.mergeable = false; });
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
  await writeFile(file, bytes); await writeFile(checkpoint, anchor);
  expect((await read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4, 5]);
  await rewrite(store, '00000001-00000003.seg', (record) => { record.event.sessionEpoch = 'unknown'; });
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
});

it('invalidates a verified prefix across persisted epochs and preserves replay-window evidence', async () => {
  const { store, read, handshake } = await start();
  await read();
  const resumed = await EventJournal.resume(root, store.sessionId, store.streamId, handshake, handshake, {
    ...identity, type: 'resume', protocolVersion: '1.1', previousEpoch: 'epoch-1', sessionEpoch: 'epoch-2', resumeFrom: 4,
  });
  const clock = vi.spyOn(clocks, 'advanceClock');
  expect((await read()).events).toHaveLength(3);
  expect(clock.mock.calls.length).toBe(3);
  expect(resumed.bridge.status()).toMatchObject({ state: 'connected', retainedFrom: 2, lastSequence: 3 });
  await resumed.journal.append(resumed.bridge.accept(event(4, { sessionEpoch: 'epoch-2' })));
  clock.mockClear();
  expect((await read()).events.at(-1)!.event.sessionEpoch).toBe('epoch-2');
  expect(clock.mock.calls.length).toBe(1);
});

it('bounds retained read history across streams and remaps an evicted stream', async () => {
  const first = await start('1.3', 1); await first.read();
  for (let n = 0; n < 16; n++) { await (await start('1.3', 0)).read(); }
  const clock = vi.spyOn(clocks, 'advanceClock');
  expect((await first.read()).events).toHaveLength(1);
  expect(clock.mock.calls.length).toBe(1);
});

it('does not reparse byte-verified rolling segments while rechecking every file and checkpoint', async () => {
  const { store, read } = await start('1.4');
  await read();
  const parse = vi.spyOn(JournalSegmentSchema, 'parse'), clock = vi.spyOn(clocks, 'advanceClock');
  const disk = vi.spyOn(files, 'readJournalFile');
  expect((await read()).events.map((record) => record.index)).toEqual([1, 2, 3]);
  expect(parse.mock.calls.length, 'warm rolling history must not decode unchanged segments').toBe(0);
  expect(clock.mock.calls.length).toBe(0);
  expect(disk.mock.calls.map(([file]) => file.slice(store.root.length + 1))).toEqual(expect.arrayContaining([
    'manifest.json', 'checkpoint.json', '0000000000000001-0000000000000003.seg',
  ]));
});

it('shares a verified rolling prefix with the writer and publishes only committed suffixes', async () => {
  const { store, receiver, read } = await start('1.4');
  await read();
  const accepted = receiver.accept(event(4));
  const clock = vi.spyOn(clocks, 'advanceClock'), disk = vi.spyOn(files, 'readJournalFile');
  const [record] = await store.appendBatch([accepted]);
  expect(clock.mock.calls.length, 'writer maps only the incoming clock').toBe(1);
  expect(disk.mock.calls.map(([file]) => file.slice(store.root.length + 1))).toContain('0000000000000001-0000000000000003.seg');
  clock.mockClear();
  record.clock.segment = 999;
  record.event.payload = { level: 'info', summary: 'caller mutation' };
  const next = await read();
  expect(next.events.map((item) => item.index)).toEqual([1, 2, 3, 4]);
  expect(next.events.at(-1)!.clock.segment).toBe(1);
  expect(next.events.at(-1)!.event.payload).toEqual({ level: 'info', summary: 'Redacted fixture summary' });
  expect(clock.mock.calls.length, 'committed writer evidence must not remap on query').toBe(0);
});

it('retains verified rolling clock state across whole-segment eviction', async () => {
  const { store, receiver, read } = await start('1.4', 2, 4);
  await store.appendBatch([receiver.accept(event(3)), receiver.accept(event(4))]);
  await read();
  const accepted = [receiver.accept(event(5)), receiver.accept(event(6))];
  const clock = vi.spyOn(clocks, 'advanceClock');
  await store.appendBatch(accepted);
  expect(clock.mock.calls.length, 'eviction maps only incoming clocks').toBe(2);
  clock.mockClear();
  const next = await read();
  expect(next.events.map((item) => item.index)).toEqual([3, 4, 5, 6]);
  expect(next.retention?.gap).toEqual({ missingFrom: 1, missingThrough: 2, reason: 'retention-quota' });
  expect(clock.mock.calls.length, 'writer-published retention must not remap surviving clocks').toBe(0);
});

it.each(['tamper', 'checkpoint', 'epoch', 'permissions', 'symlink', 'hardlink', 'uncommitted-tail', 'unknown-entry'])('rejects writer-published rolling cache %s', async (change) => {
  const { store, read } = await start('1.4');
  const segment = join(store.root, '0000000000000001-0000000000000003.seg');
  if (change === 'tamper') { await writeFile(segment, '{}'); }
  else if (change === 'permissions') { await chmod(segment, 0o644); }
  else if (change === 'checkpoint') { await writeFile(join(store.root, 'checkpoint.json'), '{}'); }
  else if (change === 'symlink' || change === 'hardlink') {
    const outside = join(root, 'outside');
    await writeFile(outside, await readFile(segment), { mode: 0o600 }); await rm(segment);
    if (change === 'symlink') { await symlink(outside, segment); } else { await link(outside, segment); }
  } else if (change === 'uncommitted-tail') {
    await writeFile(join(store.root, '0000000000000004-0000000000000004.seg'), await readFile(segment), { mode: 0o600 });
  } else if (change === 'unknown-entry') { await writeFile(join(store.root, 'unknown.json'), '{}', { mode: 0o600 }); }
  else { await rewrite(store, '0000000000000001-0000000000000003.seg', (record) => { record.event.sessionEpoch = 'unknown'; }); }
  await expect(read()).rejects.toThrow(['permissions', 'symlink', 'hardlink'].includes(change) ? 'JOURNAL_UNSAFE' : 'JOURNAL_CORRUPT');
});

it('discards consumed rolling validation after a rejected incoming clock', async () => {
  const { store, receiver, read } = await start('1.4');
  await read();
  const accepted = receiver.accept(event(4)), invalid = structuredClone(accepted);
  invalid.clock.mergeable = false;
  await expect(store.appendBatch([invalid])).rejects.toThrow('JOURNAL_CORRUPT');
  const clock = vi.spyOn(clocks, 'advanceClock');
  expect((await read()).events).toHaveLength(3);
  expect(clock.mock.calls.length, 'failed writer validation must discard consumed state').toBe(3);
  await store.appendBatch([accepted]);
  expect((await read()).events).toHaveLength(4);
});

it('bounds writer-published rolling history in the same cache and validates evicted segments once', async () => {
  const first = await start('1.4');
  for (let n = 0; n < 16; n++) { await (await start('1.4', 0)).read(); }
  const clock = vi.spyOn(clocks, 'advanceClock'), parse = vi.spyOn(JournalSegmentSchema, 'parse');
  expect((await first.read()).events).toHaveLength(3);
  expect(clock.mock.calls.length).toBe(3);
  expect(parse.mock.calls.length, 'cold rolling segments must be decoded once').toBe(1);
});
