/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter, on, once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createExecutionContext, createRuntime, type ExecutionContext } from '../runtime/index.js';
import { processIdentity } from '../runtime/process-tree.js';
import { createDebugSession, updateDebugBridge } from '../debug/debug-state.js';
import { BridgeHub } from '../debug/bridge-hub.js';
import { EventJournal } from '../debug/event-journal.js';
import { createHandshake, createReadonlyBridge, type ReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { handleDebugEvents } from './debug-events.js';
import { startWebServer } from './web-server.js';
import { createPairingClient, type SecureChannel } from '../debug-protocol/security.js';
import type { WebServiceRecord } from './web-state.js';

class Sink extends EventEmitter {
  destroyed = false;
  chunks: string[] = [];
  blocked = false;
  ready = false;
  ended = false;
  writeHead() {}
  flushHeaders() { this.ready = true; this.emit('ready'); }
  write(value: string) { this.chunks.push(value); this.emit('write'); return !this.blocked; }
  destroy() { this.destroyed = true; this.emit('close'); }
  end() { this.ended = true; this.emit('end'); }
}
let root: string, context: ExecutionContext, journal: EventJournal, receiver: ReadonlyBridge;
let record: WebServiceRecord, hub: BridgeHub;
const streams: { controller: AbortController; promise: Promise<boolean> }[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-debug-live-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  await mkdir(context.dataDir, { mode: 0o700 });
  const id = randomUUID(), handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, id, handshake,
    { segmented: true, resume: { peer: handshake, epoch: 'epoch-1' } });
  receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  record = { pid: process.pid, identity: (await processIdentity(process.pid))!, cwd: root, projectRoot: null,
    origin: 'http://127.0.0.1:1', startedAt: new Date().toISOString(), controlSecret: 'a'.repeat(64), debugSessionId: id };
  hub = new BridgeHub({ dataDir: context.dataDir, sessionId: id, workspaceId: context.workspaceId,
    onStatus: (status) => updateDebugBridge(context.dataDir, record, status) });
  await createDebugSession(context.dataDir, record, hub.status());
  await hub.publish({ state: 'connected', streamId: journal.streamId, target: handshake.identity, authentication: 'pairing-proof', reason: null });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stream of streams) { stream.controller.abort(); }
  await Promise.allSettled(streams.map((stream) => stream.promise)); streams.length = 0;
  await hub?.close(); await rm(root, { recursive: true, force: true });
});
function follow(sink: Sink, after = 0, limit = 100, lastEventId?: string) {
  const url = new URL(`${record.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams/${journal.streamId}/live?after=${after}&limit=${limit}`);
  const controller = new AbortController();
  const promise = handleDebugEvents(context, { method: 'GET', headers: { 'last-event-id': lastEventId } } as unknown as IncomingMessage,
    sink as unknown as ServerResponse, url, controller.signal, hub);
  streams.push({ controller, promise });
  return { controller, promise };
}
async function append(first: number, through = first) {
  await journal.appendBatch(Array.from({ length: through - first + 1 }, (_, i) =>
    receiver.accept(event(first + i, { project: context.workspaceId }))));
  await hub.publish({ ackThrough: through });
}
function observe(sink: Sink, name: string, predicate: () => boolean, budget = 2000) {
  if (predicate()) { return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { sink.off(name, check); reject(new Error(`missing ${name} within ${budget} ms`)); }, budget);
    function check() {
      if (!predicate()) { return; }
      clearTimeout(timer); sink.off(name, check); resolve();
    }
    sink.on(name, check);
  });
}

