/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { HdcAdapter } from './hdc-adapter.js';
import type { ToolProvider } from '../toolchain/index.js';

const toolProvider = { hdcPath: '/hdc' } as ToolProvider;

type ExecFileCallback = (
  err: unknown,
  value?: { stdout: string; stderr: string }
) => void;

function lastArg(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

/** Make the mocked execFile behave like the real one for `pidof` probes. */
function stubPidof(stdout: string, stderr = '', exitCode = 0): void {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    if (exitCode === 0) {
      lastArg(callArgs)(null, { stdout, stderr });
    } else {
      lastArg(callArgs)(
        Object.assign(new Error(`exit ${exitCode}`), {
          code: exitCode,
          stdout,
          stderr,
        })
      );
    }
  });
}

/** Fast-forward the retry backoff schedule (800 + 1500 + 2500 ms). */
async function fastForwardRetryBudget(): Promise<void> {
  await vi.advanceTimersByTimeAsync(800);
  await vi.advanceTimersByTimeAsync(1500);
  await vi.advanceTimersByTimeAsync(2500);
}

describe('HdcAdapter.pidofBundle', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('reports alive when the full bundle pid resolves', async () => {
    stubPidof('4321\n');
    const adapter = new HdcAdapter(toolProvider);
    expect(await adapter.pidofBundle('127.0.0.1:5555', 'com.example.app')).toBe(
      true
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('/hdc');
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '-t',
      '127.0.0.1:5555',
      'shell',
      'pidof',
      'com.example.app',
    ]);
  });

  it('reports dead on pidof standard no-match — no tail-segment fallback', async () => {
    // Target app crashed; a same-tail process (com.other.app) must NOT be probed.
    stubPidof('', '', 1);
    const adapter = new HdcAdapter(toolProvider);
    expect(await adapter.pidofBundle('127.0.0.1:5555', 'com.example.app')).toBe(
      false
    );
    // Exactly one probe: the full bundle name, never the bare tail segment.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toContain('com.example.app');
  });

  it('throws on transport failure after exhausting the retry budget', async () => {
    vi.useFakeTimers();
    try {
      stubPidof('', '[E000004] communication channel is being established', 1);
      const adapter = new HdcAdapter(toolProvider);
      const pending = adapter.pidofBundle('127.0.0.1:5555', 'com.example.app');
      // Attach the rejection handler up front so the (later) rejection is
      // never seen as unhandled while the timers are being fast-forwarded.
      const assertion = expect(pending).rejects.toThrow(/pidof query failed/);
      await fastForwardRetryBudget();
      await assertion;
      expect(execFileMock).toHaveBeenCalledTimes(4); // 1 + 3 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on spawn failure (hdc missing) instead of reporting dead', async () => {
    // execFile ENOENT: error.code is the string 'ENOENT', no stdout/stderr
    // props — runCommand backfills stderr from the error message.
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      lastArg(callArgs)(new Error('spawn /hdc ENOENT'));
    });
    const adapter = new HdcAdapter(toolProvider);
    await expect(
      adapter.pidofBundle('127.0.0.1:5555', 'com.example.app')
    ).rejects.toThrow(/pidof query failed/);
  });

  it('waits out a transient window via runHdcWithRetry, then reports alive', async () => {
    vi.useFakeTimers();
    try {
      execFileMock
        .mockImplementationOnce((...callArgs: unknown[]) => {
          lastArg(callArgs)(
            Object.assign(new Error('exit 1'), {
              code: 1,
              stdout: '',
              stderr: '[E000004] communication channel is being established',
            })
          );
        })
        .mockImplementationOnce((...callArgs: unknown[]) => {
          lastArg(callArgs)(null, { stdout: '4321', stderr: '' });
        });
      const adapter = new HdcAdapter(toolProvider);
      const pending = adapter.pidofBundle('127.0.0.1:5555', 'com.example.app');
      await vi.advanceTimersByTimeAsync(800);
      await expect(pending).resolves.toBe(true);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
