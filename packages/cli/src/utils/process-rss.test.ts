/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const realExecFile = vi.hoisted(() => ({
  current: undefined as unknown as (...args: unknown[]) => void,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  realExecFile.current = actual.execFile as unknown as (
    ...args: unknown[]
  ) => void;
  return { ...actual, execFile: execFileMock };
});

import { spawn } from 'node:child_process';
import {
  formatBytesMb,
  readProcessRss,
  startMemoryTracker,
  sumTreeRssFromList,
} from './process-rss.js';
import type { ProcessInfo } from './process-rss.js';

const realPlatform = process.platform;

type ExecFileCallback = (err: unknown, stdout?: string) => void;

function callbackOf(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

function stubPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    writable: true,
    configurable: true,
  });
}

function proc(pid: number, ppid: number, rssBytes: number): ProcessInfo {
  return { pid, ppid, rssBytes };
}

afterEach(() => {
  stubPlatform(realPlatform);
  execFileMock.mockReset();
});

describe('formatBytesMb', () => {
  it('formats bytes as a two-decimal MB string', () => {
    expect(formatBytesMb(0)).toBe('0.00MB');
    expect(formatBytesMb(1024 * 1024)).toBe('1.00MB');
    expect(formatBytesMb(1536 * 1024)).toBe('1.50MB');
    expect(formatBytesMb(100 * 1024 * 1024 + 512 * 1024)).toBe('100.50MB');
  });
});

describe('sumTreeRssFromList', () => {
  it('sums the root with all descendants and skips unrelated trees', () => {
    const processes = [
      proc(1, 0, 100),
      proc(2, 1, 200),
      proc(3, 1, 300),
      proc(4, 2, 400),
      proc(5, 0, 999),
      proc(6, 5, 999),
    ];
    expect(sumTreeRssFromList(processes, 1)).toBe(1000);
    expect(sumTreeRssFromList(processes, 5)).toBe(1998);
    expect(sumTreeRssFromList(processes, 4)).toBe(400);
  });

  it('counts each process once even with parent cycles', () => {
    const processes = [proc(1, 2, 10), proc(2, 1, 20)];
    expect(sumTreeRssFromList(processes, 1)).toBe(30);
  });

  it('returns 0 for a root missing from the list without children', () => {
    expect(sumTreeRssFromList([proc(1, 0, 10)], 42)).toBe(0);
  });

  it('still walks children when the root itself is absent', () => {
    expect(sumTreeRssFromList([proc(2, 1, 20), proc(3, 2, 30)], 1)).toBe(50);
  });
});

describe('readProcessRss', () => {
  it('parses the tasklist csv memory column on win32', async () => {
    stubPlatform('win32');
    execFileMock.mockImplementation((...args: unknown[]) => {
      callbackOf(args)(null, '"app.exe","1234","Console","1","12,345 K"\r\n');
    });
    expect(await readProcessRss(1234)).toBe('12345');
    expect(execFileMock.mock.calls[0][0]).toBe('tasklist');
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '/fi',
      'PID eq 1234',
      '/fo',
      'csv',
      '/nh',
    ]);
  });

  it('resolves null when tasklist finds no matching pid', async () => {
    stubPlatform('win32');
    execFileMock.mockImplementation((...args: unknown[]) => {
      callbackOf(args)(
        null,
        'INFO: No tasks are running which match the specified criteria.'
      );
    });
    expect(await readProcessRss(1234)).toBeNull();
  });

  it('parses ps rss output on posix platforms', async () => {
    stubPlatform('linux');
    execFileMock.mockImplementation((...args: unknown[]) => {
      callbackOf(args)(null, '  23456\n');
    });
    expect(await readProcessRss(77)).toBe('23456');
    expect(execFileMock.mock.calls[0][0]).toBe('ps');
    expect(execFileMock.mock.calls[0][1]).toEqual(['-o', 'rss=', '-p', '77']);
  });

  it('resolves null when the probe command fails', async () => {
    stubPlatform('linux');
    execFileMock.mockImplementation((...args: unknown[]) => {
      callbackOf(args)(new Error('boom'));
    });
    expect(await readProcessRss(77)).toBeNull();
  });
});

describe('startMemoryTracker', () => {
  it('tracks the current process when no pid is given', async () => {
    const tracker = startMemoryTracker(undefined, 10);
    expect(await tracker.stop()).toBeGreaterThan(0);
  });

  it('includes child process memory when tracking a process tree', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      realExecFile.current(...args);
    });

    const allocBytes = 128 * 1024 * 1024;
    const childScript =
      `const buffer = Buffer.alloc(${allocBytes}); ` +
      'buffer.fill(1); ' +
      "process.stdout.write('ALLOCATED\\n'); " +
      'setInterval(() => {}, 60000);';
    const child = spawn(process.execPath, ['-e', childScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const allocated = new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error('child did not report allocation in time')),
        30_000
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('ALLOCATED')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('child exited before reporting allocation'));
      });
    });

    let treeTracker: { stop: () => Promise<number> } | undefined;
    let rootTracker: { stop: () => Promise<number> } | undefined;
    let treeBytes: number;
    let rootBytes: number;
    try {
      await allocated;
      treeTracker = startMemoryTracker(process.pid, 30, true);
      rootTracker = startMemoryTracker(process.pid, 30, false);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      treeBytes = (await treeTracker?.stop()) ?? 0;
      rootBytes = (await rootTracker?.stop()) ?? 0;
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('close', () => resolve());
        setTimeout(resolve, 10_000);
      });
    }
    expect(treeBytes).toBeGreaterThan(rootBytes + allocBytes / 2);
  }, 60_000);
});
