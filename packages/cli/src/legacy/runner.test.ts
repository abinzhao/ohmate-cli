/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { executeLegacy } from './runner.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('legacy subprocess isolation', () => {
  it('passes literal argv with shell disabled and isolates telemetry/update/data env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmate-child-'));
    roots.push(root);
    const entry = join(root, 'child.mjs');
    await writeFile(entry, `console.log(JSON.stringify({ argv: process.argv.slice(2), telemetry: process.env.DEVECO_CLI_DISABLE_TELEMETRY, update: process.env.DEVECO_CLI_DISABLE_UPDATE, data: process.env.DEVECO_CLI_DATA_DIR, cwd: process.cwd() }));`);
    const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
    const literal = 'space ; $(not-a-command) `not-a-command`';
    const result = await executeLegacy([literal], context, false, entry);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse((result.data as { stdout: string }).stdout)).toEqual({
      argv: [literal], telemetry: '1', update: 'all', data: context.dataDir, cwd: context.cwd,
    });
  });

  it('waits for process cleanup when cancellation follows a readiness signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmate-child-'));
    roots.push(root);
    const entry = join(root, 'child.mjs');
    await writeFile(entry, `process.stdout.write('ready'); process.stdin.resume(); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const context = await createExecutionContext({
      cwd: root, abortSignal: controller.signal,
      stdout: (text) => { if (text.includes('ready')) { controller.abort(); } },
    });
    const result = await executeLegacy([], context, false, entry);
    expect(result.exitCode).toBe(130);
    expect((result.data as { stdout: string }).stdout).toContain('ready');
  });

  it('cannot dispatch a more dangerous child through a lower-risk parent tool', async () => {
    const runtime = await createRuntime();
    const spec = runtime.registry.get('deveco.build')!;
    const execute = vi.fn(async () => ({ exitCode: 0 as const, data: null }));
    runtime.registry.register({ ...spec, id: 'test.build', execute });
    const context = await createExecutionContext({ cwd: tmpdir() });
    const receipt = await runtime.execute('test.build', { argv: ['--', 'clean'] }, context);
    expect(receipt.exitCode).toBe(4);
    expect(execute).not.toHaveBeenCalled();
  });

  it('cleans a grandchild even when the direct child exits first', async () => {
    const { processIdentity } = await import('../runtime/process-tree.js');
    const root = await mkdtemp(join(tmpdir(), 'ohmate-tree-'));
    roots.push(root);
    const grandchild = join(root, 'grandchild.mjs'), entry = join(root, 'parent.mjs');
    await writeFile(grandchild, `process.on('SIGTERM', () => {}); console.log('grandchild-ready'); setInterval(() => {}, 1000);`);
    await writeFile(entry, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => { console.log(JSON.stringify({ parent: process.pid, child: child.pid })); child.stdout.destroy(); });`);
    const controller = new AbortController();
    let parentPid = 0, childPid = 0;
    const context = await createExecutionContext({
      cwd: root, abortSignal: controller.signal,
      stdout: (text) => {
        const record = JSON.parse(text);
        parentPid = record.parent; childPid = record.child; controller.abort();
      },
    });
    try {
      const result = await executeLegacy([], context, false, entry);
      expect(result.exitCode).toBe(130);
      const deadline = Date.now() + 3000;
      while (await processIdentity(childPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await processIdentity(childPid)).toBeNull();
    } finally {
      try { process.kill(-parentPid, 'SIGKILL'); } catch { /* Test-owned group already exited. */ }
    }
  });
});