async function rolling() {
  const handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, record.debugSessionId!, handshake,
    { maxEvents: 4, segmented: true, retention: 'rolling-v1', resume: { peer: handshake, epoch: 'epoch-1' } });
  await hub.publish({ streamId: journal.streamId });
  await append(1, 2); await append(3, 4); await append(5, 6);
}
it('announces the exact retention gap with a resumable id before any retained records', async () => {
  await rolling(); await hub.publish({ state: 'disconnected' });
  const sink = new Sink(); await follow(sink, 0, 2).promise;
  expect(sink.chunks[0]).toBe('id: 2\nevent: gap\ndata: ' + JSON.stringify({
    missingFrom: 1, missingThrough: 2, reason: 'retention-quota', retainedFrom: 3, retainedCount: 4, through: 6,
  }) + '\n\n');
  expect(sink.chunks[1]).toMatch(/^id: 3\n/);
  expect([...sink.chunks.join('').matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([2, 3, 4, 5, 6]);
});
it('uses Last-Event-ID for a partial gap and does not announce loss on a retained replay cursor', async () => {
  await rolling(); await hub.publish({ state: 'disconnected' });
  const missing = new Sink(); await follow(missing, 0, 100, '1').promise;
  expect(missing.chunks[0]).toContain('"missingFrom":2,"missingThrough":2');
  const retained = new Sink(); await follow(retained, 0, 100, '4').promise;
  expect(retained.chunks.join('')).not.toContain('event: gap');
  expect(retained.chunks[0]).toBe('event: retention\ndata: {"retainedFrom":3,"retainedCount":4,"through":6}\n\n');
  expect(retained.chunks[1]).toMatch(/^id: 5\n/);
});
it('waits for gap drain and reports a later quota gap without skipping or duplicating events', async () => {
  await rolling();
  const sink = new Sink(); sink.blocked = true;
  const following = follow(sink);
  await observe(sink, 'write', () => sink.chunks.length > 0);
  expect(sink.chunks[0]).toContain('event: gap');
  await append(7, 8); await append(9, 10); await append(11, 12);
  expect(sink.chunks).toHaveLength(1);
  sink.blocked = false; sink.emit('drain');
  await observe(sink, 'write', () => sink.chunks.join('').includes('id: 12\n'));
  following.controller.abort(); await following.promise;
  const gaps = sink.chunks.filter((chunk) => chunk.includes('event: gap'));
  expect(gaps).toHaveLength(2);
  expect(gaps[1]).toContain('"missingFrom":7,"missingThrough":8');
  expect([...sink.chunks.join('').matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])))
    .toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  expect(sink.listenerCount('drain')).toBe(0);
});
it.each(['abort', 'disconnect'] as const)('cancels a blocked retention gap on %s before writing any event', async (action) => {
  await rolling();
  const sink = new Sink(); sink.blocked = true;
  const following = follow(sink);
  await observe(sink, 'write', () => sink.chunks.length > 0);
  if (action === 'abort') { following.controller.abort(); } else { sink.destroy(); }
  await following.promise;
  expect(sink.chunks).toHaveLength(1);
  expect(sink.chunks[0]).toContain('event: gap');
  expect(sink.listenerCount('drain')).toBe(0); expect(sink.listenerCount('close')).toBe(0);
});
it('publishes a moved retention window even when a caught-up reader loses no sequence', async () => {
  await rolling();
  const sink = new Sink(), following = follow(sink, 6);
  await observe(sink, 'write', () => sink.chunks.length > 0);
  expect(sink.chunks[0]).toContain('event: retention');
  await append(7, 8);
  await observe(sink, 'write', () => sink.chunks.join('').includes('id: 8\n'));
  expect(sink.chunks.join('')).toContain('event: retention\ndata: {"retainedFrom":5,"retainedCount":4,"through":8}');
  expect(sink.chunks.join('')).not.toContain('event: gap');
  following.controller.abort(); await following.promise;
});

it('wakes the live handler within 500 ms after a committed publication', async () => {
  const sink = new Sink(), following = follow(sink);
  await observe(sink, 'ready', () => sink.ready);
  await append(1);
  await observe(sink, 'write', () => sink.chunks.join('').includes('id: 1\n'), 500);
  following.controller.abort(); await following.promise;
  expect(sink.ended).toBe(true);
});

