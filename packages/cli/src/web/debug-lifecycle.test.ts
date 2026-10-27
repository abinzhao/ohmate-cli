/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionContext, createRuntime, type ExecutionContext } from '../runtime/index.js';
import { resolveCommand } from '../terminal/help.js';
import { TaskManager } from '../tasks/task-manager.js';
import { on, once } from 'node:events';
import WebSocket from 'ws';
import { createPairingClient } from '../debug-protocol/security.js';
import { event } from '../debug-protocol/test-fixtures.js';

let root: string, context: ExecutionContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-debug-lifecycle-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
});
afterEach(async () => {
  await (await createRuntime()).execute('ui.stop', {}, context);
  await rm(root, { recursive: true, force: true });
});

it('maps headless debug and the historical devtools entry to the same workbench', async () => {
  const runtime = await createRuntime();
  expect(resolveCommand(runtime, ['debug', 'start'])?.id).toBe('debug.start');
  expect(resolveCommand(runtime, ['devtools', 'serve'])?.id).toBe('devtools.serve');
  const first = await runtime.execute('debug.start', {}, context);
  expect(first.exitCode).toBe(0);
  const data = first.data as { pid: number; browser: string; debugSession: { id: string; state: string; target: null } };
  expect(data.browser).toBe('not-requested');
  expect(data.debugSession).toMatchObject({ id: expect.any(String), state: 'serving', target: null });
  const alias = await runtime.execute('devtools.serve', {}, context);
  const opened = await runtime.execute('ui.open', { open: false }, context);
  expect(alias.data).toMatchObject({ pid: data.pid, debugSession: { id: data.debugSession.id } });
  expect(opened.data).toMatchObject({ pid: data.pid, debugSession: { id: data.debugSession.id } });
  await expect(new TaskManager(runtime, context).submit('debug.start', {})).rejects.toThrow();
  await expect(new TaskManager(runtime, context).submit('devtools.serve', {})).rejects.toThrow();
}, 15_000);

it('shares persisted debug identity with HTTP while retaining stopped sessions', async () => {
  const runtime = await createRuntime();
  const opened = await runtime.execute('debug.start', {}, context);
  expect(opened.exitCode).toBe(0);
  const data = opened.data as { url: string; origin: string; debugSession: { id: string } };
  const response = await fetch(`${data.origin}/api/v1/connect`, {
    method: 'POST', headers: { origin: data.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(data.url).hash.slice('#access='.length) }),
  });
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const web = await fetch(`${data.origin}/api/v1/debug/status`, { headers: { cookie } });
  expect(web.status).toBe(200);
  const terminal = await runtime.execute('debug.status', {}, context);
  expect(await web.json()).toMatchObject({ exitCode: 0, data: terminal.data });
  expect(JSON.stringify(terminal)).not.toMatch(/controlSecret|access=|ticket/);
  expect(terminal.data).toMatchObject({ debugSession: {
    id: data.debugSession.id, target: null,
    bridge: { state: 'waiting-pairing', transport: 'websocket-loopback', reason: 'KIT_PRODUCER_NOT_VERIFIED' },
  } });
  expect((await runtime.execute('debug.stop', {}, context)).exitCode).toBe(0);
  const saved = await runtime.execute('debug.show', { id: data.debugSession.id }, context);
  expect(saved.data).toMatchObject({ id: data.debugSession.id, state: 'stopped', target: null });
  expect((await runtime.execute('debug.list', {}, context)).data).toEqual([saved.data]);
  const next = await runtime.execute('debug.start', {}, context);
  expect(next.data).toMatchObject({ debugSession: { id: expect.any(String) } });
  expect((next.data as typeof data).debugSession.id).not.toBe(data.debugSession.id);
}, 15_000);

it('rejects debug commands through general task routes and validates session identifiers', async () => {
  const runtime = await createRuntime();
  expect((await runtime.execute('debug.show', { id: '../web/service.json' }, context)).exitCode).toBe(4);
  expect((await runtime.execute('debug.start', { buildId: 'unverified' }, context)).exitCode).toBe(4);
  expect((await runtime.execute('debug.status', {}, context)).data).toEqual({ state: 'stopped' });
});

it('exports the same read-only protocol contract before any service or target exists', async () => {
  const runtime = await createRuntime();
  const receipt = await runtime.execute('debug.protocol', {}, context);
  expect(receipt.exitCode).toBe(0);
  expect(receipt.data).toMatchObject({
    mode: 'readonly', protocolVersionRange: { min: '1.0', max: '1.1' },
    transport: 'websocket-loopback', target: null,
    security: { kitProducer: 'not-verified', buildVerification: 'unverified', lan: 'disabled' },
    channels: expect.arrayContaining([expect.objectContaining({
      channel: 'hilog', channelVersion: '1.0', schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]),
    schemas: { handshake: expect.any(Object), event: expect.any(Object), ack: expect.any(Object), resume: expect.any(Object) },
  });
});

it('shares a real worker bridge and durable device event evidence with terminal queries', async () => {
  const runtime = await createRuntime();
  const opened = await runtime.execute('debug.start', {}, context);
  expect(opened.exitCode).toBe(0);
  const data = opened.data as { url: string; origin: string; debugSession: { id: string } };
  const response = await fetch(`${data.origin}/api/v1/connect`, {
    method: 'POST', headers: { origin: data.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(data.url).hash.slice('#access='.length) }),
  });
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const bootstrap = await (await fetch(`${data.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const requested = await fetch(`${data.origin}/api/v1/debug/pairing`, {
    method: 'POST', headers: { cookie, origin: data.origin, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
    body: JSON.stringify({ project: context.workspaceId, buildId: 'unverified-peer-build', device: 'opaque-fixture',
      process: 'fixture-process', sessionId: 'fixture-session' }),
  });
  expect(requested.status).toBe(200);
  const invitation = await requested.json();
  const client = createPairingClient(invitation, { appConfirmed: true });
  const ws = new WebSocket(data.origin.replace('http:', 'ws:') + '/bridge/v1', 'ohmate-readonly-v1');
  const messages = on(ws, 'message');
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify(client.request()));
    const next = async () => JSON.parse((await messages.next()).value![0].toString());
    const channel = client.finish(await next());
    const ready = channel.open(await next()) as { sessionEpoch: string };
    ws.send(JSON.stringify(channel.seal({ type: 'ready', sessionEpoch: ready.sessionEpoch })));
    expect(channel.open(await next())).toMatchObject({ type: 'connected' });
    ws.send(JSON.stringify(channel.seal(event(1, { ...invitation.handshake.identity, sessionEpoch: ready.sessionEpoch }))));
    expect(channel.open(await next())).toMatchObject({ ackThrough: 1 });
    const terminal = await runtime.execute('debug.show', { id: data.debugSession.id }, context);
    expect(terminal.data).toMatchObject({ bridge: { state: 'connected', ackThrough: 1, buildVerification: 'unverified' } });
    const streamId = (terminal.data as { bridge: { streamId: string } }).bridge.streamId;
    const cliEvents = await runtime.execute('debug.events', { id: data.debugSession.id, stream: streamId }, context);
    expect(cliEvents.exitCode).toBe(0);
    expect(cliEvents.data).toMatchObject({ events: [expect.objectContaining({ event: expect.objectContaining({ sequence: 1 }) })] });
    expect(JSON.stringify(terminal)).not.toContain(invitation.oneTimeCode);
    channel.close();
  } finally { await messages.return?.(); ws.terminate(); }
}, 15_000);
