/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { startWebServer } from './web-server.js';
import { createPairingClient } from '../debug-protocol/security.js';
import type { PairingInvitation, SecureChannel } from '../debug-protocol/security.js';
import { event } from '../debug-protocol/test-fixtures.js';
import { EventJournal } from '../debug/event-journal.js';

let root: string, server: Awaited<ReturnType<typeof startWebServer>>;
let sessionId: string, cookie: string, csrf: string;
let target: { project: string; buildId: string; device: string; process: string; sessionId: string };
const sockets = new Set<WebSocket>();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-bridge-http-')); sessionId = randomUUID();
  const context = await createExecutionContext({ cwd: root, dataDir: root });
  target = { project: context.workspaceId, buildId: 'peer-unverified-build', device: 'opaque-device', process: 'peer-process', sessionId: 'peer-session' };
  server = await startWebServer(await createRuntime(), context, { debugSessionId: sessionId, journal: { maxEvents: 2 } });
  const response = await fetch(`${server.origin}/api/v1/connect`, {
    method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: server.ticket() }),
  });
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  csrf = (await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json()).csrf;
});
afterEach(async () => {
  for (const socket of sockets) { socket.terminate(); }
  sockets.clear(); await server.close();
  await rm(root, { recursive: true, force: true });
});
function api(path: string, input?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.origin}/api/v1/debug/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf, ...headers },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
}
async function invitation(): Promise<PairingInvitation> {
  const response = await api('pairing', target);
  expect(response.status, 'authenticated pairing route is missing').toBe(200);
  return response.json();
}
async function socket() {
  const ws = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge/v1', 'ohmate-readonly-v1');
  sockets.add(ws);
  const messages: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  ws.on('message', (data) => {
    const value = JSON.parse(data.toString());
    const waiter = waiting.shift();
    if (waiter) { waiter(value); } else { messages.push(value); }
  });
  const next = () => {
    if (messages.length) { return Promise.resolve(messages.shift()); }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('bridge response timed out')), 2000);
      waiting.push((value) => { clearTimeout(timeout); resolve(value); });
    });
  };
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, next };
}
async function pair(confirm = true, version?: '1.0') {
  const invite = await invitation();
  const client = createPairingClient(invite, { appConfirmed: true,
    protocolVersionRange: version ? { min: version, max: version } : undefined });
  const connection = await socket();
  connection.ws.send(JSON.stringify(client.request()));
  const channel = client.finish(await connection.next());
  const ready = channel.open(await connection.next()) as { type: string; sessionEpoch: string };
  expect(ready.type).toBe('ready');
  if (confirm) {
    connection.ws.send(JSON.stringify(channel.seal({ type: 'ready', sessionEpoch: ready.sessionEpoch })));
    expect(channel.open(await connection.next())).toMatchObject({ type: 'connected' });
  }
  return { ...connection, channel, ready, invite };
}
function send(ws: WebSocket, channel: SecureChannel, value: unknown) { ws.send(JSON.stringify(channel.seal(value))); }
function received(pairing: Awaited<ReturnType<typeof pair>>, sequence: number, changes: Record<string, unknown> = {}) {
  return event(sequence, { ...pairing.invite.handshake.identity, sessionEpoch: pairing.ready.sessionEpoch, ...changes });
}
async function disconnect(pairing: Awaited<ReturnType<typeof pair>>) {
  await new Promise<void>((resolve) => { pairing.ws.once('close', () => resolve()); pairing.ws.close(); });
  // A client close notification can precede the server's release callback.
  await vi.waitFor(async () => expect(await (await api('bridge')).json())
    .toMatchObject({ state: 'disconnected', reason: 'CONNECTION_CLOSED' }));
}

it('separates pairing secrets from browser auth, public status and ordinary task execution', async () => {
  expect((await api('pairing', target, { cookie: '' })).status).toBe(401);
  expect((await api('pairing', target, { 'x-ohmate-csrf': '' })).status).toBe(403);
  expect((await api('pairing', target, { origin: 'https://other.test' })).status).toBe(403);
  expect((await api('pairing', { ...target, project: 'other-project' })).status).toBe(400);
  const invite = await invitation();
  const status = await (await api('bridge')).text();
  expect(status).not.toContain(invite.oneTimeCode);
  expect(status).not.toContain('publicKey');
  expect(JSON.parse(status)).toMatchObject({ state: 'pairing', buildVerification: 'unverified', target: null, lan: 'disabled' });
});

