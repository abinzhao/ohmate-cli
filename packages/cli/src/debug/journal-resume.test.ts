/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { EventJournal } from './event-journal.js';
import * as files from './journal-files.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-journal-resume-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function start(count = 3) {
  const handshake = createHandshake(identity, { resumeWindow: 2 });
  const store = await EventJournal.create(root, randomUUID(), handshake, { resume: { peer: handshake, epoch: 'epoch-1' } });
  const receiver = createReadonlyBridge(handshake);
  receiver.connect(handshake, 'epoch-1');
  for (let sequence = 1; sequence <= count; sequence++) {
    await store.append(receiver.accept(event(sequence, {
      channel: 'arkweb.console', capability: 'arkweb.console.read',
      payload: { level: 'info', summary: 'memory-only original value' },
    })));
  }
  return { handshake, store, receiver };
}
function request(resumeFrom = 2, patch: Record<string, unknown> = {}) {
  return { ...identity, type: 'resume', protocolVersion: '1.1', previousEpoch: 'epoch-1',
    sessionEpoch: 'epoch-2', resumeFrom, ...patch };
}
async function reopen(started: Awaited<ReturnType<typeof start>>, input = request()) {
  expect(EventJournal.resume, 'durable resume is missing').toBeTypeOf('function');
  return EventJournal.resume(root, started.store.sessionId, started.store.streamId, started.handshake, started.handshake, input);
}

it('restores retained digests without plaintext, replays once and appends to the same stream', async () => {
  const started = await start();
  const restored = await reopen(started);
  expect(restored.ack).toMatchObject({ ackThrough: 1, sessionEpoch: 'epoch-2' });
  expect(restored.bridge.status()).toMatchObject({ retainedFrom: 2, lastSequence: 3 });
  const replay = restored.bridge.accept(event(2, {
    sessionEpoch: 'epoch-2', channel: 'arkweb.console', capability: 'arkweb.console.read',
    payload: { level: 'info', summary: 'memory-only original value' },
  }));
  expect(replay.disposition).toBe('replay');
  expect(replay.clock).toMatchObject({ segment: 1, reason: 'continuous' });
  expect(restored.bridge.accept(replay.event).disposition).toBe('duplicate');
  restored.bridge.accept(event(3, { ...replay.event, sequence: 3, messageId: 'fixture-message-3', monotonicNs: '3' }));
  await restored.journal.append(restored.bridge.accept(event(4, { sessionEpoch: 'epoch-2', offsetUncertaintyMs: 11 })));
  const saved = await EventJournal.read(root, started.store.sessionId, started.store.streamId);
  expect(saved.events.map((record) => record.index)).toEqual([1, 2, 3, 4]);
  expect(saved.events[3].clock).toMatchObject({ segment: 2, reason: 'uncertainty-boundary', mergeable: false });
  for (const file of await readdir(started.store.root)) {
    expect(await readFile(join(started.store.root, file), 'utf8')).not.toContain('memory-only original value');
  }
});

it('rejects a changed raw payload even when persisted redacted summaries are identical', async () => {
  const started = await start(), restored = await reopen(started);
  expect(() => restored.bridge.accept(event(2, {
    sessionEpoch: 'epoch-2', channel: 'arkweb.console', capability: 'arkweb.console.read',
    payload: { level: 'info', summary: 'different private value' },
  }))).toThrow('MESSAGE_ID_CONFLICT');
  expect(restored.bridge.status().ackThrough).toBe(1);
});

it.each([
  [1, {}, 'SEQUENCE_GAP'], [5, {}, 'SEQUENCE_GAP'],
  [2, { previousEpoch: 'stale' }, 'EPOCH_MISMATCH'],
  [2, { sessionEpoch: 'epoch-1' }, 'EPOCH_REUSED'],
  [2, { device: 'other-device' }, 'IDENTITY_MISMATCH'],
  [2, { protocolVersion: '1.0' }, 'VERSION_MISMATCH'],
] as const)('refuses invalid resume %s %j without changing the commit anchor', async (from, patch, code) => {
  const started = await start(), checkpoint = join(started.store.root, 'checkpoint.json');
  const before = await readFile(checkpoint);
  await expect(reopen(started, request(from, patch))).rejects.toThrow(code);
  expect(await readFile(checkpoint)).toEqual(before);
});

