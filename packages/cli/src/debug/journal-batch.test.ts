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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-journal-batch-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function start(maxEvents = 4096) {
  const handshake = createHandshake(identity);
  const store = await EventJournal.create(root, randomUUID(), handshake, {
    maxEvents, segmented: true, resume: { peer: handshake, epoch: 'epoch-1' },
  });
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  return { store, receiver, handshake };
}
it('commits a bounded batch as one immutable segment and resumes its complete prefix', async () => {
  const { store, receiver, handshake } = await start();
  expect(store.appendBatch, 'bounded journal batch API is missing').toBeTypeOf('function');
  const records = await store.appendBatch([1, 2, 3].map((n) => receiver.accept(event(n))));
  expect(records.map((record) => record.index)).toEqual([1, 2, 3]);
  expect(await readdir(store.root)).toEqual(expect.arrayContaining(['00000001-00000003.seg']));
  expect((await EventJournal.read(root, store.sessionId, store.streamId)).events).toEqual(records);
  const restored = await EventJournal.resume(root, store.sessionId, store.streamId, handshake, handshake, {
    ...identity, type: 'resume', protocolVersion: '1.1', previousEpoch: 'epoch-1', sessionEpoch: 'epoch-2', resumeFrom: 4,
  });
  await restored.journal.append(restored.bridge.accept(event(4, { sessionEpoch: 'epoch-2' })));
  expect((await EventJournal.read(root, store.sessionId, store.streamId)).events.map((r) => r.index)).toEqual([1, 2, 3, 4]);
  await expect(store.appendBatch([receiver.accept(event(4))])).rejects.toThrow('JOURNAL_WRITER_STALE');
});
it('preflights the whole batch before writing on quota or sequence failure', async () => {
  const { store, receiver } = await start(2);
  expect(store.appendBatch).toBeTypeOf('function');
  const before = await readFile(join(store.root, 'checkpoint.json'));
  await expect(store.appendBatch([1, 2, 3].map((n) => receiver.accept(event(n))))).rejects.toThrow('JOURNAL_LIMIT');
  expect(await readdir(store.root)).toEqual(['checkpoint.json', 'manifest.json']);
  expect(await readFile(join(store.root, 'checkpoint.json'))).toEqual(before);
  await expect(store.appendBatch([receiver.accept(event(1))])).rejects.toThrow('JOURNAL_SEQUENCE_INVALID');
});
it('rejects an empty or oversized batch without consuming disk space', async () => {
  const { store, receiver } = await start();
  expect(store.appendBatch).toBeTypeOf('function');
  await expect(store.appendBatch([])).rejects.toThrow('JOURNAL_BATCH_INVALID');
  await expect(store.appendBatch(Array.from({ length: 65 }, (_, n) => receiver.accept(event(n + 1)))))
    .rejects.toThrow('JOURNAL_BATCH_INVALID');
  expect(await readdir(store.root)).toEqual(['checkpoint.json', 'manifest.json']);
});
it('preserves and rejects an uncommitted segment after a checkpoint failure', async () => {
  const { store, receiver } = await start();
  expect(store.appendBatch).toBeTypeOf('function');
  const checkpoint = join(store.root, 'checkpoint.json'), before = await readFile(checkpoint);
  vi.spyOn(files, 'writeJournalCheckpoint').mockRejectedValueOnce(new Error('injected checkpoint failure'));
  await expect(store.appendBatch([1, 2].map((n) => receiver.accept(event(n))))).rejects.toThrow('injected checkpoint failure');
  expect(await readFile(checkpoint)).toEqual(before);
  expect(await readdir(store.root)).toContain('00000001-00000002.seg');
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
});
it.each(['tamper', 'truncate', 'tail', 'rename', 'mixed'])('refuses %s segment corruption', async (change) => {
  const { store, receiver } = await start();
  expect(store.appendBatch).toBeTypeOf('function');
  await store.appendBatch([1, 2].map((n) => receiver.accept(event(n))));
  const file = join(store.root, '00000001-00000002.seg'), bytes = await readFile(file);
  if (change === 'tamper') {
    const value = JSON.parse(bytes.toString()); value.records[1].event.payload.summary = 'changed';
    await writeFile(file, JSON.stringify(value));
  } else if (change === 'truncate') { await writeFile(file, bytes.subarray(0, bytes.length - 1)); }
  else if (change === 'tail') { await rm(file); }
  else if (change === 'rename') { await rm(file); await writeFile(join(store.root, '00000002-00000003.seg'), bytes, { mode: 0o600 }); }
  else { await writeFile(join(store.root, '00000003.json'), '{}', { mode: 0o600 }); }
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
});

it('reports the hard event limit without a schema error or changing the acknowledged prefix', async () => {
  const { store, receiver } = await start();
  for (let first = 1; first <= 4096; first += 64) {
    await store.appendBatch(Array.from({ length: 64 }, (_, n) => receiver.accept(event(first + n))));
  }
  const before = await readFile(join(store.root, 'checkpoint.json'));
  await expect(store.appendBatch([receiver.accept(event(4097))])).rejects.toThrow('JOURNAL_LIMIT');
  expect(await readFile(join(store.root, 'checkpoint.json'))).toEqual(before);
  expect((await EventJournal.read(root, store.sessionId, store.streamId)).events).toHaveLength(4096);
}, 10000);

it.each(['clock', 'epoch', 'channel'])('recomputes %s evidence even if segment and event hashes are rewritten', async (change) => {
  const { store, receiver } = await start();
  await store.appendBatch([receiver.accept(event(1))]);
  const file = join(store.root, '00000001-00000001.seg');
  const segment = JSON.parse(await readFile(file, 'utf8'));
  const record = segment.records[0];
  if (change === 'clock') { record.clock.mergeable = false; }
  else if (change === 'epoch') { record.event.sessionEpoch = 'unknown-epoch'; }
  else { record.event.protocolVersion = '1.0'; }
  const { hash: recordHash, ...recordBody } = record;
  void recordHash;
  record.hash = hashContract(recordBody);
  segment.bytes = Buffer.byteLength(JSON.stringify(segment.records));
  const { hash: segmentHash, ...segmentBody } = segment;
  void segmentHash;
  segment.hash = hashContract(segmentBody);
  const text = JSON.stringify(segment);
  await writeFile(file, text);
  const checkpoint = JSON.parse(await readFile(join(store.root, 'checkpoint.json'), 'utf8'));
  checkpoint.lastHash = record.hash;
  checkpoint.bytes = Buffer.byteLength(await readFile(join(store.root, 'manifest.json'))) + Buffer.byteLength(text);
  await writeFile(join(store.root, 'checkpoint.json'), JSON.stringify(checkpoint));
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
});
