/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext } from './context.js';
import { executeToolProcess, type ProcessOutput } from './process-runner.js';
import { processIdentity } from './process-tree.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-process-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('waits for the real process to close on cancellation and preserves argv and Unicode output', async () => {
  const file = join(root, 'child.cjs'), controller = new AbortController();
  await writeFile(file, "console.log('准备完毕'); setInterval(()=>{}, 1000);\n");
  let pid: number | undefined;
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'state'), taskId: 'process-test',
    abortSignal: controller.signal, stdout: (text) => { if (text.includes('准备完毕')) { controller.abort(); } },
    eventSink: (event) => { if (event.type === 'process.started') { pid = (event.payload as { pid: number }).pid; } } });
  const result = await executeToolProcess({ executable: process.execPath, argv: [file, 'literal;value'], env: { HOME: root } }, context);
  expect(result.exitCode).toBe(130);
  expect(result.data).toMatchObject({ stdout: expect.stringContaining('准备完毕'), argv: [file, 'literal;value'], cwd: root, toolExitCode: null });
  expect(await processIdentity(pid!)).toBeNull();
});
it('terminates and awaits its child if the process-start receipt cannot be recorded', async () => {
  const file = join(root, 'child.cjs');
  await writeFile(file, 'setInterval(()=>{}, 1000);\n');
  let pid: number | undefined;
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'state'), taskId: 'process-test',
    eventSink: (event) => {
      if (event.type === 'process.started') {
        pid = (event.payload as { pid: number }).pid;
        throw new Error('Receipt storage unavailable');
      }
    } });
  await expect(executeToolProcess({ executable: process.execPath, argv: [file], env: { HOME: root } }, context)).rejects.toThrow('Receipt storage unavailable');
  const identity = await processIdentity(pid!);
  if (identity) { process.kill(pid!, 'SIGKILL'); }
  expect(identity).toBeNull();
});
it('captures a genuine nonzero exit without altering the original error', async () => {
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'state') });
  const result = await executeToolProcess({ executable: process.execPath,
    argv: ['-e', "console.error('original error'); process.exitCode=9;"], env: { HOME: root } }, context);
  expect(result.exitCode).toBe(6);
  expect((result.data as ProcessOutput).toolExitCode).toBe(9);
  expect((result.data as ProcessOutput).stderr).toBe('original error\n');
  expect(result.data).toMatchObject({ outputHashes: {
    stderr: createHash('sha256').update('original error\n').digest('hex'), encoding: 'utf8', complete: true,
  } });
});
