/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { completeConsoleLine, runConsole } from './console.js';

let root: string;
afterEach(async () => { if (root) { await rm(root, { recursive: true, force: true }); } });

it('keeps deterministic CLI commands available in a model-free console', async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-console-'));
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const input = ['/execute capabilities {}', 'Explain this project', '/files main.ts', '/tools workspace.read', '/help', '/exit'];
  const output: string[] = [];
  await runConsole(await createRuntime(), context, { read: async () => input.shift() ?? null, write: (text) => output.push(text) });
  expect(output.join('')).toContain('MODEL_REQUIRED');
  expect(output.join('')).toContain('agent.run');
  expect(output.join('')).toContain('workspace.read');
});

it('rejects invalid console tool JSON without exiting or interpreting shell text', async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-console-'));
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const input = ['/execute doctor {broken', '/execute echo $(touch BAD)', '/execute task.list {}', '/exit'];
  const output: string[] = [];
  await runConsole(await createRuntime(), context, { read: async () => input.shift() ?? null, write: (text) => output.push(text) });
  expect(output.join('')).toContain('CONSOLE_INPUT_INVALID');
  expect(output.join('')).toContain('task.list');
});

it('completes console commands and execute tool ids without guessing', () => {
  expect(completeConsoleLine('/he', [])).toEqual([['/help'], '/he']);
  expect(completeConsoleLine('/execute work', ['workspace.read', 'workspace.patch', 'doctor']))
    .toEqual([['workspace.read', 'workspace.patch'], '/execute work']);
  expect(completeConsoleLine('build the app', [])).toEqual([[], 'build the app']);
});

it('approves a pending task from the console and continues its session', async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-console-'));
  await writeFile(join(root, 'a.ts'), 'before\n');
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime();
  const input = { changes: [{ path: 'a.ts', oldHash: createHash('sha256').update('before\n').digest('hex'), text: 'after\n' }] };
  const submitted = await runtime.execute('task.submit', { toolId: 'workspace.patch', input, wait: true }, context);
  const task = submitted.data as { id: string; state: string };
  expect(task.state).toBe('awaiting-approval');
  const output: string[] = [];
  const lines = [`/approve ${task.id}`, '/exit'];
  await runConsole(runtime, context, { read: async () => lines.shift() ?? null, write: (text) => output.push(text) });
  expect(output.join('')).toContain('PATCH_APPLIED');
  expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('after\n');
});

it('lets a console user select explicit write paths without implicitly approving a patch', async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-console-'));
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const input = ['/write new.ts', '/tools workspace.patch', 'Create this file', '/exit'];
  const output: string[] = [];
  await runConsole(await createRuntime(), context, { read: async () => input.shift() ?? null, write: (text) => output.push(text) });
  expect(output.join('')).toContain('write: new.ts');
  expect(output.join('')).not.toContain('CONSOLE_INPUT_INVALID');
  expect(output.join('')).toContain('MODEL_REQUIRED');
});
