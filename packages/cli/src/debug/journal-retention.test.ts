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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-retention-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function start(maxEvents = 4, maxBytes = 5 * 1024 * 1024) {
  const handshake = createHandshake(identity, { resumeWindow: 8 });
  const store = await EventJournal.create(root, randomUUID(), handshake, {
    maxEvents, maxBytes, segmented: true, retention: 'rolling-v1', resume: { peer: handshake, epoch: 'epoch-1' },
  });
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  return { store, receiver, handshake, read: () => EventJournal.read(root, store.sessionId, store.streamId) };
}
async function batch(started: Awaited<ReturnType<typeof start>>, from: number, through: number) {
  return started.store.appendBatch(Array.from({ length: through - from + 1 }, (_, n) => started.receiver.accept(event(from + n))));
}
function request(from: number) {
  return { ...identity, type: 'resume', protocolVersion: '1.1', previousEpoch: 'epoch-1', sessionEpoch: 'epoch-2', resumeFrom: from };
}
async function resume(started: Awaited<ReturnType<typeof start>>, from: number) {
  return EventJournal.resume(root, started.store.sessionId, started.store.streamId,
    started.handshake, started.handshake, request(from), { segmented: true, retention: 'rolling-v1' });
}
it('requires an explicit segmented, resumable rolling mode and preserves the legacy default', async () => {
  const started = await start();
  expect((await started.read()).manifest).toMatchObject({ schemaVersion: '1.4', retention: 'rolling-v1' });
  const legacy = await EventJournal.create(root, randomUUID(), started.handshake, {
    segmented: true, resume: { peer: started.handshake, epoch: 'epoch-1' },
  });
  expect((await EventJournal.read(root, legacy.sessionId, legacy.streamId)).manifest.schemaVersion).toBe('1.3');
  await expect(EventJournal.create(root, randomUUID(), started.handshake, {
    retention: 'rolling-v1', resume: { peer: started.handshake, epoch: 'epoch-1' },
  })).rejects.toThrow('JOURNAL_BATCH_INVALID');
});
it('retains a bounded contiguous suffix with absolute sequence, hash, clock and observable eviction', async () => {
  const started = await start();
  const first = await batch(started, 1, 2);
  await batch(started, 3, 4);
  const next = await batch(started, 5, 6), saved = await started.read();
  expect(saved.events.map((record) => record.index)).toEqual([3, 4, 5, 6]);
  expect(saved.events[0].previousHash).toBe(first[1].hash);
  expect(saved.events.at(-1)).toEqual(next[1]);
  expect(saved.retention).toEqual({ from: 3, through: 6, cleanupPending: false,
    gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } });
  expect(await readdir(started.store.root)).not.toContain('0000000000000001-0000000000000002.seg');
  expect(saved.events[0].clock).toMatchObject({ segment: 1, reason: 'continuous' });
});
it('preflights an individually oversized or invalid batch before retiring any evidence', async () => {
  const started = await start();
  await batch(started, 1, 4);
  const checkpoint = await readFile(join(started.store.root, 'checkpoint.json'));
  const names = await readdir(started.store.root);
  await expect(batch(started, 5, 9)).rejects.toThrow('JOURNAL_LIMIT');
  expect(await readFile(join(started.store.root, 'checkpoint.json'))).toEqual(checkpoint);
  expect(await readdir(started.store.root)).toEqual(names);
  expect((await started.read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4]);
});
it('continues beyond sequence 4096 while retaining at most the existing event quota', async () => {
  const started = await start(128);
  for (let n = 1; n <= 4160; n += 64) { await batch(started, n, n + 63); }
  const saved = await started.read();
  expect(saved.events).toHaveLength(128);
  expect(saved.events[0].index).toBe(4033);
  expect(saved.events.at(-1)!.index).toBe(4160);
  expect(saved.retention?.gap).toMatchObject({ missingFrom: 1, missingThrough: 4032 });
}, 15000);
it('restores only retained replay evidence and reports the exact missing sequence range', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4); await batch(started, 5, 6);
  const checkpoint = await readFile(join(started.store.root, 'checkpoint.json'));
  await expect(resume(started, 1)).rejects.toMatchObject({ code: 'SEQUENCE_GAP',
    gap: { missingFrom: 1, missingThrough: 2, expected: 3, received: 1 } });
  expect(await readFile(join(started.store.root, 'checkpoint.json'))).toEqual(checkpoint);
  const restored = await resume(started, 3);
  expect(restored.bridge.status()).toMatchObject({ retainedFrom: 3, lastSequence: 6, ackThrough: 2 });
  expect(restored.bridge.accept(event(3, { sessionEpoch: 'epoch-2' })).disposition).toBe('replay');
  for (let n = 4; n <= 6; n++) { restored.bridge.accept(event(n, { sessionEpoch: 'epoch-2' })); }
  expect(() => restored.bridge.accept(event(7, { sessionEpoch: 'epoch-2', monotonicNs: '1' }))).toThrow('CLOCK_REGRESSION');
  await restored.journal.append(restored.bridge.accept(event(7, { sessionEpoch: 'epoch-2' })));
  expect((await started.read()).events.at(-1)?.event.sessionEpoch).toBe('epoch-2');
  await expect(started.store.append(started.receiver.accept(event(7)))).rejects.toThrow('JOURNAL_WRITER_STALE');
});
it('keeps the previous committed prefix when publishing a retirement checkpoint fails', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4);
  const checkpoint = await readFile(join(started.store.root, 'checkpoint.json'));
  vi.spyOn(files, 'writeJournalCheckpoint').mockRejectedValueOnce(new Error('retirement fsync failure'));
  await expect(batch(started, 5, 6)).rejects.toThrow('retirement fsync failure');
  expect(await readFile(join(started.store.root, 'checkpoint.json'))).toEqual(checkpoint);
  expect((await started.read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4]);
});
it('recovers a persisted retirement intent after partial cleanup without restoring authentication', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4);
  vi.spyOn(files, 'removeJournalFile').mockRejectedValueOnce(new Error('retirement unlink failure'));
  await expect(batch(started, 5, 6)).rejects.toThrow('retirement unlink failure');
  const saved = await started.read();
  expect(saved.events.map((record) => record.index)).toEqual([3, 4]);
  expect(saved.retention).toMatchObject({ from: 3, through: 4, cleanupPending: true,
    gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } });
  vi.restoreAllMocks();
  const restored = await resume(started, 5);
  expect(restored.ack.ackThrough).toBe(4);
  await restored.journal.appendBatch([5, 6].map((n) => restored.bridge.accept(event(n, { sessionEpoch: 'epoch-2' }))));
  expect((await started.read()).retention?.cleanupPending).toBe(false);
  expect((await started.read()).events.map((record) => record.index)).toEqual([3, 4, 5, 6]);
});
it('preserves an uncommitted new tail and refuses automatic recovery after append checkpoint failure', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4);
  const original = files.writeJournalCheckpoint;
  vi.spyOn(files, 'writeJournalCheckpoint').mockImplementation(async (...args) => {
    const value = args[1] as { index: number };
    if (value.index === 6) { throw new Error('append fsync failure'); }
    return original(...args);
  });
  await expect(batch(started, 5, 6)).rejects.toThrow('append fsync failure');
  expect(await readdir(started.store.root)).toContain('0000000000000005-0000000000000006.seg');
  await expect(started.read()).rejects.toThrow('JOURNAL_CORRUPT');
  await expect(resume(started, 5)).rejects.toThrow('JOURNAL_CORRUPT');
});
it.each(['missing', 'tamper', 'unknown'])('refuses %s retained evidence even with a warm query cache', async (change) => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4); await batch(started, 5, 6);
  await started.read();
  const file = join(started.store.root, '0000000000000005-0000000000000006.seg');
  if (change === 'missing') { await rm(file); }
  else if (change === 'tamper') { await writeFile(file, '{}'); }
  else { await writeFile(join(started.store.root, 'unknown.seg'), '{}', { mode: 0o600 }); }
  await expect(started.read()).rejects.toThrow('JOURNAL_CORRUPT');
});
it('recomputes retained clock evidence after eviction when checksums have been rewritten', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4); await batch(started, 5, 6);
  const file = join(started.store.root, '0000000000000005-0000000000000006.seg');
  const segment = JSON.parse(await readFile(file, 'utf8'));
  segment.records[1].clock.mergeable = false;
  const { hash: _recordHash, ...record } = segment.records[1]; void _recordHash;
  segment.records[1].hash = hashContract(record);
  segment.bytes = Buffer.byteLength(JSON.stringify(segment.records));
  const { hash: _segmentHash, ...body } = segment; void _segmentHash;
  segment.hash = hashContract(body);
  const old = await readFile(file), text = JSON.stringify(segment);
  await writeFile(file, text);
  const checkpointFile = join(started.store.root, 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  checkpoint.lastHash = segment.records[1].hash; checkpoint.bytes += Buffer.byteLength(text) - old.length;
  await writeFile(checkpointFile, JSON.stringify(checkpoint));
  await expect(started.read()).rejects.toThrow('JOURNAL_CORRUPT');
});
it('rejects a forged incoming clock before authorizing any retention loss', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4);
  const checkpoint = await readFile(join(started.store.root, 'checkpoint.json'));
  const item = started.receiver.accept(event(5)); item.clock.mergeable = false;
  await expect(started.store.appendBatch([item])).rejects.toThrow('JOURNAL_CORRUPT');
  expect(await readFile(join(started.store.root, 'checkpoint.json'))).toEqual(checkpoint);
  expect((await started.read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4]);
});
it('refuses a substituted retired segment instead of deleting unapproved bytes', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4);
  vi.spyOn(files, 'removeJournalFile').mockRejectedValueOnce(new Error('retirement unlink failure'));
  await expect(batch(started, 5, 6)).rejects.toThrow('retirement unlink failure');
  vi.restoreAllMocks();
  const name = join(started.store.root, '0000000000000001-0000000000000002.seg');
  const segment = JSON.parse(await readFile(name, 'utf8'));
  segment.records[0].sourceDigest = 'b'.repeat(64);
  for (let n = 0; n < segment.records.length; n++) {
    if (n) { segment.records[n].previousHash = segment.records[n - 1].hash; }
    const { hash: _hash, ...body } = segment.records[n]; void _hash;
    segment.records[n].hash = hashContract(body);
  }
  segment.bytes = Buffer.byteLength(JSON.stringify(segment.records));
  const { hash: _hash, ...body } = segment; void _hash;
  segment.hash = hashContract(body);
  const text = JSON.stringify(segment); await writeFile(name, text);
  await expect(resume(started, 5)).rejects.toThrow('JOURNAL_CORRUPT');
  expect(await readFile(name, 'utf8')).toBe(text);
});
it('does not adopt an unlisted valid old segment during pending cleanup', async () => {
  const started = await start();
  await batch(started, 1, 2); await batch(started, 3, 4);
  vi.spyOn(files, 'removeJournalFile').mockRejectedValueOnce(new Error('retirement unlink failure'));
  await expect(batch(started, 5, 6)).rejects.toThrow('retirement unlink failure');
  vi.restoreAllMocks();
  const segment = JSON.parse(await readFile(join(started.store.root, '0000000000000001-0000000000000002.seg'), 'utf8'));
  const records = segment.records.slice(0, 1);
  const body = { schemaVersion: '1.1', from: 1, through: 1, records, bytes: Buffer.byteLength(JSON.stringify(records)) };
  const name = join(started.store.root, '0000000000000001-0000000000000001.seg');
  const text = JSON.stringify({ ...body, hash: hashContract(body) });
  await writeFile(name, text, { mode: 0o600 });
  await expect(resume(started, 5)).rejects.toThrow('JOURNAL_CORRUPT');
  expect(await readFile(name, 'utf8')).toBe(text);
});
it('rolls whole segments at the byte quota without exceeding the existing disk budget', async () => {
  const started = await start(4096, 32768);
  let sequence = 0;
  for (let n = 0; n < 12; n++) {
    await batch(started, sequence + 1, sequence + 2); sequence += 2;
    let bytes = 0;
    for (const name of await readdir(started.store.root)) { bytes += (await readFile(join(started.store.root, name))).length; }
    expect(bytes).toBeLessThanOrEqual(32768);
  }
  const saved = await started.read();
  expect(saved.events.at(-1)!.index).toBe(24);
  expect(saved.retention?.from).toBeGreaterThan(1);
  expect(saved.retention?.gap?.missingThrough).toBe(saved.events[0].index - 1);
});

it('removes retired message identities from shared history while keeping surviving identities', async () => {
  const started = await start(2);
  await batch(started, 1, 1); await batch(started, 2, 2); await batch(started, 3, 3);
  const fourth = started.receiver.accept(event(4));
  fourth.event.messageId = event(1).messageId;
  await started.store.appendBatch([fourth]);
  expect((await started.read()).events.map((record) => record.index)).toEqual([3, 4]);
  const checkpoint = await readFile(join(started.store.root, 'checkpoint.json'));
  const fifth = started.receiver.accept(event(5));
  fifth.event.messageId = event(3).messageId;
  await expect(started.store.appendBatch([fifth])).rejects.toThrow('JOURNAL_CORRUPT');
  expect(await readFile(join(started.store.root, 'checkpoint.json'))).toEqual(checkpoint);
  expect((await started.read()).events.map((record) => record.index)).toEqual([3, 4]);
});
