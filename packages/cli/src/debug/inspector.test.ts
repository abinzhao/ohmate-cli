/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { processIdentity } from '../runtime/process-tree.js';
import { createDebugSession } from './debug-state.js';
import { EventJournal } from './event-journal.js';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { ChannelSchema } from '../debug-protocol/domain-schemas.js';
import { agentSpecs, agentTools, type AgentToolState } from '../agent/agent-tools.js';
import { TaskManager } from '../tasks/task-manager.js';
import { startWebServer } from '../web/web-server.js';

let root: string, context: Awaited<ReturnType<typeof createExecutionContext>>;
let runtime: Awaited<ReturnType<typeof createRuntime>>, journal: EventJournal;
let bridge: ReturnType<typeof createReadonlyBridge>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-inspector-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  await mkdir(context.dataDir, { mode: 0o700 });
  runtime = await createRuntime();
  const handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, randomUUID(), handshake, { resume: { peer: handshake, epoch: 'epoch-1' } });
  bridge = createReadonlyBridge(handshake); bridge.connect(handshake, 'epoch-1');
  await createDebugSession(context.dataDir, {
    pid: process.pid, identity: (await processIdentity(process.pid))!, cwd: root, projectRoot: null,
    origin: 'http://127.0.0.1:1', startedAt: new Date().toISOString(), controlSecret: 'a'.repeat(64),
    debugSessionId: journal.sessionId,
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function append(sequence: number, channel = 'hilog', payload: unknown = { level: 'info', summary: 'Fixture summary' }) {
  await journal.append(bridge.accept(event(sequence, { project: context.workspaceId, channel, capability: `${channel}.read`, payload })));
}
function input(changes: Record<string, unknown> = {}) {
  return { id: journal.sessionId, stream: journal.streamId, channel: 'hidebug', ...changes };
}
async function inspect(changes: Record<string, unknown> = {}) {
  expect(runtime.registry.get('debug.inspect'), 'read-only Inspector entry is missing').toBeDefined();
  return runtime.execute('debug.inspect', input(changes), context);
}

it('describes all protocol channels and associates API references without claiming their execution', async () => {
  const receipt = await runtime.execute('debug.inspectors', {}, context);
  expect(receipt.exitCode).toBe(0);
  const catalog = receipt.data as { inspectors: Array<{ channel: string; coverageLevel: string; reference: unknown }> };
  expect(catalog.inspectors.map((item) => item.channel)).toEqual(ChannelSchema.options);
  expect(catalog.inspectors.every((item) => item.coverageLevel === 'summary-only')).toBe(true);
  expect(catalog.inspectors.find((item) => item.channel === 'hidebug')!.reference).toMatchObject({
    kind: 'sdk-declaration', module: '@ohos.hidebug', symbols: ['getCpuUsage', 'getPss', 'getNativeHeapSize'],
    captureVerification: 'unverified',
  });
  expect(catalog.inspectors.find((item) => item.channel === 'app.network')).toMatchObject({
    unavailableFields: expect.arrayContaining(['host', 'path', 'headers', 'body', 'timing', 'mock', 'trace']),
    supportedFields: expect.arrayContaining(['requestId', 'method', 'status', 'durationMs']),
  });
  expect(catalog.inspectors.find((item) => item.channel === 'app.network')).not.toHaveProperty('capturedFields');
});

it('filters by channel using committed cursors and a fixed cut despite later events', async () => {
  await append(1); await append(2, 'hidebug', { metric: 'pssBytes', value: 42 }); await append(3);
  await append(4, 'hidebug', { metric: 'cpuPercent', value: 3 }); await append(5);
  const first = await inspect({ limit: 1 });
  expect(first).toMatchObject({ exitCode: 0, data: { nextCursor: 2, through: 5, hasMore: true, count: 2,
    availability: 'recorded', source: 'peer-reported', clockCalibration: 'not-calibrated',
    inspector: { coverageLevel: 'summary-only' }, events: [{ index: 2 }] } });
  await append(6, 'hidebug', { metric: 'pssBytes', value: 100 });
  const next = await inspect({ after: 2, through: 5, limit: 1 });
  expect(next).toMatchObject({ exitCode: 0, data: { nextCursor: 5, through: 5, hasMore: false, count: 2, events: [{ index: 4 }] } });
  expect((next.data as { snapshotHash: string }).snapshotHash).toBe((first.data as { snapshotHash: string }).snapshotHash);
});

it('returns an explicit not-captured state without substituting zero metrics', async () => {
  await append(1);
  expect(await inspect()).toMatchObject({ exitCode: 0, data: { availability: 'not-captured', count: 0,
    events: [], nextCursor: 1, through: 1, hasMore: false, samplingRate: null } });
  expect(JSON.stringify((await inspect()).data)).not.toContain('"value":0');
  expect(await inspect({ through: 0 })).toMatchObject({ exitCode: 0, data: { nextCursor: 0, through: 0 } });
});

it('returns measured per-record clock evidence through Registry, Agent and task consumers', async () => {
  const capture = event(1, { project: context.workspaceId, channel: 'hidebug', capability: 'hidebug.read',
    payload: { metric: 'pssBytes', value: 42 }, clockId: 'clock-1', bootId: 'boot-1', monotonicNs: '904000000' });
  await journal.append(bridge.accept(capture, {
    sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1', receivedNs: '1006000000',
    sample: { probeId: 'probe-1', sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1', clockId: 'clock-1', bootId: 'boot-1',
      t0: '1000000000', t1: '902000000', t2: '903000000', t3: '1005000000', precisionNs: '1000000' },
  }));
  const direct = await inspect();
  expect(direct).toMatchObject({ exitCode: 0, data: { clockCalibration: 'per-record',
    records: [{ clockCalibration: 'calibrated' }],
    events: [{ clock: { alignment: { desktopMonotonicNs: '1004000000' } } }] } });
  const tools = agentTools(runtime, agentSpecs(runtime, ['debug.inspect']), context, [], { pending: [], receipts: [] });
  const agent = await tools[0].execute('clock-inspector', input());
  expect(JSON.parse((agent.content[0] as { text: string }).text).data).toEqual(direct.data);
  expect((await new TaskManager(runtime, context).submit('debug.inspect', input(), true)).receipt!.data).toEqual(direct.data);
});

it('marks each network request summary without inferring intercepted coverage from an API reference', async () => {
  await append(1, 'app.network', { requestId: 'request-1', method: 'GET', durationMs: 10 });
  const receipt = await inspect({ channel: 'app.network' });
  expect(receipt).toMatchObject({ exitCode: 0, data: { records: [{
    index: 1, coverageLevel: 'summary-only', source: 'peer-reported', observation: 'registered',
  }] } });
  expect(JSON.stringify(receipt.data)).not.toContain('request-intercepted');
});

it('marks a channel not negotiated by the peer without inventing data', async () => {
  const limited = createHandshake({ ...identity, project: context.workspaceId }, { channels: ['hilog'] });
  const store = await EventJournal.create(context.dataDir, journal.sessionId, limited, { resume: { peer: limited, epoch: 'epoch-1' } });
  expect(await inspect({ stream: store.streamId })).toMatchObject({
    exitCode: 0, data: { availability: 'not-negotiated', events: [], count: 0 },
  });
});

it('uses the peer negotiation for segmented archives with a broader local offer', async () => {
  const local = createHandshake({ ...identity, project: context.workspaceId });
  const peer = createHandshake({ ...identity, project: context.workspaceId }, { channels: ['hilog'] });
  const store = await EventJournal.create(context.dataDir, journal.sessionId, local, {
    segmented: true, resume: { peer, epoch: 'epoch-1' },
  });
  expect(await inspect({ stream: store.streamId })).toMatchObject({
    exitCode: 0, data: { availability: 'not-negotiated', events: [], count: 0 },
  });
});

it.each([
  ['arkweb.console', { level: 'info', summary: 'Private page text' }],
  ['arkweb.dom', { targetId: 'target', nodeCount: 4, summary: 'Private page text' }],
  ['arkweb.storage', { targetId: 'target', entryCount: 3, summary: 'Private page text' }],
  ['ui', { windowId: 'window', nodeCount: 7, summary: 'Private page text' }],
])('keeps %s text memory-only and returns only verified metadata', async (channel, payload) => {
  await append(1, channel, payload);
  const receipt = await inspect({ channel });
  expect(receipt.exitCode).toBe(0);
  expect(JSON.stringify(receipt.data)).not.toContain('Private page text');
  expect(receipt.data).toMatchObject({ events: [{ event: { payload: { summary: '[MEMORY_ONLY]' } } }],
    inspector: { content: 'memory-only' } });
});

it.each([{ channel: 'unknown' }, { after: -1 }, { after: 2 }, { limit: 257 }, { through: 2 },
  { after: 1, through: 0 }, { limit: 0 }, { extra: true }])('rejects invalid Inspector input %j', async (changes) => {
  await append(1);
  expect((await inspect(changes)).exitCode).toBe(4);
});

it('rejects corrupt tails even when the selected cut or channel would exclude them', async () => {
  await append(1, 'hidebug', { metric: 'pssBytes', value: 1 }); await append(2);
  await writeFile(join(journal.root, '00000002.json'), '{}');
  expect((await inspect({ through: 1 })).exitCode).not.toBe(0);
});

it('rejects evidence outside the approved cwd and project scope for direct and Agent calls', async () => {
  await mkdir(join(root, 'foreign'));
  const foreign = await createExecutionContext({ cwd: join(root, 'foreign'), dataDir: context.dataDir });
  expect(runtime.registry.get('debug.inspect')).toBeDefined();
  expect((await runtime.execute('debug.inspect', input(), foreign)).exitCode).toBe(4);
  const tools = agentTools(runtime, agentSpecs(runtime, ['debug.inspect']), foreign, [], { pending: [], receipts: [] });
  expect((await tools[0].execute('foreign-inspector', input())).isError).toBe(true);
});

it('executes the same Inspector query through actual Agent and task paths while refusing lifecycle tools', async () => {
  await append(1, 'hidebug', { metric: 'pssBytes', value: 4096 });
  const direct = await inspect();
  const state: AgentToolState = { pending: [], receipts: [] };
  const tools = agentTools(runtime, agentSpecs(runtime, ['debug.inspect', 'debug.inspectors']), context, [], state);
  const result = await tools[0].execute('read-inspector', input());
  expect(JSON.parse((result.content[0] as { text: string }).text).data).toEqual(direct.data);
  const manager = new TaskManager(runtime, context);
  expect((await manager.submit('debug.inspect', input(), true)).receipt!.data).toEqual(direct.data);
  for (const id of ['debug.start', 'debug.pair', 'debug.stop', 'debug.events']) {
    expect(() => agentSpecs(runtime, [id])).toThrow();
    await expect(manager.submit(id, {}, true)).rejects.toThrow();
  }
});

it('serves identical authenticated HTTP pages, validates selectors and rejects foreign scope', async () => {
  await append(1, 'hidebug', { metric: 'pssBytes', value: 2048 });
  const server = await startWebServer(runtime, context);
  try {
    const connected = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
    const cookie = connected.headers.get('set-cookie')!.split(';')[0];
    const path = `${server.origin}/api/v1/debug/sessions/${journal.sessionId}/streams/${journal.streamId}/inspect/hidebug`;
    expect((await fetch(path)).status).toBe(401);
    const response = await fetch(path, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual((await inspect()).data);
    const catalog = await fetch(`${server.origin}/api/v1/debug/inspectors`, { headers: { cookie } });
    expect(await catalog.json()).toEqual((await runtime.execute('debug.inspectors', {}, context)).data);
    const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
    const taskResponse = await fetch(`${server.origin}/api/v1/tasks`, { method: 'POST',
      headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
      body: JSON.stringify({ toolId: 'debug.inspect', input: input(), wait: true }) });
    expect(taskResponse.status).toBe(200);
    expect((await taskResponse.json()).data.receipt.data).toEqual((await inspect()).data);
    for (const query of ['?limit=0', '?limit=1&limit=2', '?through=2', '?channel=hilog', '?extra=1']) {
      expect((await fetch(path + query, { headers: { cookie } })).status).toBe(400);
    }
    await mkdir(join(root, 'foreign'));
    const foreign = await createExecutionContext({ cwd: join(root, 'foreign'), dataDir: context.dataDir });
    const foreignServer = await startWebServer(runtime, foreign);
    try {
      const connect = await fetch(`${foreignServer.origin}/api/v1/connect`, { method: 'POST',
        headers: { origin: foreignServer.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: foreignServer.ticket() }) });
      expect((await fetch(path.replace(server.origin, foreignServer.origin),
        { headers: { cookie: connect.headers.get('set-cookie')!.split(';')[0] } })).status).toBe(403);
    } finally { await foreignServer.close(); }
  } finally { await server.close(); }
});
