/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ContextService } from './context-service.js';
import { ModelStore } from './models.js';
import { SessionStore } from './sessions.js';
import { TaskManager } from '../tasks/task-manager.js';
import { runConsole } from '../terminal/console.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
async function setup(mode: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-trae-cli-')); roots.push(root);
  const executable = join(root, 'trae fixture.mjs');
  await copyFile(new URL('./fixtures/trae-cli.mjs', import.meta.url), executable);
  await chmod(executable, 0o700);
  await writeFile(join(root, 'mode.json'), JSON.stringify(mode));
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime(), store = new ModelStore(context.dataDir);
  const discover = () => runtime.execute('model.trae-cli', { executable }, context);
  const trace = async () => (await readFile(join(root, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const select = async () => {
    expect((await discover()).exitCode).toBe(0);
    const model = (await store.list())[0]; await store.select(model.id); return model;
  };
  const run = async (input: Record<string, unknown>, signal = context.abortSignal) => {
    const preview = await new ContextService(context, runtime.registry).preview(input);
    return runtime.execute('agent.run', { ...input, previewHash: preview.hash }, { ...context, abortSignal: signal });
  };
  return { root, executable, context, runtime, store, discover, trace, select, run };
}

it('discovers CLI models idempotently without an endpoint, credential, automatic selection or shell', async () => {
  const test = await setup();
  await test.select(); await test.discover();
  const models = await test.store.list();
  expect(models).toHaveLength(2);
  expect(models[0]).toMatchObject({ api: 'trae-cli', model: 'actual-model', executable: test.executable });
  expect(models[1].model).toBe('Fallback Name');
  expect(models[0]).not.toHaveProperty('credentialEnv');
  expect(models[0]).not.toHaveProperty('endpoint');
  expect((await test.trace())[0].argv).toEqual(['models', '--json']);
  const fresh = await setup();
  await fresh.discover(); expect(await fresh.store.selected()).toBeNull();
  expect((await fresh.runtime.execute('model.trae-cli', { executable: 'trae-cli; touch BAD' }, fresh.context)).exitCode).not.toBe(0);
});

it('rejects malformed discovery before publishing any configuration', async () => {
  const test = await setup({ models: [{ name: 'ok', context_window: 32768 }, { name: '', context_window: 0 }] });
  expect((await test.discover()).exitCode).not.toBe(0);
  expect(await test.store.list()).toEqual([]);
});

it('supports CLI discovery, selection, prompts and session continuation in the terminal console', async () => {
  const test = await setup(), model = await test.select();
  const lines = [`/trae ${test.executable}`, '/models', `/model ${model.id}`, 'First prompt', 'y', 'Continue', 'y', '/exit'];
  const output: string[] = [];
  const result = await runConsole(test.runtime, test.context, { read: async () => lines.shift() ?? null, write: text => output.push(text) });
  expect(result.exitCode).toBe(0);
  expect(output.join('')).toContain('OHMATE_OK');
  expect(output.join('')).not.toContain('CONSOLE_INPUT_INVALID');
  const turns = (await test.trace()).filter(item => item.method === 'turn/start');
  expect(turns).toHaveLength(2);
  expect(turns.at(-1).params.input[0].text).toContain('First prompt');
});

it('checks real stdio connectivity without an environment credential and cleans its child', async () => {
  const test = await setup(), model = await test.select();
  const result = await test.runtime.execute('model.check', { id: model.id }, test.context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ api: 'trae-cli', status: 'reachable', capabilities: { text: true, streaming: true } });
  const trace = await test.trace(), child = trace.find(item => item.argv?.includes('app-server'));
  expect(child.cwd).not.toBe(test.root);
  expect(child.argv.slice(0, 2)).toEqual(['app-server', '--stdio']);
  expect(child.argv).toContain('mcp_servers={}');
  expect(child.argv).toContain('shell_tool');
  const start = trace.find(item => item.method === 'thread/start').params;
  expect(start).toMatchObject({ ephemeral: true, environments: [], selectedCapabilityRoots: [], sandbox: 'read-only',
    approvalPolicy: 'never', config: { mcp_servers: {}, model_backend_variant: null } });
  expect(trace.some(item => item.closed === child.pid)).toBe(true);
});

it('routes dynamic calls through the Pi tool loop and preserves tool results across followups', async () => {
  const test = await setup({ tool: 'workspace__read', arguments: { path: 'note.txt' } });
  await test.select(); await writeFile(join(test.root, 'note.txt'), 'Approved public content');
  const input = { prompt: 'Read note.txt', files: ['note.txt'], allowedTools: ['workspace.read'] };
  const result = await test.run(input);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ text: 'OHMATE_OK', turns: 2, toolCalls: 1 });
  const sessionId = (result.data as { sessionId: string }).sessionId;
  expect((await new SessionStore(test.context.dataDir).show(sessionId)).entries.some(item => item.type === 'tool.receipt')).toBe(true);
  expect((await test.run({ ...input, sessionId, prompt: 'Continue' })).exitCode).toBe(0);
  const trace = await test.trace(), turns = trace.filter(item => item.method === 'turn/start');
  expect(turns.at(-1).params.input[0].text).toContain('Approved public content');
  expect(turns.at(-1).params.input[0].text).toContain('OHMATE_OK');
  expect(trace.filter(item => item.argv?.includes('app-server')).every(child => trace.some(item => item.closed === child.pid))).toBe(true);
});