it('acknowledges only durable redacted events and retains evidence after disconnect', async () => {
  const pairing = await pair();
  send(pairing.ws, pairing.channel, received(pairing, 1));
  expect(pairing.channel.open(await pairing.next())).toMatchObject({ type: 'ack', ackThrough: 1 });
  const status = await (await api('bridge')).json();
  expect(status).toMatchObject({ state: 'connected', ackThrough: 1, deviceProvenance: 'peer-asserted', buildVerification: 'unverified' });
  const saved = await EventJournal.read(root, sessionId, status.streamId);
  expect(saved.events[0].event.sequence).toBe(1);
  send(pairing.ws, pairing.channel, received(pairing, 1));
  expect(pairing.channel.open(await pairing.next())).toMatchObject({ type: 'ack', ackThrough: 1 });
  expect((await EventJournal.read(root, sessionId, status.streamId)).events).toHaveLength(1);
  await disconnect(pairing);
  const disconnected = await (await api('bridge')).json();
  expect(disconnected).toMatchObject({ state: 'disconnected', ackThrough: 1, reason: 'CONNECTION_CLOSED' });
  await server.close();
  expect((await EventJournal.read(root, sessionId, status.streamId)).events).toHaveLength(1);
});

it('requires encrypted key confirmation before accepting events', async () => {
  const pairing = await pair(false);
  send(pairing.ws, pairing.channel, received(pairing, 1));
  expect(await pairing.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect((await (await api('bridge')).json()).ackThrough).toBe(0);
});

it('rejects plaintext events without acknowledging them', async () => {
  const pairing = await pair();
  pairing.ws.send(JSON.stringify(received(pairing, 1)));
  expect(await pairing.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect((await (await api('bridge')).json()).ackThrough).toBe(0);
});

it('retains N-1 negotiation through actual encrypted event delivery', async () => {
  const pairing = await pair(true, '1.0');
  send(pairing.ws, pairing.channel, received(pairing, 1, { protocolVersion: '1.0' }));
  expect(pairing.channel.open(await pairing.next())).toMatchObject({ type: 'ack', protocolVersion: '1.0', ackThrough: 1 });
});

it('rejects ciphertext replay after one acknowledged event', async () => {
  const pairing = await pair();
  const sealed = pairing.channel.seal(received(pairing, 1));
  pairing.ws.send(JSON.stringify(sealed));
  expect(pairing.channel.open(await pairing.next())).toMatchObject({ ackThrough: 1 });
  pairing.ws.send(JSON.stringify(sealed));
  expect(await pairing.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect(await (await api('bridge')).json()).toMatchObject({ ackThrough: 1, reason: 'FRAME_REPLAY' });
});

it('rejects a changed recorder identity without persisting the event', async () => {
  const pairing = await pair();
  send(pairing.ws, pairing.channel, received(pairing, 1, { buildId: 'changed-build' }));
  expect(await pairing.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  const status = await (await api('bridge')).json();
  expect(status).toMatchObject({ ackThrough: 0, reason: 'IDENTITY_MISMATCH' });
  expect((await EventJournal.read(root, sessionId, status.streamId)).events).toHaveLength(0);
});

it('fails closed when persistence is full and exposes the exact missing sequence', async () => {
  const pairing = await pair();
  for (const sequence of [1, 2]) {
    send(pairing.ws, pairing.channel, received(pairing, sequence));
    expect(pairing.channel.open(await pairing.next())).toMatchObject({ ackThrough: sequence });
  }
  send(pairing.ws, pairing.channel, received(pairing, 3));
  expect(await pairing.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect(await (await api('bridge')).json()).toMatchObject({ state: 'degraded', ackThrough: 2, reason: 'JOURNAL_LIMIT',
    gap: { missingFrom: 3, missingThrough: 3 } });
});

it('revokes a paired connection explicitly without deleting its durable evidence', async () => {
  const pairing = await pair();
  send(pairing.ws, pairing.channel, received(pairing, 1));
  expect(pairing.channel.open(await pairing.next())).toMatchObject({ ackThrough: 1 });
  const status = await (await api('bridge')).json();
  expect((await api('revoke', {})).status).toBe(200);
  expect(await (await api('bridge')).json()).toMatchObject({ state: 'revoked', reason: 'USER_REVOKED' });
  expect((await EventJournal.read(root, sessionId, status.streamId)).events).toHaveLength(1);
});

it('resumes the same durable stream only after a fresh encrypted application confirmation', async () => {
  const first = await pair();
  const original = received(first, 1);
  send(first.ws, first.channel, original);
  expect(first.channel.open(await first.next())).toMatchObject({ ackThrough: 1 });
  const status = await (await api('bridge')).json();
  await disconnect(first);
  const second = await pair(false);
  expect(second.ready.sessionEpoch).not.toBe(first.ready.sessionEpoch);
  send(second.ws, second.channel, { type: 'ready', sessionEpoch: second.ready.sessionEpoch,
    resume: { streamId: status.streamId, previousEpoch: first.ready.sessionEpoch, resumeFrom: 1 } });
  const reply = await second.next();
  expect(reply).not.toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect(second.channel.open(reply)).toMatchObject({ type: 'resumed', streamId: status.streamId, ackThrough: 0 });
  send(second.ws, second.channel, { ...original, sessionEpoch: second.ready.sessionEpoch });
  expect(second.channel.open(await second.next())).toMatchObject({ ackThrough: 1 });
  send(second.ws, second.channel, received(second, 2));
  expect(second.channel.open(await second.next())).toMatchObject({ ackThrough: 2 });
  expect(await (await api('bridge')).json()).toMatchObject({
    streamId: status.streamId, ackThrough: 2, authentication: 'pairing-proof', buildVerification: 'unverified',
  });
  expect((await EventJournal.read(root, sessionId, status.streamId)).events.map((item) => item.index)).toEqual([1, 2]);
});

it('reports the exact resume gap without changing the durable stream', async () => {
  const first = await pair();
  send(first.ws, first.channel, received(first, 1));
  expect(first.channel.open(await first.next())).toMatchObject({ ackThrough: 1 });
  const status = await (await api('bridge')).json();
  await disconnect(first);
  const second = await pair(false);
  send(second.ws, second.channel, { type: 'ready', sessionEpoch: second.ready.sessionEpoch,
    resume: { streamId: status.streamId, previousEpoch: first.ready.sessionEpoch, resumeFrom: 4 } });
  expect(await second.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect(await (await api('bridge')).json()).toMatchObject({
    reason: 'SEQUENCE_GAP', gap: { missingFrom: 2, missingThrough: 3 },
  });
  expect((await EventJournal.read(root, sessionId, status.streamId)).events).toHaveLength(1);
});

it('does not treat a resume identifier or a previous ciphertext as fresh authentication', async () => {
  const first = await pair();
  const frame = first.channel.seal(received(first, 1));
  first.ws.send(JSON.stringify(frame));
  expect(first.channel.open(await first.next())).toMatchObject({ ackThrough: 1 });
  const status = await (await api('bridge')).json();
  await disconnect(first);
  const unpaired = await socket();
  unpaired.ws.send(JSON.stringify({ type: 'ready', sessionEpoch: first.ready.sessionEpoch,
    resume: { streamId: status.streamId, previousEpoch: first.ready.sessionEpoch, resumeFrom: 1 } }));
  expect(await unpaired.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  await new Promise<void>((resolve) => { if (unpaired.ws.readyState === WebSocket.CLOSED) { resolve(); }
    else { unpaired.ws.once('close', () => resolve()); } });
  const second = await pair(false);
  second.ws.send(JSON.stringify(frame));
  expect(await second.next()).toEqual({ type: 'error', code: 'BRIDGE_REJECTED' });
  expect((await EventJournal.read(root, sessionId, status.streamId)).events).toHaveLength(1);
});
