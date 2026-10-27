/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, rm, link, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { EventJournal } from '../debug/event-journal.js';
import { agentSpecs, agentTools } from '../agent/agent-tools.js';
import type { AgentToolState } from '../agent/agent-tools.js';
import { TaskManager } from '../tasks/task-manager.js';
import { startWebServer } from '../web/web-server.js';

let root: string, runtime: Awaited<ReturnType<typeof createRuntime>>, context: Awaited<ReturnType<typeof createExecutionContext>>;
let journal: EventJournal, bridge: ReturnType<typeof createReadonlyBridge>, selection: { id: string; stream: string; through: number };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-problem-service-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  context = await createExecutionContext({ cwd: root, dataDir });
  runtime = await createRuntime();
  const handshake = createHandshake({ ...identity, project: context.workspaceId });
  bridge = createReadonlyBridge(handshake);
  bridge.connect(handshake, 'epoch-1');
  journal = await EventJournal.create(dataDir, randomUUID(), handshake);
  selection = { id: journal.sessionId, stream: journal.streamId, through: 1 };
  await journal.append(bridge.accept(event(1, { project: context.workspaceId })));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function exported() {
  expect(runtime.registry.get('debug.problem.export'), 'registered problem export is missing').toBeDefined();
  const plan = await runtime.execute('debug.problem.export', selection, context);
  expect(plan.exitCode).toBe(5);
  const data = plan.data as { planId: string; review: { snapshotHash: string; files: unknown[] } };
  expect(data.review.files).toHaveLength(6);
  const approved = { ...context, policy: { ...context.policy, approvedPlan: data.planId } };
  const receipt = await runtime.execute('debug.problem.export', selection, approved);
  expect(receipt.exitCode).toBe(0);
  const review = data.review.files as Array<{ path: string; size: number; sha256: string }>;
  const manifest = review.find((file) => file.path === 'manifest.json')!;
  expect(manifest.size).toBeGreaterThan(0);
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  return { receipt, approved, path: (receipt.data as { path: string }).path };
}

it('requires one approval bound to a fixed redacted snapshot and writes immutable private artifacts', async () => {
  const { receipt, approved, path } = await exported();
  expect((await readFile(path)).length).toBeGreaterThan(0);
  expect(receipt.artifacts[0]).toMatchObject({ path, kind: 'ohmate-problem' });
  const again = await runtime.execute('debug.problem.export', selection, approved);
  expect(again.exitCode).toBe(5);
  expect(again.data).toMatchObject({ code: 'APPROVAL_STALE' });
});

