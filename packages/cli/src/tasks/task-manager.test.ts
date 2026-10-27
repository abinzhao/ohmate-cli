/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createExecutionContext, createRuntime, type ToolSpec } from '../runtime/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function setup(risk: ToolSpec['risk'] = 'R0') {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-manager-'));
  roots.push(root);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime();
  const execute = vi.fn<ToolSpec['execute']>(async () => ({ exitCode: 0, data: { result: 42 } }));
  runtime.registry.register({
    ...runtime.registry.get('doctor')!, id: 'fixture.read', command: ['fixture', 'read'],
    inputSchema: z.strictObject({}), execute, risk,
    idempotency: risk === 'R0' ? 'read' : 'none', recovery: risk === 'R0' ? 'verify-and-retry' : 'manual',
  });
  const { TaskManager } = await import('./index.js');
  return { root, context, runtime, execute, manager: new TaskManager(runtime, context) };
}

describe('persistent task execution', () => {
  it('waits for execution, persists receipt, and returns query success separately', async () => {
    const { manager, runtime, context, execute } = await setup();
    const task = await manager.submit('fixture.read', {}, true);
    expect(task.state).toBe('succeeded');
    expect(task.receipt?.taskId).toBe(task.id);
    expect(execute).toHaveBeenCalledOnce();
    const query = await runtime.execute('task.show', { id: task.id }, context);
    expect(query.exitCode).toBe(0);
    expect(query.data).toMatchObject({ id: task.id, state: 'succeeded' });
    const events = await manager.store.events(task.id);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.type === 'task.state').map((event) => event.payload)).toEqual([
      { state: 'planning' }, { state: 'running' }, { state: 'verifying' }, { state: 'succeeded' },
    ]);
  });

  it('requires the exact persisted plan before a high risk operation', async () => {
    const { manager, execute } = await setup('R2');
    const task = await manager.submit('fixture.read', {}, true);
    expect(task.state).toBe('awaiting-approval');
    expect(execute).not.toHaveBeenCalled();
    await expect(manager.approve(task.id, 'wrong-plan', true)).rejects.toThrow(/plan/i);
    const approved = await manager.approve(task.id, task.plan!.planId, true);
    expect(approved.state).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('invalidates approval after a project file changes', async () => {
    const { manager, root, execute } = await setup('R2');
    await writeFile(join(root, 'source.ts'), 'export const value = 1;');
    const task = await manager.submit('fixture.read', {}, true);
    await writeFile(join(root, 'source.ts'), 'export const value = 2;');
    await expect(manager.approve(task.id, task.plan!.planId, true)).rejects.toThrow(/changed|stale/i);
    expect(execute).not.toHaveBeenCalled();
    expect((await manager.store.show(task.id)).state).toBe('awaiting-approval');
  });

  it('validates before creating a task and refuses nested or protocol execution', async () => {
    const { manager } = await setup();
    await expect(manager.submit('fixture.read', { extra: 1 }, true)).rejects.toThrow(/input/i);
    await expect(manager.submit('task.list', {}, true)).rejects.toThrow(/nested/i);
    await expect(manager.submit('deveco.serve.mcp', {}, true)).rejects.toThrow(/protocol/i);
    expect(await manager.store.list()).toEqual([]);
  });

  it('cancels a running task cooperatively and persists its final receipt', async () => {
    const { manager, runtime, execute, context } = await setup();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    execute.mockImplementation(async (_, current) => {
      ready();
      await new Promise<void>((resolve) => current.abortSignal.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: 130, data: { stopped: true } };
    });
    const task = await manager.store.create({ toolId: 'fixture.read', input: {}, projectRoot: null, cwd: context.cwd });
    const running = manager.run(task.id);
    await started;
    await manager.cancel(task.id);
    expect((await running).state).toBe('cancelled');
    expect((await manager.store.show(task.id)).receipt?.exitCode).toBe(130);
    expect((await runtime.execute('task.show', { id: task.id }, context)).exitCode).toBe(0);
  });

  it('does not replay a running write after a worker disappears', async () => {
    const { manager, execute, context } = await setup('R2');
    const task = await manager.store.create({ toolId: 'fixture.read', input: {}, projectRoot: null, cwd: context.cwd });
    await manager.store.transition(task.id, 'planning');
    await manager.store.transition(task.id, 'running');
    const recovered = await manager.resume(task.id, true);
    expect(recovered.state).toBe('blocked');
    expect(recovered.receipt?.data).toMatchObject({ code: 'RECOVERY_REQUIRES_REVIEW' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries an interrupted read only after recording a recovery audit', async () => {
    const { manager, execute, context } = await setup();
    const task = await manager.store.create({ toolId: 'fixture.read', input: {}, projectRoot: null, cwd: context.cwd });
    await manager.store.transition(task.id, 'planning');
    await manager.store.transition(task.id, 'running');
    const recovered = await manager.resume(task.id, true);
    expect(recovered.state).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
    expect((await manager.store.events(task.id)).some((event) => event.type === 'task.recovery')).toBe(true);
  });

  it('executes a real background worker and can reopen its result independently', async () => {
    const { manager, context } = await setup();
    const task = await manager.submit('capabilities', {}, false);
    const { TaskManager } = await import('./index.js');
    const reopened = new TaskManager(await createRuntime(), context);
    const deadline = Date.now() + 10_000;
    let current = await reopened.store.show(task.id);
    while ((current.state !== 'succeeded' || current.processes.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = await reopened.store.show(task.id);
    }
    expect(current.state).toBe('succeeded');
    expect(current.processes).toEqual([]);
    expect(current.receipt?.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'task.cancel' })]));
    const process = (await reopened.store.events(task.id)).find((event) => event.type === 'process.started');
    expect((process?.payload as { pid: number }).pid).not.toBe(globalThis.process.pid);
  });

  it('force cancellation kills a stubborn legacy process without losing its receipt', async () => {
    const { manager, context, runtime, root } = await setup();
    const { executeLegacy } = await import('../legacy/runner.js');
    const { processIdentity } = await import('../runtime/process-tree.js');
    const entry = join(root, 'stubborn.mjs');
    await writeFile(entry, `process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);`);
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    let childPid = 0;
    const cancel = new AbortController();
    context.abortSignal = cancel.signal;
    context.stdout = (text) => { childPid = Number(text.trim()); signalReady(); };
    runtime.registry.register({
      ...runtime.registry.get('fixture.read')!, id: 'fixture.stubborn', risk: 'R1',
      execute: (_, current) => executeLegacy([], current, false, entry),
    });
    const task = await manager.store.create({ toolId: 'fixture.stubborn', input: {}, projectRoot: null, cwd: root });
    const running = manager.run(task.id);
    try {
      await ready;
      await manager.cancel(task.id, true);
      const result = await running;
      expect(result.state).toBe('cancelled');
      expect((await manager.store.show(task.id)).receipt?.exitCode).toBe(130);
      expect(await processIdentity(childPid)).toBeNull();
    } finally { cancel.abort(); await running; }
  });
});
