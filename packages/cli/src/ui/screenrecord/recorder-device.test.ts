/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { createExecaRunner } from './recorder-device.js';

/** Guard the real execa wiring (timeout + cancelSignal) using node itself. */
describe('createExecaRunner', () => {
  const node = process.execPath;

  it('captures stdout and exit code', async () => {
    const run = createExecaRunner(node);
    const result = await run(['-e', 'console.log("hello")'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('captures non-zero exits without throwing', async () => {
    const run = createExecaRunner(node);
    const result = await run(['-e', 'process.exit(3)'], {});
    expect(result.exitCode).toBe(3);
  });

  it('enforces the timeout budget', async () => {
    const run = createExecaRunner(node);
    const start = Date.now();
    const result = await run(['-e', 'setTimeout(() => {}, 60_000)'], {
      timeoutMs: 300,
    });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  });

  it('kills the child when the cancel signal aborts', async () => {
    const run = createExecaRunner(node);
    const controller = new AbortController();
    const promise = run(['-e', 'setTimeout(() => {}, 60_000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  });
});
