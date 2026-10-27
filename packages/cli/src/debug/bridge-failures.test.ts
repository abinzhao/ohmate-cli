/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PairingAuthority, createPairingClient } from '../debug-protocol/security.js';
import { identity, event } from '../debug-protocol/test-fixtures.js';
import { BridgeConnection } from './bridge-connection.js';
import { BridgeHub } from './bridge-hub.js';
import { EventJournal } from './event-journal.js';
import type { BridgeStatus } from './bridge-status.js';
import { startWebServer } from '../web/web-server.js';
import { createExecutionContext, createRuntime } from '../runtime/index.js';

class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
let root: string;
const connections: BridgeConnection[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-bridge-failure-')); });
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const connection of connections.splice(0)) { await connection.close(); }
  await rm(root, { recursive: true, force: true });
});
async function paired(publish: (update: Partial<BridgeStatus>) => Promise<void> = async () => {}, sessionTtlMs = 600000,
  previous?: { authority: PairingAuthority; sessionId: string }, calibrated = false, batched = false) {
  const authority = previous?.authority ?? new PairingAuthority({ sessionTtlMs });
  const sessionId = previous?.sessionId ?? randomUUID();
  const invitation = authority.issue(identity);
  const client = createPairingClient(invitation, { appConfirmed: true });
  const socket = new Socket();
  const released = vi.fn();
  const connection = new BridgeConnection(socket as unknown as WebSocket, {
    authority, dataDir: root, sessionId, publish, released,
  });
  connections.push(connection);
  socket.emit('message', Buffer.from(JSON.stringify(client.request())), false);
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  const channel = client.finish(socket.sent[0]);
  const ready = channel.open(socket.sent[1]) as { sessionEpoch: string };
  const confirm = (resume?: { streamId: string; previousEpoch: string; resumeFrom: number }) =>
    socket.emit('message', Buffer.from(JSON.stringify(channel.seal({ type: 'ready', ...ready,
      ...(calibrated ? { clockSync: 'four-timestamp-v1' } : {}), ...(batched ? { eventBatch: 'events-v1' } : {}),
      ...(resume ? { resume } : {}) }))), false);
  return { connection, socket, channel, ready, confirm, released, invitation, authority, sessionId };
}

it('acknowledges the complete encrypted batch only after its durable commit and publishes once', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, false, true);
  pairing.confirm();
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  expect(pairing.channel.open(pairing.socket.sent[2])).toMatchObject({ type: 'connected', eventBatch: 'events-v1' });
  const append = EventJournal.prototype.appendBatch;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(EventJournal.prototype, 'appendBatch').mockImplementation(async function (this: EventJournal, accepted) {
    entered(); await gate; return append.call(this, accepted);
  });
  const events = [1, 2, 3].map((n) => event(n, { ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch }));
  try {
    pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal({ type: 'event-batch', version: '1', events }))), false);
    await reached;
    expect(pairing.socket.sent).toHaveLength(3);
    expect(publish.mock.calls.some(([update]) => update.ackThrough! > 0)).toBe(false);
  } finally { release(); }
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(4));
  expect(pairing.channel.open(pairing.socket.sent[3])).toMatchObject({ type: 'ack', ackThrough: 3 });
  expect(publish.mock.calls.filter(([update]) => update.ackThrough! > 0)).toHaveLength(1);
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  expect((await EventJournal.read(root, pairing.sessionId, streamId)).events.map((r) => r.index)).toEqual([1, 2, 3]);
});

it('closes a rejected encrypted batch without committing or acknowledging its valid prefix', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, false, true);
  pairing.confirm(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  expect(pairing.channel.open(pairing.socket.sent[2])).toMatchObject({ type: 'connected', eventBatch: 'events-v1' });
  const events = [1, 2].map((n) => event(n, { ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch }));
  events[1].device = 'different';
  pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal({ type: 'event-batch', version: '1', events }))), false);
  await vi.waitFor(() => expect(pairing.socket.readyState).toBe(3));
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'IDENTITY_MISMATCH' }));
  expect(publish.mock.calls.some(([update]) => update.ackThrough! > 0)).toBe(false);
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  expect((await EventJournal.read(root, pairing.sessionId, streamId)).events).toEqual([]);
});