it('registers before reading so a publication during the initial read is not lost', async () => {
  const original = EventJournal.read.bind(EventJournal);
  let inject = true;
  vi.spyOn(EventJournal, 'read').mockImplementation(async (...args) => {
    const page = await original(...args);
    if (inject) { inject = false; await append(1); }
    return page;
  });
  const sink = new Sink(), following = follow(sink);
  await observe(sink, 'ready', () => sink.ready);
  await observe(sink, 'write', () => sink.chunks.join('').includes('id: 1\n'), 500);
  following.controller.abort(); await following.promise;
  expect(sink.chunks.join('').match(/id: 1\n/g)).toHaveLength(1);
});

it('writes one bounded page at a time while preserving individual SSE ids and exclusive cursors', async () => {
  await append(1, 6);
  await hub.publish({ state: 'disconnected' });
  const sink = new Sink();
  await follow(sink, 1, 2).promise;
  const eventWrites = sink.chunks.filter((chunk) => chunk.startsWith('id: '));
  expect(eventWrites).toHaveLength(3);
  expect(eventWrites[0]).toMatch(/^id: 2\ndata: .*\n\nid: 3\ndata: .*\n\n$/);
  expect(eventWrites[1]).toMatch(/^id: 4\ndata: .*\n\nid: 5\ndata: .*\n\n$/);
  expect(eventWrites[2]).toMatch(/^id: 6\ndata: .*\n\n$/);
  expect(sink.chunks.at(-1)).toContain('"through":6');
});

