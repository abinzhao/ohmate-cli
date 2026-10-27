/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExecutionContext, createRuntime, type ExecutionContext } from '../runtime/index.js';
import { processIdentity } from '../runtime/process-tree.js';
import { createDebugSession, stopDebugSession, updateDebugBridge } from '../debug/debug-state.js';
import { initialBridgeStatus } from '../debug/bridge-status.js';
import { EventJournal } from '../debug/event-journal.js';
import { createHandshake, createReadonlyBridge, type ReadonlyBridge } from '../debug-protocol/index.js';
import { identity, event } from '../debug-protocol/test-fixtures.js';
import { startWebServer } from './web-server.js';
import type { WebServiceRecord } from './web-state.js';

let root: string, context: ExecutionContext, journal: EventJournal, receiver: ReadonlyBridge;
let record: WebServiceRecord, cookie: string, server: Awaited<ReturnType<typeof startWebServer>>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-debug-events-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  await mkdir(context.dataDir, { mode: 0o700 });
  server = await startWebServer(await createRuntime(), context);
  const id = randomUUID(), handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, id, handshake);
  receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  record = { pid: process.pid, identity: (await processIdentity(process.pid))!, cwd: root, projectRoot: null,
    origin: server.origin, startedAt: new Date().toISOString(), controlSecret: 'a'.repeat(64), debugSessionId: id };
  await createDebugSession(context.dataDir, record, { ...initialBridgeStatus(identity.fingerprint),
    state: 'connected', streamId: journal.streamId, target: handshake.identity, authentication: 'pairing-proof', reason: null });
  const response = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
function url(action = 'events', query = '') {
  return `${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams/${journal.streamId}/${action}${query}`;
}
async function append(sequence: number, changes: Record<string, unknown> = {}) {
  await journal.append(receiver.accept(event(sequence, { project: context.workspaceId, ...changes })));
  await updateDebugBridge(context.dataDir, record, { ...initialBridgeStatus(identity.fingerprint),
    state: 'connected', streamId: journal.streamId, ackThrough: sequence, authentication: 'pairing-proof', reason: null });
}

it('returns the same verified redacted page as the CLI with an exclusive cursor', async () => {
  await append(1); await append(2);
  const response = await fetch(url('events', '?after=0&limit=1'), { headers: { cookie } });
  expect(response.status).toBe(200);
  const page = await response.json();
  const cli = await (await createRuntime()).execute('debug.events', { id: record.debugSessionId, stream: journal.streamId, after: 0, limit: 1 }, context);
  expect(page).toEqual(cli.data);
  expect(page).toMatchObject({ nextCursor: 1, through: 2, hasMore: true, events: [expect.objectContaining({ index: 1 })] });
  const next = await (await fetch(url('events', '?after=1&limit=1'), { headers: { cookie } })).json();
  expect(next).toMatchObject({ nextCursor: 2, through: 2, hasMore: false });
});

it.each(['?after=-1', '?after=1.5', '?limit=257', '?after=5', '?after=0&extra=1', '?limit=1&limit=2',
  '?id=00000000-0000-4000-8000-000000000000', '?stream=00000000-0000-4000-8000-000000000000'])('rejects invalid pagination %s', async (query) => {
  await append(1);
  expect((await fetch(url('events', query), { headers: { cookie } })).status).toBe(400);
});

it('requires browser authentication and the matching workbench scope', async () => {
  expect((await fetch(url())).status).toBe(401);
  expect((await fetch(url(), { headers: { cookie, origin: 'https://other.test' } })).status).toBe(403);
  const other = { ...record, debugSessionId: randomUUID(), cwd: join(root, 'foreign') };
  await createDebugSession(context.dataDir, other);
  const foreign = url().replace(record.debugSessionId!, other.debugSessionId);
  expect((await fetch(foreign, { headers: { cookie } })).status).toBe(403);
});

it('rejects missing or corrupt evidence without returning an unverified prefix', async () => {
  await append(1); await append(2);
  expect((await fetch(url().replace(journal.streamId, randomUUID()), { headers: { cookie } })).status).toBe(404);
  await rm(join(journal.root, '00000002.json'));
  const response = await fetch(url(), { headers: { cookie } });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'JOURNAL_CORRUPT' });
});

it('replays stopped streams using Last-Event-ID and ends with the committed cursor', async () => {
  await append(1); await append(2); await stopDebugSession(context.dataDir, record);
  const response = await fetch(url('live', '?after=0'), { headers: { cookie, 'last-event-id': '1' }, signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  expect(text).not.toContain('id: 1\n');
  expect(text).toContain('id: 2\n');
  expect(text).toContain('event: end');
  expect(text).toContain('"through":2');
});

it('serves absolute rolling pages and a gap before retained replay over authenticated HTTP', async () => {
  const handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, record.debugSessionId!, handshake, {
    maxEvents: 2, segmented: true, retention: 'rolling-v1', resume: { peer: handshake, epoch: 'epoch-1' },
  });
  for (let sequence = 1; sequence <= 4; sequence++) { await append(sequence); }
  await stopDebugSession(context.dataDir, record);
  const page = await (await fetch(url('events'), { headers: { cookie } })).json();
  expect(page).toMatchObject({ through: 4, retainedFrom: 3, retainedCount: 2, nextCursor: 4,
    gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } });
  expect(page.events.map((item: { index: number }) => item.index)).toEqual([3, 4]);
  const response = await fetch(url('live'), { headers: { cookie, 'last-event-id': '1' }, signal: AbortSignal.timeout(2000) });
  const text = await response.text();
  expect(text).toMatch(/^id: 2\nevent: gap\ndata: .*"missingFrom":2,"missingThrough":2.*\n\nid: 3\n/);
  expect(text).toContain('id: 4\n');
  expect(text).toContain('event: end\ndata: {"state":"stopped","through":4}');
});