it('drains an in-flight batch after close without publishing or sending its acknowledgement', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, false, true);
  pairing.confirm(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  expect(pairing.channel.open(pairing.socket.sent[2])).toMatchObject({ type: 'connected', eventBatch: 'events-v1' });
  const append = EventJournal.prototype.appendBatch;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(EventJournal.prototype, 'appendBatch').mockImplementation(async function (this: EventJournal, accepted) {
    entered(); await gate; return append.call(this, accepted);
  });
  try {
    pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal({ type: 'event-batch', version: '1',
      events: [event(1, { ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch })] }))), false);
    await reached; pairing.socket.close();
  } finally { release(); await pairing.connection.close(); }
  expect(pairing.socket.sent).toHaveLength(3);
  expect(publish.mock.calls.some(([update]) => update.ackThrough! > 0)).toBe(false);
  expect(pairing.released).toHaveBeenCalledTimes(1);
});

it('resumes a batch with retained replay and new events without writing replayed records twice', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const original = await paired(publish, 600000, undefined, false, true);
  original.confirm(); await vi.waitFor(() => expect(original.socket.sent).toHaveLength(3));
  original.channel.open(original.socket.sent[2]);
  const events = [1, 2, 3].map((n) => event(n, {
    ...original.invitation.handshake.identity, sessionEpoch: original.ready.sessionEpoch,
  }));
  original.socket.emit('message', Buffer.from(JSON.stringify(original.channel.seal({ type: 'event-batch', version: '1', events }))), false);
  await vi.waitFor(() => expect(original.socket.sent).toHaveLength(4));
  expect(original.channel.open(original.socket.sent[3])).toMatchObject({ ackThrough: 3 });
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  original.socket.close(); await original.connection.close();
  const pairing = await paired(publish, 600000, original, false, true);
  pairing.confirm({ streamId, previousEpoch: original.ready.sessionEpoch, resumeFrom: 2 });
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  expect(pairing.channel.open(pairing.socket.sent[2])).toMatchObject({ type: 'resumed', ackThrough: 1, eventBatch: 'events-v1' });
  const resumed = [2, 3, 4].map((n) => event(n, {
    ...original.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch,
  }));
  const send = () => pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal({
    type: 'event-batch', version: '1', events: resumed,
  }))), false);
  send(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(4));
  expect(pairing.channel.open(pairing.socket.sent[3])).toMatchObject({ ackThrough: 4 });
  send(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(5));
  expect(pairing.channel.open(pairing.socket.sent[4])).toMatchObject({ ackThrough: 4 });
  expect((await EventJournal.read(root, pairing.sessionId, streamId)).events.map((r) => r.index)).toEqual([1, 2, 3, 4]);
});

it('fails backpressure with a blocked batch without sending an acknowledgement for the drained write', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, false, true);
  pairing.confirm(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  pairing.channel.open(pairing.socket.sent[2]);
  const append = EventJournal.prototype.appendBatch;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(EventJournal.prototype, 'appendBatch').mockImplementation(async function (this: EventJournal, accepted) {
    entered(); await gate; return append.call(this, accepted);
  });
  const send = (n: number) => pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal({
    type: 'event-batch', version: '1', events: [event(n, {
      ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch,
    })],
  }))), false);
  try {
    send(1); await reached;
    for (let n = 2; n <= 9; n++) { send(n); }
    await vi.waitFor(() => expect(pairing.socket.readyState).toBe(3));
  } finally { release(); await pairing.connection.close(); }
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'FRAME_BACKPRESSURE' }));
  expect(publish.mock.calls.some(([update]) => update.ackThrough! > 0)).toBe(false);
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  expect((await EventJournal.read(root, pairing.sessionId, streamId)).events.map((r) => r.index)).toEqual([1]);
});

