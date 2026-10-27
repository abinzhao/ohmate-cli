/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime, createExecutionContext } from '../runtime/index.js';
import { processIdentity } from '../runtime/process-tree.js';
import { TaskManager } from '../tasks/task-manager.js';
import type { ExecutionContext } from '../runtime/index.js';

let context: ExecutionContext, root: string;
afterEach(async () => {
  if (context) { await (await createRuntime()).execute('ui.stop', {}, context); }
  if (root) { await rm(root, { recursive: true, force: true }); }
});

it('registers an independent default ui while preserving device command leaves', async () => {
  const runtime = await createRuntime();
  const { resolveCommand } = await import('../terminal/help.js');
  expect(resolveCommand(runtime, ['ui'])?.id).toBe('ui.open');
  expect(resolveCommand(runtime, ['ui', 'layout'])?.id).toBe('deveco.ui.layout');
  expect(runtime.registry.get('ui.status')).toBeDefined();
  expect(runtime.registry.get('ui.stop')).toBeDefined();
});

it('launches one private server, reopens it, stops owned resources and preserves tasks', async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-web-lifecycle-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime();
  const opened = await runtime.execute('ui.open', { open: false }, context);
  expect(opened.exitCode).toBe(0);
  const data = opened.data as { url: string; pid: number; identity: string };
  expect(data.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#access=[a-f0-9]+$/);
  expect(await processIdentity(data.pid)).toBe(data.identity);
  const state = await stat(join(context.dataDir, 'web/service.json'));
  if (process.platform !== 'win32') { expect(state.mode & 0o777).toBe(0o600); }
  const again = await runtime.execute('ui.open', { open: false }, context);
  expect((again.data as { pid: number }).pid).toBe(data.pid);
  expect((again.data as { url: string }).url).not.toBe(data.url);
  const status = await runtime.execute('ui.status', {}, context);
  expect(JSON.stringify(status)).not.toContain('access=');
  expect(JSON.stringify(status)).not.toContain('controlSecret');
  await expect(new TaskManager(runtime, context).submit('ui.open', { open: false })).rejects.toThrow();
  const task = await new TaskManager(runtime, context).submit('capabilities', {}, true);
  const stopped = await runtime.execute('ui.stop', {}, context);
  expect(stopped.exitCode).toBe(0);
  expect(await processIdentity(data.pid)).toBeNull();
  expect((await runtime.execute('task.show', { id: task.id }, context)).data).toEqual(task);
  expect((await runtime.execute('ui.status', {}, context)).data).toEqual({ state: 'stopped' });
}, 15_000);

it('refuses to reuse an owned worker with a missing or changed code contract while still allowing explicit stop', async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-web-drift-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime();
  const opened = await runtime.execute('debug.start', {}, context);
  expect(opened.exitCode).toBe(0);
  const file = join(context.dataDir, 'web/service.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  try {
    for (const fingerprint of [undefined, '0'.repeat(64)]) {
      await writeFile(file, JSON.stringify({ ...original, workbenchFingerprint: fingerprint }));
      const reopened = await runtime.execute('debug.start', {}, context);
      expect(reopened.exitCode).toBe(5);
      expect(reopened.data).toEqual({ code: 'WORKBENCH_CODE_CHANGED' });
      expect(await processIdentity(original.pid)).toBe(original.identity);
      expect(JSON.stringify(reopened)).not.toContain('access=');
    }
  } finally { await writeFile(file, JSON.stringify(original)); }
  expect((await runtime.execute('debug.stop', {}, context)).exitCode).toBe(0);
  expect(await processIdentity(original.pid)).toBeNull();
}, 15_000);