it('preserves the approved cut when more committed events arrive', async () => {
  expect(runtime.registry.get('debug.problem.export')).toBeDefined();
  const plan = await runtime.execute('debug.problem.export', selection, context);
  await journal.append(bridge.accept(event(2, { project: context.workspaceId })));
  const receipt = await runtime.execute('debug.problem.export', selection,
    { ...context, policy: { ...context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(receipt.exitCode).toBe(0);
  const checked = await runtime.execute('replay.verify', { path: (receipt.data as { path: string }).path }, context);
  expect(checked.exitCode).toBe(0);
  expect(checked.data).toMatchObject({ count: 1, authentication: 'not-restored' });
});

it('refuses changed source bytes and invalid cuts before publication', async () => {
  expect(runtime.registry.get('debug.problem.plan')).toBeDefined();
  const ahead = await runtime.execute('debug.problem.plan', { ...selection, through: 2 }, context);
  expect(ahead.exitCode).toBe(4);
  await writeFile(join(journal.root, '00000001.json'), '{}', { mode: 0o600 });
  expect((await runtime.execute('debug.problem.export', selection, context)).exitCode).not.toBe(0);
});

it('reads offline pages and verifies identity without restoring any authentication', async () => {
  expect(runtime.registry.get('replay.verify')!.options.map((option) => option.flags)).toContain('--build-id <value>');
  const { path } = await exported();
  const verified = await runtime.execute('replay.verify', { path }, context);
  expect(verified).toMatchObject({ exitCode: 0, data: { valid: true, count: 1, authentication: 'not-restored' } });
  const shown = await runtime.execute('replay.show', { path, after: 0, limit: 1 }, context);
  expect(shown).toMatchObject({ exitCode: 0, data: { nextCursor: 1, hasMore: false, through: 1 } });
  expect((shown.data as { events: unknown[] }).events).toHaveLength(1);
  const wrong = await runtime.execute('replay.verify', { path, buildId: 'other-build' }, context);
  expect(wrong).toMatchObject({ exitCode: 4, data: { message: 'PROBLEM_IDENTITY_MISMATCH' } });
});

it('rejects linked files and invalid extensions without reading arbitrary files', async () => {
  const { path } = await exported();
  for (const make of [link, symlink]) {
    const target = join(root, `${randomUUID()}.ohmate-problem.zip`);
    await make(path, target);
    expect((await runtime.execute('replay.verify', { path: target }, context)).exitCode).toBe(4);
    await rm(target);
  }
  expect((await runtime.execute('replay.verify', { path: 'credentials.json' }, context)).exitCode).toBe(4);
});

it('exposes only the problem tools to Agent and persists its export approval in tasks', async () => {
  const specs = agentSpecs(runtime, ['debug.problem.plan', 'debug.problem.export', 'replay.verify', 'replay.show']);
  expect(specs.map((spec) => spec.risk)).toEqual(['R0', 'R2', 'R0', 'R0']);
  expect(() => agentSpecs(runtime, ['debug.pair'])).toThrow();
  const manager = new TaskManager(runtime, context);
  const task = await manager.submit('debug.problem.export', selection, true);
  expect(task.state).toBe('awaiting-approval');
  expect(task.plan!.review).toMatchObject({ selection });
  await manager.cancel(task.id, false);
  expect((await manager.store.show(task.id)).state).toBe('cancelled');
});

it('executes an actual Agent offline read and stops its export for human approval', async () => {
  const { path, approved } = await exported();
  const state: AgentToolState = { pending: [], receipts: [] };
  const tools = agentTools(runtime, agentSpecs(runtime, ['replay.verify', 'debug.problem.export']), approved, [], state);
  const checked = await tools[0].execute('call-read', { path });
  expect(JSON.parse((checked.content[0] as { text: string }).text)).toMatchObject({
    exitCode: 0, data: { count: 1, authentication: 'not-restored' },
  });
  const exportedAgain = await tools[1].execute('call-export', selection);
  expect(exportedAgain.terminate).toBe(true);
  expect(state.pending).toHaveLength(1);
  const manager = new TaskManager(runtime, context);
  const task = await manager.store.show(state.pending[0]);
  expect(task.state).toBe('awaiting-approval');
  const completed = await manager.approve(task.id, task.plan!.planId, true);
  expect(completed.state).toBe('succeeded');
  expect(await readFile((completed.receipt!.data as { path: string }).path)).toEqual(await readFile(path));
  expect(state.receipts).toHaveLength(1);
});

it('uses the same fixed snapshot through authenticated HTTP without admitting lifecycle tools', async () => {
  const server = await startWebServer(runtime, context);
  try {
    const connection = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
    const cookie = connection.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
    const request = (toolId: string, input: unknown) => fetch(`${server.origin}/api/v1/tasks`, { method: 'POST',
      headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
      body: JSON.stringify({ toolId, input, wait: true }) });
    const response = await request('debug.problem.plan', selection);
    expect(response.status).toBe(200);
    const task = (await response.json()).data;
    expect(task.state).toBe('succeeded');
    expect(task.receipt.data).toEqual((await runtime.execute('debug.problem.plan', selection, context)).data);
    expect((await request('debug.start', {})).status).toBe(400);
  } finally { await server.close(); }
});