it('holds the page cursor at drain and coalesces later commits without duplicate records', async () => {
  await append(1, 2);
  const sink = new Sink(); sink.blocked = true;
  const following = follow(sink);
  await observe(sink, 'write', () => sink.chunks.length > 0);
  await append(3, 4); await append(5, 6);
  expect(sink.chunks).toHaveLength(1);
  sink.blocked = false; sink.emit('drain');
  await observe(sink, 'write', () => sink.chunks.join('').includes('id: 6\n'));
  following.controller.abort(); await following.promise;
  expect([...sink.chunks.join('').matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(sink.listenerCount('drain')).toBe(0);
  expect(sink.listenerCount('close')).toBe(0);
});

it.each(['abort', 'disconnect'] as const)('cleans a blocked response on %s', async (action) => {
  await append(1);
  const sink = new Sink(); sink.blocked = true;
  const following = follow(sink);
  await observe(sink, 'write', () => sink.chunks.length > 0);
  if (action === 'abort') { following.controller.abort(); } else { sink.destroy(); }
  await following.promise;
  expect(sink.listenerCount('drain')).toBe(0); expect(sink.listenerCount('close')).toBe(0);
  expect(sink.ended).toBe(true);
});

it('still rejects a corrupt tail on notification instead of delivering a cached prefix', async () => {
  await append(1);
  const sink = new Sink(), following = follow(sink);
  await observe(sink, 'write', () => sink.chunks.length > 0);
  await writeFile(join(journal.root, 'checkpoint.json'), '{}');
  await hub.publish({ ackThrough: 2 });
  await observe(sink, 'write', () => sink.chunks.join('').includes('event: fault'), 500);
  await following.promise;
  expect(sink.chunks.join('')).toContain('JOURNAL_CORRUPT');
  expect(sink.chunks.join('')).not.toContain('id: 2\n');
});

it('ends an old live stream immediately when the owned bridge switches to another stream', async () => {
  const sink = new Sink(), following = follow(sink);
  await observe(sink, 'ready', () => sink.ready);
  await hub.publish({ streamId: randomUUID(), ackThrough: 0 });
  await observe(sink, 'write', () => sink.chunks.join('').includes('event: end'), 500);
  await following.promise; expect(sink.ended).toBe(true);
});

it('closes a subscription when initial evidence validation fails before headers are sent', async () => {
  const watch = hub.watch.bind(hub), released = vi.fn();
  vi.spyOn(hub, 'watch').mockImplementation((...args) => {
    const subscription = watch(...args)!;
    const close = subscription.close.bind(subscription);
    subscription.close = () => { released(); close(); };
    return subscription;
  });
  await writeFile(join(journal.root, 'checkpoint.json'), '{}');
  const sink = new Sink();
  await expect(follow(sink).promise).rejects.toThrow('JOURNAL_CORRUPT');
  expect(sink.ready).toBe(false); expect(released).toHaveBeenCalledTimes(1);
});

it('does not leave a live loop when the client disconnects during the initial read', async () => {
  const original = EventJournal.read.bind(EventJournal);
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(EventJournal, 'read').mockImplementation(async (...args) => {
    const page = await original(...args); entered(); await blocked; return page;
  });
  const sink = new Sink(), following = follow(sink);
  try {
    await reading; sink.destroy();
  } finally { release(); }
  await observe(sink, 'end', () => sink.ended, 500);
  await following.promise;
  expect(sink.ready).toBe(false); expect(sink.listenerCount('close')).toBe(0);
});

it('wires actual encrypted bridge commits through authenticated HTTP SSE within 500 ms', async () => {
  await hub.close();
  const server = await startWebServer(await createRuntime(), context, { debugSessionId: record.debugSessionId,
    onBridgeStatus: (status) => updateDebugBridge(context.dataDir, record, status) });
  record = { ...record, origin: server.origin };
  await createDebugSession(context.dataDir, record, server.bridgeStatus());
  let socket: WebSocket | undefined, channel: SecureChannel | undefined;
  const controller = new AbortController(), deadline = AbortSignal.timeout(5000);
  let frames: AsyncIterableIterator<unknown[]> | undefined;
  try {
    const login = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
    const target = { project: context.workspaceId, buildId: 'unverified-http-test', device: 'node-test', process: 'node', sessionId: 'node-test' };
    const invitation = await (await fetch(`${server.origin}/api/v1/debug/pairing`, { method: 'POST',
      headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf }, body: JSON.stringify(target) })).json();
    const client = createPairingClient(invitation, { appConfirmed: true });
    socket = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge/v1', 'ohmate-readonly-v1');
    frames = on(socket, 'message', { signal: deadline });
    await once(socket, 'open', { signal: deadline });
    const next = async () => JSON.parse(((await frames!.next()).value![0] as Buffer).toString());
    socket.send(JSON.stringify(client.request())); channel = client.finish(await next());
    const ready = channel.open(await next()) as { sessionEpoch: string };
    socket.send(JSON.stringify(channel.seal({ type: 'ready', sessionEpoch: ready.sessionEpoch, eventBatch: 'events-v1' })));
    expect(channel.open(await next())).toMatchObject({ type: 'connected' });
    const streamId = server.bridgeStatus()!.streamId;
    const url = `${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams/${streamId}/live`;
    const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]) });
    expect(response.status).toBe(200);
    socket.send(JSON.stringify(channel.seal({ type: 'event-batch', version: '1',
      events: [1, 2].map((sequence) => event(sequence, { ...invitation.handshake.identity, sessionEpoch: ready.sessionEpoch })) })));
    expect(channel.open(await next())).toMatchObject({ type: 'ack', ackThrough: 2 });
    const reader = response.body!.getReader();
    let text = '';
    try {
      while (!text.includes('id: 2\n')) { text += new TextDecoder().decode((await reader.read()).value); }
      expect([...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([1, 2]);
      expect(server.bridgeStatus()).toMatchObject({ buildVerification: 'unverified', deviceProvenance: 'peer-asserted' });
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  } finally {
    controller.abort(); await frames?.return?.();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close'); socket.terminate(); await closed;
    }
    channel?.close(); await server.close();
  }
});
