/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PairingAuthority, createPairingClient } from '../debug-protocol/security.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { BridgeConnection } from './bridge-connection.js';
import { EventJournal } from './event-journal.js';
import * as files from './journal-files.js';
import type { BridgeStatus } from './bridge-status.js';

class Socket extends EventEmitter {
  OPEN = 1; readyState = 1; bufferedAmount = 0; sent: unknown[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
let root: string, authority: PairingAuthority, sessionId: string;
const connections: BridgeConnection[] = [];
const updates: Partial<BridgeStatus>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-bridge-retention-'));
  authority = new PairingAuthority(); sessionId = randomUUID(); updates.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) { await connection.close(); }
  authority.close(); await rm(root, { recursive: true, force: true });
});
async function paired(publish = async (update: Partial<BridgeStatus>) => { updates.push(update); }) {
  const invitation = authority.issue(identity), client = createPairingClient(invitation, { appConfirmed: true });
  const socket = new Socket();
  const connection = new BridgeConnection(socket as unknown as WebSocket, {
    authority, dataDir: root, sessionId, journal: { maxEvents: 4 }, publish, released: () => {},
  });
  connections.push(connection);
  socket.emit('message', Buffer.from(JSON.stringify(client.request())), false);
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  const channel = client.finish(socket.sent[0]), ready = channel.open(socket.sent[1]) as { sessionEpoch: string };
  const send = (value: unknown) => socket.emit('message', Buffer.from(JSON.stringify(channel.seal(value))), false);
  return { socket, connection, channel, ready, send, invitation };
}
type Pair = Awaited<ReturnType<typeof paired>>;
async function confirm(pair: Pair, options: Record<string, unknown> = { retention: 'rolling-v1', eventBatch: 'events-v1' }) {
  pair.send({ type: 'ready', sessionEpoch: pair.ready.sessionEpoch, ...options });
  await vi.waitFor(() => expect(pair.socket.sent).toHaveLength(3));
  return pair.channel.open(pair.socket.sent[2]);
}
function batch(pair: Pair, from: number, through = from + 1) {
  return { type: 'event-batch', version: '1', events: Array.from({ length: through - from + 1 }, (_, n) =>
    event(from + n, { ...pair.invitation.handshake.identity, sessionEpoch: pair.ready.sessionEpoch })) };
}
async function append(pair: Pair, from: number, through = from + 1) {
  const count = pair.socket.sent.length; pair.send(batch(pair, from, through));
  await vi.waitFor(() => expect(pair.socket.sent).toHaveLength(count + 1));
  expect(pair.channel.open(pair.socket.sent[count])).toMatchObject({ type: 'ack', ackThrough: through });
}
async function filled() {
  const pair = await paired();
  expect(await confirm(pair)).toMatchObject({ type: 'connected', retention: 'rolling-v1', eventBatch: 'events-v1' });
  await append(pair, 1); await append(pair, 3); await append(pair, 5);
  const streamId = updates.find((update) => update.state === 'connected')!.streamId!;
  return { pair, streamId };
}
it('only selects rolling history through an explicit encrypted ready and continues beyond the fixed quota', async () => {
  const { streamId } = await filled();
  const saved = await EventJournal.read(root, sessionId, streamId);
  expect(saved).toMatchObject({ manifest: { schemaVersion: '1.4' }, retention: { from: 3, through: 6 } });
  expect(saved.events.map((value) => value.index)).toEqual([3, 4, 5, 6]);
  expect(updates.filter((value) => value.reason === 'JOURNAL_LIMIT')).toHaveLength(0);
});
it('keeps a legacy batched producer on the existing manifest and rejects its fixed limit', async () => {
  const pair = await paired();
  expect(await confirm(pair, { eventBatch: 'events-v1' })).toMatchObject({ type: 'connected', eventBatch: 'events-v1' });
  await append(pair, 1); await append(pair, 3);
  pair.send(batch(pair, 5)); await vi.waitFor(() => expect(pair.socket.readyState).toBe(3));
  const streamId = updates.find((update) => update.state === 'connected')!.streamId!;
  expect((await EventJournal.read(root, sessionId, streamId)).manifest.schemaVersion).toBe('1.3');
  expect(updates).toContainEqual({ gap: { missingFrom: 5, missingThrough: 6 } });
  expect(updates).toContainEqual({ reason: 'JOURNAL_LIMIT', state: 'degraded' });
});
it.each([{ retention: 'rolling-v1' }, { retention: 'other', eventBatch: 'events-v1' }])(
  'rejects invalid retention negotiation before creating an archive: %j', async (options) => {
    const pair = await paired(); pair.send({ type: 'ready', ...pair.ready, ...options });
    await vi.waitFor(() => expect(pair.socket.readyState).toBe(3));
    expect(updates.some((value) => value.state === 'connected')).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
it('resumes retained encrypted replay in a newly paired epoch without duplicating the durable records', async () => {
  const { pair: original, streamId } = await filled();
  original.socket.close(); await original.connection.close();
  const pair = await paired();
  expect(await confirm(pair, { retention: 'rolling-v1', eventBatch: 'events-v1',
    resume: { streamId, previousEpoch: original.ready.sessionEpoch, resumeFrom: 3 } }))
    .toMatchObject({ type: 'resumed', retention: 'rolling-v1', streamId, ackThrough: 2 });
  await append(pair, 3, 7);
  const saved = await EventJournal.read(root, sessionId, streamId);
  expect(saved.events.map((value) => value.index)).toEqual([5, 6, 7]);
  expect(saved.events.at(-1)!.event.sessionEpoch).toBe(pair.ready.sessionEpoch);
});
it.each(['missing-opt-in', 'evicted', 'epoch'] as const)('rejects %s recovery without changing the checkpoint', async (reason) => {
  const { pair: original, streamId } = await filled();
  original.socket.close(); await original.connection.close();
  const directory = (await files.journalDirectory(root, sessionId, streamId, false));
  const before = await readFile(join(directory, 'checkpoint.json'));
  const pair = await paired();
  pair.send({ type: 'ready', ...pair.ready, eventBatch: 'events-v1',
    ...(reason !== 'missing-opt-in' ? { retention: 'rolling-v1' } : {}),
    resume: { streamId, previousEpoch: reason === 'epoch' ? randomUUID() : original.ready.sessionEpoch,
      resumeFrom: reason === 'evicted' ? 1 : 3 } });
  await vi.waitFor(() => expect(pair.socket.readyState).toBe(3));
  expect(await readFile(join(directory, 'checkpoint.json'))).toEqual(before);
  expect(updates.at(-1)).toMatchObject({ reason: reason === 'missing-opt-in' ? 'JOURNAL_BATCH_INVALID' :
    reason === 'evicted' ? 'SEQUENCE_GAP' : 'EPOCH_MISMATCH' });
  if (reason === 'evicted') { expect(updates.at(-1)).toMatchObject({ gap: { missingFrom: 1, missingThrough: 2 } }); }
});
it('does not convert an existing nonrolling archive when recovery requests rolling retention', async () => {
  const original = await paired(); await confirm(original, { eventBatch: 'events-v1' }); await append(original, 1);
  const streamId = updates.find((update) => update.state === 'connected')!.streamId!;
  original.socket.close(); await original.connection.close();
  const pair = await paired(); pair.send({ type: 'ready', ...pair.ready, eventBatch: 'events-v1', retention: 'rolling-v1',
    resume: { streamId, previousEpoch: original.ready.sessionEpoch, resumeFrom: 3 } });
  await vi.waitFor(() => expect(pair.socket.readyState).toBe(3));
  expect(updates.at(-1)).toMatchObject({ reason: 'JOURNAL_BATCH_INVALID' });
  expect((await EventJournal.read(root, sessionId, streamId)).manifest.schemaVersion).toBe('1.3');
});
it.each(['checkpoint', 'status'] as const)('never acknowledges a rolled batch after %s persistence fails', async (failure) => {
  const publish = async (update: Partial<BridgeStatus>) => {
    if (failure === 'status' && update.ackThrough === 6) { throw new Error('status failure'); }
    updates.push(update);
  };
  const pair = await paired(publish); await confirm(pair); await append(pair, 1); await append(pair, 3);
  const streamId = updates.find((update) => update.state === 'connected')!.streamId!;
  const original = files.writeJournalCheckpoint;
  if (failure === 'checkpoint') {
    vi.spyOn(files, 'writeJournalCheckpoint').mockImplementation(async (...args) => {
      if ((args[1] as { index: number }).index === 6) { throw new Error('checkpoint failure'); }
      return original(...args);
    });
  }
  const count = pair.socket.sent.length;
  pair.send(batch(pair, 5)); await vi.waitFor(() => expect(pair.socket.readyState).toBe(3));
  expect(pair.socket.sent.slice(count)).toEqual([{ type: 'error', code: 'BRIDGE_REJECTED' }]);
  expect(updates.some((value) => value.ackThrough === 6)).toBe(false);
  if (failure === 'checkpoint') { await expect(EventJournal.read(root, sessionId, streamId)).rejects.toThrow('JOURNAL_CORRUPT'); }
  else { expect((await EventJournal.read(root, sessionId, streamId)).retention?.through).toBe(6); }
});