it('measures encrypted clock replies and persists evidence before acknowledging an event', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, true);
  pairing.confirm();
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(4));
  expect(pairing.channel.open(pairing.socket.sent[2])).toMatchObject({ type: 'connected' });
  const probe = pairing.channel.open(pairing.socket.sent[3]) as { probeId: string; sessionEpoch: string; t0: string };
  expect(probe).toMatchObject({ type: 'clock-probe', version: '1', sessionEpoch: pairing.ready.sessionEpoch });
  const t1 = process.hrtime.bigint();
  pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal({
    type: 'clock-reply', version: '1', probeId: probe.probeId, sessionEpoch: probe.sessionEpoch, t0: probe.t0,
    clockId: 'peer-clock', bootId: 'peer-boot',
    t1: t1.toString(), t2: t1.toString(), precisionNs: '1000000',
  }))), false);
  // Reply handling is queued ahead of this event, with both arrival times captured.
  pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal(event(1, {
    ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch,
    clockId: 'peer-clock', bootId: 'peer-boot', monotonicNs: process.hrtime.bigint().toString(),
  })))), false);
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(5));
  expect(pairing.channel.open(pairing.socket.sent[4])).toMatchObject({ type: 'ack', ackThrough: 1 });
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  const saved = await EventJournal.read(root, pairing.sessionId, streamId);
  expect(saved.events[0].clock).toMatchObject({ alignment: {
    observation: { sessionEpoch: probe.sessionEpoch, sample: { probeId: probe.probeId, t0: probe.t0 } },
  } });
  expect(saved.events[0].clock.alignment!.status).toMatch(/^(calibrated|over-budget)$/);
  expect(saved.events[0].clock.mergeable).toBe(saved.events[0].clock.alignment!.status === 'calibrated');
});

it('does not claim calibration for an older producer with a zero peer uncertainty', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish);
  pairing.confirm();
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal(event(1, {
    ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch, offsetUncertaintyMs: 0,
  })))), false);
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(4));
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  expect((await EventJournal.read(root, pairing.sessionId, streamId)).events[0].clock)
    .toMatchObject({ mergeable: false, alignment: { status: 'not-calibrated' } });
});

it.each(['unknown-probe', 'epoch', 'timestamp', 'replay'])('refuses a clock reply with %s without an event ack', async (change) => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, true);
  pairing.confirm(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(4));
  pairing.channel.open(pairing.socket.sent[2]);
  const probe = pairing.channel.open(pairing.socket.sent[3]) as { probeId: string; sessionEpoch: string; t0: string };
  const t1 = process.hrtime.bigint().toString();
  const reply = { type: 'clock-reply', version: '1', probeId: probe.probeId, sessionEpoch: probe.sessionEpoch, t0: probe.t0,
    clockId: 'peer-clock', bootId: 'peer-boot', t1, t2: t1, precisionNs: '1000000' };
  if (change === 'unknown-probe') { reply.probeId = 'unknown'; }
  if (change === 'epoch') { reply.sessionEpoch = randomUUID(); }
  if (change === 'timestamp') { reply.t0 = '0'; }
  const emit = () => pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal(reply))), false);
  emit(); if (change === 'replay') { emit(); }
  await vi.waitFor(() => expect(pairing.socket.readyState).toBe(3));
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CLOCK_SAMPLE_INVALID' }));
  expect(publish.mock.calls.some(([update]) => update.ackThrough && update.ackThrough > 0)).toBe(false);
});

it('closes an idle connection whose calibration probe has no reply', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 600000, undefined, true);
  pairing.confirm(); await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(4));
  await vi.advanceTimersByTimeAsync(10001);
  expect(pairing.socket.readyState).toBe(3);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CLOCK_SAMPLE_INVALID' }));
  expect(pairing.released).toHaveBeenCalledTimes(1);
});

it('does not publish connected when the socket closes during journal creation', async () => {
  const original = EventJournal.create.bind(EventJournal);
  let continueWrite!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { continueWrite = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(EventJournal, 'create').mockImplementation(async (...args) => { entered(); await blocked; return original(...args); });
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish);
  pairing.confirm(); await started;
  pairing.socket.close();
  continueWrite(); await pairing.connection.close();
  expect(publish.mock.calls.map(([update]) => update.state)).not.toContain('connected');
  expect(pairing.released).toHaveBeenCalledTimes(1);
});