it('keeps CLI proposed writes pending for human approval and stops the model loop', async () => {
  const test = await setup({ tool: 'example__write' }); await test.select();
  let writes = 0;
  test.runtime.registry.register({ id: 'example.write', command: ['example', 'write'], description: 'Fixture write', risk: 'R2',
    inputSchema: z.strictObject({}), outputSchema: z.object({ exitCode: z.number(), data: z.unknown() }),
    requirements: [], timeoutMs: 5000, cancellable: true, idempotency: 'none', recovery: 'manual',
    adapter: 'native', evidence: [], options: [], arguments: [], execute: async () => { writes++; return { exitCode: 0, data: {} }; } });
  const input = { prompt: 'Propose a write', allowedTools: ['example.write'] };
  const result = await test.run(input);
  expect(result.data).toMatchObject({ code: 'TOOL_APPROVAL_REQUIRED', toolCalls: 1 });
  expect(writes).toBe(0);
  const { pendingTasks, sessionId } = result.data as { pendingTasks: string[]; sessionId: string };
  const manager = new TaskManager(test.runtime, test.context), pending = await manager.store.show(pendingTasks[0]);
  await manager.approve(pending.id, pending.plan!.planId, true); expect(writes).toBe(1);
  expect((await test.run({ ...input, sessionId, prompt: 'Check approved result' })).exitCode).toBe(0);
});

it('blocks missing/stale previews before starting CLI generation', async () => {
  const test = await setup(); await test.select();
  const input = { prompt: 'Test', files: ['note.txt'] };
  await writeFile(join(test.root, 'note.txt'), 'Before');
  const preview = await new ContextService(test.context).preview(input);
  expect((await test.runtime.execute('agent.run', input, test.context)).data).toMatchObject({ code: 'CONTEXT_APPROVAL_REQUIRED' });
  await writeFile(join(test.root, 'note.txt'), 'After');
  expect((await test.runtime.execute('agent.run', { ...input, previewHash: preview.hash }, test.context)).data).toMatchObject({ code: 'CONTEXT_APPROVAL_STALE' });
  expect((await test.trace()).some(item => item.argv?.includes('app-server'))).toBe(false);
});

it('cancels an active CLI request and waits for the owned process to close', async () => {
  const test = await setup({ hang: true }); await test.select();
  const cancel = new AbortController(), running = test.run({ prompt: 'Wait' }, cancel.signal);
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await readFile(join(test.root, 'ready')); break; } catch { await delay(20); }
    }
    expect(await readFile(join(test.root, 'ready'), 'utf8')).toBe('ready');
    cancel.abort(); expect((await running).exitCode).toBe(130);
    const trace = await test.trace(), child = trace.find(item => item.argv?.includes('app-server'));
    expect(trace.some(item => item.closed === child.pid)).toBe(true);
  } finally { cancel.abort(); await running; }
});

it.each([{ error: true }, { malformed: true }, { oversized: true }, { tool: 'task__approve' }])(
  'fails closed on CLI failure or unexpected protocol without exposing stderr: %j', async mode => {
    const test = await setup(mode); await test.select();
    const result = await test.run({ prompt: 'Test', allowedTools: [] });
    expect(result.exitCode).toBe(6);
    expect(JSON.stringify(result)).not.toContain('EXAMPLE_PRIVATE');
    const trace = await test.trace(), child = trace.find(item => item.argv?.includes('app-server'));
    expect(trace.some(item => item.closed === child.pid)).toBe(true);
  });
