/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

import { runCommand, runStreamingCommand } from './cmd.js';
import type { StreamCommandHandlers } from './cmd.js';

type ExecFileCallback = (
  err: unknown,
  value?: { stdout: string; stderr: string }
) => void;

function callbackOf(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

function resolveWith(args: unknown[], stdout: string, stderr: string): void {
  callbackOf(args)(null, { stdout, stderr });
}

function rejectWith(
  args: unknown[],
  message: string,
  extra: { code?: number | string; stdout?: string; stderr?: string }
): void {
  callbackOf(args)(Object.assign(new Error(message), extra));
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

interface RecordedCall {
  lines: string[];
  source: 'stdout' | 'stderr';
}

function recordHandlers(): {
  handlers: StreamCommandHandlers;
  data: RecordedCall[];
  errors: Error[];
  closes: (number | null)[];
} {
  const data: RecordedCall[] = [];
  const errors: Error[] = [];
  const closes: (number | null)[] = [];
  return {
    handlers: {
      onData: (lines, source) => data.push({ lines: [...lines], source }),
      onError: (error) => errors.push(error),
      onClose: (code) => closes.push(code),
    },
    data,
    errors,
    closes,
  };
}

describe('runCommand', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('returns trimmed output with exit code 0 on success', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      resolveWith(args, '  out\n', ' err \n');
    });
    expect(await runCommand('tool', ['a'], { cwd: '/tmp' })).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 0,
    });
    expect(execFileMock.mock.calls[0][0]).toBe('tool');
    expect(execFileMock.mock.calls[0][1]).toEqual(['a']);
    expect(execFileMock.mock.calls[0][2]).toEqual({ cwd: '/tmp' });
  });

  it('defaults args and options', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      resolveWith(args, '', '');
    });
    await runCommand('tool');
    expect(execFileMock.mock.calls[0][1]).toEqual([]);
    expect(execFileMock.mock.calls[0][2]).toEqual({});
  });

  it('returns captured output and the numeric exit code on failure', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      rejectWith(args, 'Command failed', {
        code: 3,
        stdout: ' partial\n',
        stderr: 'boom\n',
      });
    });
    expect(await runCommand('tool')).toEqual({
      stdout: 'partial',
      stderr: 'boom',
      exitCode: 3,
    });
  });

  it('keeps an empty stderr empty instead of backfilling the generic message', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      rejectWith(args, 'Command failed', { code: 1, stdout: '', stderr: '' });
    });
    const result = await runCommand('tool');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('falls back to the error message and exit code 1 on spawn errors', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      rejectWith(args, 'spawn tool ENOENT', { code: 'ENOENT' });
    });
    expect(await runCommand('missing-tool')).toEqual({
      stdout: '',
      stderr: 'spawn tool ENOENT',
      exitCode: 1,
    });
  });
});

describe('runStreamingCommand', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  function makeChild(): FakeChildProcess {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    return child;
  }

  it('buffers partial chunks into complete lines', async () => {
    const child = makeChild();
    const rec = recordHandlers();
    const promise = runStreamingCommand('tool', ['x'], rec.handlers);
    child.stdout.emit('data', 'he');
    child.stdout.emit('data', 'llo\nwo');
    child.stdout.emit('data', 'rld\n');
    child.emit('close', 0);
    expect(await promise).toEqual({
      stdout: 'hello\nworld\n',
      stderr: '',
      exitCode: 0,
    });
    expect(rec.data).toEqual([
      { lines: ['hello'], source: 'stdout' },
      { lines: ['world'], source: 'stdout' },
    ]);
    expect(rec.closes).toEqual([0]);
    expect(spawnMock).toHaveBeenCalledWith('tool', ['x'], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  });

  it('normalizes CRLF, drops empty lines and flushes the tail without newline', async () => {
    const child = makeChild();
    const rec = recordHandlers();
    const promise = runStreamingCommand('tool', [], rec.handlers);
    child.stdout.emit('data', 'a\r\n');
    child.stdout.emit('data', '\r\nb');
    child.emit('close', 0);
    expect(await promise).toEqual({
      stdout: 'a\r\n\r\nb',
      stderr: '',
      exitCode: 0,
    });
    expect(rec.data).toEqual([
      { lines: ['a'], source: 'stdout' },
      { lines: ['b'], source: 'stdout' },
    ]);
  });

  it('routes stderr to the stderr source and keeps the exit code', async () => {
    const child = makeChild();
    const rec = recordHandlers();
    const promise = runStreamingCommand('tool', [], rec.handlers);
    child.stderr.emit('data', 'warn\n');
    child.stdout.emit('data', 'out\n');
    child.emit('close', 1);
    expect(await promise).toEqual({
      stdout: 'out\n',
      stderr: 'warn\n',
      exitCode: 1,
    });
    expect(rec.data).toEqual([
      { lines: ['warn'], source: 'stderr' },
      { lines: ['out'], source: 'stdout' },
    ]);
  });

  it('maps a null close code to -1', async () => {
    const child = makeChild();
    const rec = recordHandlers();
    const promise = runStreamingCommand('tool', [], rec.handlers);
    child.emit('close', null);
    expect((await promise).exitCode).toBe(-1);
    expect(rec.closes).toEqual([null]);
  });

  it('rejects with the spawn error and reports it via onError', async () => {
    const child = makeChild();
    const rec = recordHandlers();
    const promise = runStreamingCommand('tool', [], rec.handlers);
    const error = new Error('spawn tool ENOENT');
    child.emit('error', error);
    await expect(promise).rejects.toBe(error);
    expect(rec.errors).toEqual([error]);
    expect(rec.closes).toEqual([]);
  });

  it('ignores late events after the promise settled', async () => {
    const child = makeChild();
    const rec = recordHandlers();
    const promise = runStreamingCommand('tool', [], rec.handlers);
    child.emit('close', 0);
    await promise;
    child.emit('error', new Error('late error'));
    expect(rec.errors).toEqual([]);
    expect(rec.closes).toEqual([0]);
  });
});