it('delivers events appended after subscription and stops after service shutdown', async () => {
  const response = await fetch(url('live'), { headers: { cookie }, signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await append(1, { payload: { level: 'info', summary: 'token=EXAMPLE_SECRET sample@example.test' } });
  let text = '';
  while (!text.includes('id: 1\n')) { text += new TextDecoder().decode((await reader.read()).value); }
  expect(text).toContain('REDACTED');
  expect(text).not.toContain('EXAMPLE_SECRET');
  await server.close();
  await reader.cancel().catch(() => {});
});

it('reports a failed integrity check during a live stream and closes instead of reconnecting indefinitely', async () => {
  await append(1);
  const response = await fetch(url('live'), { headers: { cookie }, signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('id: 1\n')) { text += new TextDecoder().decode((await reader.read()).value); }
  await writeFile(join(journal.root, 'checkpoint.json'), '{}');
  while (true) {
    const next = await reader.read();
    if (next.done) { break; }
    text += new TextDecoder().decode(next.value);
  }
  expect(text).toContain('event: fault');
  expect(text).toContain('JOURNAL_CORRUPT');
});

it('indexes all historical streams through identical CLI and HTTP pages after stop', async () => {
  await append(1);
  const second = await EventJournal.create(context.dataDir, record.debugSessionId!, createHandshake({ ...identity, project: context.workspaceId }));
  await stopDebugSession(context.dataDir, record);
  const base = `${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams`;
  const response = await fetch(`${base}?limit=1`, { headers: { cookie } });
  expect(response.status, 'historical stream index is missing').toBe(200);
  const page = await response.json();
  const runtime = await createRuntime();
  const cli = await runtime.execute('debug.streams', { id: record.debugSessionId, limit: 1 }, context);
  expect(cli.exitCode).toBe(0);
  expect(page).toEqual(cli.data);
  const ids = [journal.streamId, second.streamId].sort();
  expect(page).toMatchObject({ hasMore: true, nextCursor: ids[0],
    streams: [expect.objectContaining({ streamId: ids[0], active: false, integrity: 'verified' })] });
  const next = await (await fetch(`${base}?limit=1&after=${page.nextCursor}`, { headers: { cookie } })).json();
  expect(next).toMatchObject({ hasMore: false, streams: [expect.objectContaining({ streamId: ids[1] })] });
});

it('marks a corrupt archive without hiding other historical streams or certifying its contents', async () => {
  await append(1);
  const second = await EventJournal.create(context.dataDir, record.debugSessionId!, createHandshake({ ...identity, project: context.workspaceId }));
  await writeFile(join(journal.root, 'checkpoint.json'), '{}');
  const response = await fetch(`${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.streams).toContainEqual(expect.objectContaining({ streamId: journal.streamId, integrity: 'corrupt', code: 'JOURNAL_CORRUPT' }));
  expect(page.streams).toContainEqual(expect.objectContaining({ streamId: second.streamId, integrity: 'verified', through: 0 }));
  expect(page.streams.find((item: { streamId: string }) => item.streamId === journal.streamId)).not.toHaveProperty('manifest');
});

it.each(['?limit=0', '?limit=65', '?after=invalid', '?limit=1&limit=2', '?id=other', '?extra=1'])(
  'rejects invalid historical stream query %s', async (query) => {
    const response = await fetch(`${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams${query}`, { headers: { cookie } });
    expect(response.status).toBe(400);
  });

it('scopes historical enumeration to the authenticated workbench and returns an empty new session', async () => {
  const base = `${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams`;
  expect((await fetch(base)).status).toBe(401);
  const other = { ...record, debugSessionId: randomUUID(), cwd: join(root, 'foreign') };
  await createDebugSession(context.dataDir, other);
  expect((await fetch(base.replace(record.debugSessionId!, other.debugSessionId), { headers: { cookie } })).status).toBe(403);
  const empty = { ...record, debugSessionId: randomUUID() };
  await createDebugSession(context.dataDir, empty);
  const response = await fetch(base.replace(record.debugSessionId!, empty.debugSessionId), { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ streams: [], nextCursor: null, hasMore: false });
});

it('keeps a linked archive unverified and preserves the valid archive beside it', async () => {
  const linkedId = randomUUID(), directory = join(journal.root, '..');
  await symlink(journal.root, join(directory, linkedId), 'dir');
  const base = `${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams`;
  const response = await fetch(base, { headers: { cookie } });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.streams).toContainEqual({ streamId: linkedId, active: false, integrity: 'corrupt', code: 'JOURNAL_CORRUPT' });
  expect(page.streams).toContainEqual(expect.objectContaining({ streamId: journal.streamId, integrity: 'verified' }));
});

it('rejects an unknown index cursor rather than restarting pagination', async () => {
  const base = `${server.origin}/api/v1/debug/sessions/${record.debugSessionId}/streams`;
  const response = await fetch(`${base}?after=${randomUUID()}`, { headers: { cookie } });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: 'EVENT_QUERY_INVALID' });
});