it('persists epochs even when reconnecting without new events and fences stale writers', async () => {
  const started = await start();
  const restored = await reopen(started, request(4));
  await expect(started.store.append(started.receiver.accept(event(4)))).rejects.toThrow('JOURNAL_WRITER_STALE');
  await expect(reopen(started)).rejects.toThrow('EPOCH_MISMATCH');
  await expect(reopen(started, request(4, { previousEpoch: 'epoch-2', sessionEpoch: 'epoch-1' }))).rejects.toThrow('EPOCH_REUSED');
  const next = await reopen(started, request(4, { previousEpoch: 'epoch-2', sessionEpoch: 'epoch-3' }));
  await expect(restored.journal.append(restored.bridge.accept(event(4, { sessionEpoch: 'epoch-2' })))).rejects.toThrow('JOURNAL_WRITER_STALE');
  await next.journal.append(next.bridge.accept(event(4, { sessionEpoch: 'epoch-3' })));
  expect((await EventJournal.read(root, started.store.sessionId, started.store.streamId)).events).toHaveLength(4);
});

it('restores the last clock boundary and rejects monotonic regression after reopening', async () => {
  const started = await start();
  const restored = await reopen(started, request(4));
  expect(() => restored.bridge.accept(event(4, { sessionEpoch: 'epoch-2', monotonicNs: '2' }))).toThrow('CLOCK_REGRESSION');
  const accepted = restored.bridge.accept(event(4, { sessionEpoch: 'epoch-2', bootId: 'new-boot', monotonicNs: '0' }));
  expect(accepted.clock).toMatchObject({ segment: 2, reason: 'clock-boundary' });
});

it('refuses negotiation or authority fingerprint drift', async () => {
  const started = await start();
  expect(EventJournal.resume).toBeTypeOf('function');
  const changed = createHandshake(identity, { resumeWindow: 1 });
  await expect(EventJournal.resume(root, started.store.sessionId, started.store.streamId,
    changed, changed, request())).rejects.toThrow('RESUME_MISMATCH');
  const other = createHandshake({ ...identity, fingerprint: 'b'.repeat(64) }, { resumeWindow: 2 });
  await expect(EventJournal.resume(root, started.store.sessionId, started.store.streamId,
    other, other, request())).rejects.toThrow('IDENTITY_MISMATCH');
});

it('refuses an uncommitted tail and preserves all failure evidence', async () => {
  const started = await start();
  const file = join(started.store.root, 'checkpoint.json'), before = await readFile(file);
  const value = JSON.parse(before.toString()); value.index--;
  await writeFile(file, JSON.stringify(value));
  await expect(reopen(started)).rejects.toThrow('JOURNAL_CORRUPT');
  expect(await readdir(started.store.root)).toContain('00000003.json');
});

it('keeps legacy archives readable but refuses to guess missing recovery evidence', async () => {
  const handshake = createHandshake(identity);
  const store = await EventJournal.create(root, randomUUID(), handshake);
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  await store.append(receiver.accept(event(1)));
  expect(EventJournal.resume).toBeTypeOf('function');
  await expect(EventJournal.resume(root, store.sessionId, store.streamId, handshake, handshake, request(2)))
    .rejects.toThrow('JOURNAL_RESUME_UNAVAILABLE');
  expect((await EventJournal.read(root, store.sessionId, store.streamId)).events).toHaveLength(1);
});

it('persists an empty stream epoch before any event and resumes at sequence one', async () => {
  const started = await start(0), restored = await reopen(started, request(1));
  expect(restored.ack.ackThrough).toBe(0);
  await restored.journal.append(restored.bridge.accept(event(1, { sessionEpoch: 'epoch-2' })));
  expect((await EventJournal.read(root, started.store.sessionId, started.store.streamId)).events).toHaveLength(1);
});