it('drains a resumed checkpoint after close without publishing connected or acknowledging it', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const original = await paired(publish);
  original.confirm(); await vi.waitFor(() => expect(original.socket.sent).toHaveLength(3));
  const streamId = publish.mock.calls.find(([update]) => update.state === 'connected')![0].streamId!;
  original.socket.close(); await original.connection.close();
  publish.mockClear();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const resume = EventJournal.resume.bind(EventJournal);
  vi.spyOn(EventJournal, 'resume').mockImplementation(async (...args) => { entered(); await blocked; return resume(...args); });
  const pairing = await paired(publish, 600000, original);
  pairing.confirm({ streamId, previousEpoch: original.ready.sessionEpoch, resumeFrom: 1 });
  try {
    await started; pairing.socket.close();
  } finally { release(); await pairing.connection.close(); }
  expect(publish.mock.calls.map(([update]) => update.state)).not.toContain('connected');
  expect(pairing.socket.sent).toHaveLength(2);
  expect(pairing.released).toHaveBeenCalledTimes(1);
  expect((await EventJournal.read(root, original.sessionId, streamId)).events).toEqual([]);
});

it('terminates a connection when status persistence fails without leaking a rejected callback', async () => {
  const pairing = await paired(async () => { throw new Error('disk unavailable'); });
  pairing.confirm();
  await vi.waitFor(() => expect(pairing.socket.readyState).toBe(3));
  await expect(pairing.connection.close()).resolves.toBeUndefined();
  expect(pairing.released).toHaveBeenCalledTimes(1);
});

it('expires an idle confirmed session and releases its channel without needing another frame', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish, 1000);
  pairing.confirm();
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  await vi.advanceTimersByTimeAsync(1001);
  expect(pairing.socket.readyState).toBe(3);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ state: 'expired', reason: 'KEY_EXPIRED' }));
  expect(pairing.released).toHaveBeenCalledTimes(1);
});

it('refuses to queue an acknowledgement beyond the outbound socket budget', async () => {
  const publish = vi.fn(async (update: Partial<BridgeStatus>) => { void update; });
  const pairing = await paired(publish);
  pairing.confirm();
  await vi.waitFor(() => expect(pairing.socket.sent).toHaveLength(3));
  pairing.socket.bufferedAmount = 512 * 1024;
  pairing.socket.emit('message', Buffer.from(JSON.stringify(pairing.channel.seal(event(1, {
    ...pairing.invitation.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch,
  })))), false);
  await vi.waitFor(() => expect(pairing.socket.readyState).toBe(3));
  expect(pairing.socket.sent.filter((value) => (value as { type: string }).type === 'sealed')).toHaveLength(2);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'FRAME_BACKPRESSURE' }));
});

it('allows a later publication after a rejected disk write', async () => {
  const onStatus = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(undefined);
  const hub = new BridgeHub({ dataDir: root, sessionId: randomUUID(), workspaceId: identity.project, onStatus });
  try {
    await expect(hub.publish({ state: 'pairing' })).rejects.toThrow('disk unavailable');
    await expect(hub.publish({ state: 'revoked' })).resolves.toBeUndefined();
    expect(onStatus).toHaveBeenCalledTimes(2);
  } finally { await hub.close().catch(() => {}); }
});

it('closes the HTTP listener and runs cleanup even when bridge persistence rejects', async () => {
  const context = await createExecutionContext({ cwd: root, dataDir: root });
  const onClose = vi.fn(async () => {});
  const server = await startWebServer(await createRuntime(), context, {
    debugSessionId: randomUUID(), onBridgeStatus: async () => { throw new Error('disk unavailable'); }, onClose,
  });
  // Inject the persistence fault through the real route rather than a fake hub.
  const response = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: server.ticket() }) });
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const bootstrap = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const failed = await fetch(`${server.origin}/api/v1/debug/pairing`, { method: 'POST',
    headers: { cookie, origin: server.origin, 'x-ohmate-csrf': bootstrap.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ ...identity, fingerprint: undefined, project: context.workspaceId }) });
  expect(failed.status).toBe(500);
  try {
    await expect(server.close()).rejects.toThrow('disk unavailable');
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(fetch(server.origin)).rejects.toThrow();
  } finally { await server.close().catch(() => {}); }
});