it('keeps the last allowed epoch writable and rejects the next without changing the archive', async () => {
  const started = await start(0);
  let restored = await reopen(started, request(1));
  for (let epoch = 3; epoch <= 24; epoch++) {
    restored = await reopen(started, request(1, { previousEpoch: `epoch-${epoch - 1}`, sessionEpoch: `epoch-${epoch}` }));
  }
  await restored.journal.append(restored.bridge.accept(event(1, { sessionEpoch: 'epoch-24' })));
  const checkpoint = join(started.store.root, 'checkpoint.json'), before = await readFile(checkpoint);
  await expect(reopen(started, request(2, { previousEpoch: 'epoch-24', sessionEpoch: 'epoch-25' })))
    .rejects.toThrow('JOURNAL_EPOCH_LIMIT');
  expect(await readFile(checkpoint)).toEqual(before);
  expect((await EventJournal.read(root, started.store.sessionId, started.store.streamId)).events).toHaveLength(1);
});

it('does not consume an epoch when persisting the resume checkpoint fails', async () => {
  const started = await start();
  const checkpoint = join(started.store.root, 'checkpoint.json'), before = await readFile(checkpoint);
  vi.spyOn(files, 'writeJournalCheckpoint').mockRejectedValueOnce(new Error('injected disk failure'));
  await expect(reopen(started, request(4))).rejects.toThrow('injected disk failure');
  expect(await readFile(checkpoint)).toEqual(before);
  const restored = await reopen(started, request(4));
  await restored.journal.append(restored.bridge.accept(event(4, { sessionEpoch: 'epoch-2' })));
  expect((await EventJournal.read(root, started.store.sessionId, started.store.streamId)).events).toHaveLength(4);
});

it('restores historical measurements but requires a new observation in the resumed epoch', async () => {
  const started = await start(0);
  const observation = { sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1', receivedNs: '1006000000',
    sample: { probeId: 'probe-1', sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1',
      clockId: 'clock-1', bootId: 'boot-1', t0: '1000000000', t1: '902000000', t2: '903000000',
      t3: '1005000000', precisionNs: '1000000' } };
  await started.store.append(started.receiver.accept(event(1, {
    clockId: 'clock-1', bootId: 'boot-1', monotonicNs: '904000000',
  }), observation));
  const restored = await reopen(started, request(2));
  expect(() => restored.bridge.accept(event(2, {
    sessionEpoch: 'epoch-2', clockId: 'clock-1', bootId: 'boot-1', monotonicNs: '905000000',
  }), observation)).toThrow('EPOCH_MISMATCH');
  const accepted = restored.bridge.accept(event(2, {
    sessionEpoch: 'epoch-2', clockId: 'clock-1', bootId: 'boot-1', monotonicNs: '905000000',
  }), { sessionEpoch: 'epoch-2', desktopClockId: 'desktop-2', receivedNs: '1007000000', sample: null });
  expect(accepted.clock).toMatchObject({ segment: 2, reason: 'calibration-boundary', mergeable: false });
  await restored.journal.append(accepted);
  const saved = await EventJournal.read(root, started.store.sessionId, started.store.streamId);
  expect(saved.events[0].clock.alignment!.status).toBe('calibrated');
  expect(saved.events[1].clock.alignment!.status).toBe('not-calibrated');
});

it('validates a measured legacy log beyond its recomputed hash chain', async () => {
  const { handshake } = await start(0);
  const store = await EventJournal.create(root, randomUUID(), handshake);
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  await store.append(receiver.accept(event(1), {
    sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1', receivedNs: '100', sample: null,
  }));
  const file = join(store.root, '00000001.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.clock.mergeable = true;
  const { hash: _hash, ...body } = record;
  void _hash;
  record.hash = hashContract(body);
  const text = JSON.stringify(record);
  await writeFile(file, text);
  const checkpoint = JSON.parse(await readFile(join(store.root, 'checkpoint.json'), 'utf8'));
  checkpoint.lastHash = record.hash;
  checkpoint.bytes = Buffer.byteLength(await readFile(join(store.root, 'manifest.json'))) + Buffer.byteLength(text);
  await writeFile(join(store.root, 'checkpoint.json'), JSON.stringify(checkpoint));
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
});
