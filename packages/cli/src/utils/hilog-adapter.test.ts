/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { EventEmitter } from 'node:events';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

const listDevicesMock = vi.hoisted(() => vi.fn());
const listDevicesWithNameMock = vi.hoisted(() => vi.fn());
vi.mock('../service/device-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../service/device-manager.js')>();
  return {
    ...actual,
    DeviceManager: {
      from: () => ({
        listDevices: listDevicesMock,
        listDevicesWithName: listDevicesWithNameMock,
      }),
    },
  };
});

import { HilogAdapter } from './hilog-adapter.js';
import type { HilogOptions } from './config.js';
import type { ToolProvider } from '../toolchain/index.js';
import { TraceError } from '../trace/index.js';

const toolProvider = { hdcPath: '/hdc' } as ToolProvider;
const adapter = new HilogAdapter(toolProvider);

let logSpy: MockInstance;
let errorSpy: MockInstance;

type ExecFileCallback = (
  err: unknown,
  value?: { stdout: string; stderr: string }
) => void;

function lastArg(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

/** Make the mocked execFile behave like the real one for hdc probes. */
function stubExecFile(stdout: string, stderr = '', exitCode = 0): void {
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

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** Schedule a fake child's stdio output followed by process close. */
function emitAndClose(
  child: FakeChild,
  stdout: string,
  stderr: string,
  exitCode: number
): void {
  /** Listeners attach synchronously right after spawn() returns, so emission
   * must wait for the microtask queue. */
  queueMicrotask(() => {
    if (stdout) {
      child.stdout.emit('data', stdout);
    }
    if (stderr) {
      child.stderr.emit('data', stderr);
    }
    child.emit('close', exitCode);
  });
}

/** Make the mocked spawn stream `stdout`/`stderr` once, then close. */
function stubStream(stdout: string, stderr = '', exitCode = 0): void {
  spawnMock.mockImplementation(() => {
    const child = createFakeChild();
    emitAndClose(child, stdout, stderr, exitCode);
    return child;
  });
}

function stubStreamOnce(stdout: string, stderr = '', exitCode = 0): void {
  spawnMock.mockImplementationOnce(() => {
    const child = createFakeChild();
    emitAndClose(child, stdout, stderr, exitCode);
    return child;
  });
}

/** Fast-forward the retry backoff schedule (800 + 1500 + 2500 ms). */
async function fastForwardRetryBudget(): Promise<void> {
  await vi.advanceTimersByTimeAsync(800);
  await vi.advanceTimersByTimeAsync(1500);
  await vi.advanceTimersByTimeAsync(2500);
}

describe('HilogAdapter.buildHilogCommand', () => {
  it('builds a snapshot shell command by default', () => {
    const [command, args] = adapter.buildHilogCommand('/hdc', 'dev-1', {});
    expect(command).toBe('/hdc');
    expect(args).toEqual(['-t', 'dev-1', 'shell', 'hilog -x']);
  });

  it('omits the snapshot flag in follow mode', () => {
    const [, args] = adapter.buildHilogCommand('/hdc', 'dev-1', {
      isFollow: true,
    });
    expect(args).toEqual(['-t', 'dev-1', 'shell', 'hilog']);
  });

  it('appends tag, level, domain, pid and keyword in a stable order', () => {
    const options: HilogOptions = {
      tag: 'NetMgr',
      level: 'I',
      domain: '0xD001',
      keyword: 'timeout',
    };
    const [, args] = adapter.buildHilogCommand(
      '/hdc',
      'dev-1',
      options,
      '4321'
    );
    expect(args).toEqual([
      '-t',
      'dev-1',
      'shell',
      "hilog -x -T NetMgr -L I -D 0xD001 -P 4321 -e 'timeout'",
    ]);
  });

  it('quotes the keyword as a single POSIX shell argument', () => {
    const [, args] = adapter.buildHilogCommand('/hdc', 'dev-1', {
      keyword: "it's a trap",
    });
    expect(args[3]).toBe("hilog -x -e 'it'\\''s a trap'");
  });

  it('rejects unsafe tag, level, domain and keyword values', () => {
    expect(() =>
      adapter.buildHilogCommand('/hdc', 'dev-1', { tag: 'bad tag' })
    ).toThrow(/Invalid tag/);
    expect(() =>
      adapter.buildHilogCommand('/hdc', 'dev-1', { level: 'X' })
    ).toThrow(/Invalid log level/);
    expect(() =>
      adapter.buildHilogCommand('/hdc', 'dev-1', { domain: 'bad domain' })
    ).toThrow(/Invalid domain/);
    expect(() =>
      adapter.buildHilogCommand('/hdc', 'dev-1', { keyword: 'bad\u0007noise' })
    ).toThrow(/Invalid keyword/);
  });
});

describe('HilogAdapter.getPidForBundle', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('resolves the first pid from a multi-pid pidof reply', async () => {
    stubExecFile('4321 4322\n');
    expect(
      await adapter.getPidForBundle('/hdc', 'dev-1', 'com.example.demo')
    ).toBe('4321');
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'pidof',
      'com.example.demo',
    ]);
  });

  it('returns null when pidof reports no running process', async () => {
    stubExecFile('', '', 1);
    expect(
      await adapter.getPidForBundle('/hdc', 'dev-1', 'com.example.demo')
    ).toBeNull();
  });

  it('rejects malformed bundle names before probing the device', async () => {
    await expect(
      adapter.getPidForBundle('/hdc', 'dev-1', 'demo')
    ).rejects.toThrow(/Bundle name/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('surfaces fatal tool errors from the probe', async () => {
    stubExecFile('', '[fail] pidof unavailable', 1);
    await expect(
      adapter.getPidForBundle('/hdc', 'dev-1', 'com.example.demo')
    ).rejects.toThrow(/Failed to look up PID: \[fail\] pidof unavailable/);
  });

  it('throws a transport error after exhausting the retry budget', async () => {
    vi.useFakeTimers();
    try {
      stubExecFile(
        '',
        '[E000004] communication channel is being established',
        1
      );
      const pending = adapter.getPidForBundle(
        '/hdc',
        'dev-1',
        'com.example.demo'
      );
      const assertion = expect(pending).rejects.toThrow(
        /Device communication channel unavailable/
      );
      await fastForwardRetryBudget();
      await assertion;
      expect(execFileMock).toHaveBeenCalledTimes(4); // 1 + 3 retries
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HilogAdapter.resizeHilogBuffer', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('validates the size before touching the device', async () => {
    await expect(
      adapter.resizeHilogBuffer('/hdc', 'dev-1', 'four MB')
    ).rejects.toThrow(/Invalid hilog buffer size/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('applies the size through the device shell', async () => {
    stubExecFile('');
    await adapter.resizeHilogBuffer('/hdc', 'dev-1', '16M');
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog',
      '-G',
      '16M',
    ]);
  });

  it('warns but resolves when the resize fails without a sentinel', async () => {
    stubExecFile('', 'resize refused', 1);
    await expect(
      adapter.resizeHilogBuffer('/hdc', 'dev-1', '16M')
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resize hilog buffer')
    );
  });
});

describe('HilogAdapter.getHilog (snapshot mode)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  it('streams a one-shot snapshot and returns the collected output', async () => {
    stubStream('line-1\nline-2');
    await expect(adapter.getHilog('dev-1', {})).resolves.toBe('line-1\nline-2');
    expect(spawnMock.mock.calls[0][0]).toBe('/hdc');
    expect(spawnMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog -x',
    ]);
  });

  it('filters by the bundle process when a bundle name is given', async () => {
    stubExecFile('4321');
    stubStream('app-log');
    await expect(
      adapter.getHilog('dev-1', { bundleName: 'com.example.demo' })
    ).resolves.toBe('app-log');
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'pidof',
      'com.example.demo',
    ]);
    expect(spawnMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog -x -P 4321',
    ]);
  });

  it('throws a user-facing error when the bundle is not running', async () => {
    stubExecFile('', '', 1);
    await expect(
      adapter.getHilog('dev-1', { bundleName: 'com.example.demo' })
    ).rejects.toThrow(
      /No running process found for bundle 'com\.example\.demo'/
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('resizes the buffer before reading when logSize is set', async () => {
    stubExecFile('');
    stubStream('logs');
    await expect(adapter.getHilog('dev-1', { logSize: '8M' })).resolves.toBe(
      'logs'
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog',
      '-G',
      '8M',
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('keeps only the last N lines when tail is set', async () => {
    stubStream('l-1\nl-2\nl-3\nl-4\nl-5');
    await expect(adapter.getHilog('dev-1', { tail: 2 })).resolves.toBe(
      'l-4\nl-5'
    );
  });

  it('falls back to stderr output when stdout is empty', async () => {
    stubStream('', 'fallback note');
    await expect(adapter.getHilog('dev-1', {})).resolves.toBe('fallback note');
  });

  it('throws with the device error when the read fails', async () => {
    stubStream('', 'device busy', 1);
    await expect(adapter.getHilog('dev-1', {})).rejects.toThrow(
      /Failed to get hilog: device busy/
    );
  });

  it('retries a transient transport failure, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      stubStreamOnce(
        '',
        '[E000004] communication channel is being established',
        1
      );
      stubStream('line-after-retry');
      const pending = adapter.getHilog('dev-1', {});
      const assertion = expect(pending).resolves.toBe('line-after-retry');
      await vi.advanceTimersByTimeAsync(800);
      await assertion;
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates spawn failures instead of fabricating logs', async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn /hdc ENOENT'));
      });
      return child;
    });
    await expect(adapter.getHilog('dev-1', {})).rejects.toThrow(
      /spawn \/hdc ENOENT/
    );
  });
});

describe('HilogAdapter.getHilog (follow mode)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  it('prints live stdout lines and routes stderr to the error channel', async () => {
    stubStream('live-a\nlive-b\n', 'warn-1\n');
    await expect(adapter.getHilog('dev-1', { isFollow: true })).resolves.toBe(
      ''
    );
    expect(spawnMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog',
    ]);
    expect(logSpy).toHaveBeenCalledWith('live-a');
    expect(logSpy).toHaveBeenCalledWith('live-b');
    expect(errorSpy).toHaveBeenCalledWith('warn-1');
  });

  it('prints a tail snapshot before following when tail is set', async () => {
    stubStreamOnce('old-1\nold-2\nold-3');
    stubStream('live-1\n');
    await adapter.getHilog('dev-1', { isFollow: true, tail: 2 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog -x',
    ]);
    expect(spawnMock.mock.calls[1][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hilog',
    ]);
    expect(logSpy).toHaveBeenCalledWith('old-2\nold-3');
    expect(logSpy).toHaveBeenCalledWith('live-1');
  });

  it('downgrades snapshot failures to a warning and keeps streaming', async () => {
    stubStreamOnce('', 'device busy', 1);
    stubStream('live-1\n');
    await expect(
      adapter.getHilog('dev-1', { isFollow: true, tail: 5 })
    ).resolves.toBe('');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Failed to fetch log snapshot')
    );
    expect(logSpy).toHaveBeenCalledWith('live-1');
  });

  it('throws when the live stream itself fails', async () => {
    stubStream('', 'device busy', 1);
    await expect(adapter.getHilog('dev-1', { isFollow: true })).rejects.toThrow(
      /Failed to follow hilog: device busy/
    );
  });
});

describe('HilogAdapter crash logs', () => {
  const HIDUMPER_LIST_ARGS = [
    '-t',
    'dev-1',
    'shell',
    'hidumper',
    '-s',
    '1201',
    '-a',
    '-p Faultlogger',
  ];

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('lists valid crash filenames and drops noise from the dump output', async () => {
    stubStream(
      'Faultlog report\n' +
        '\n' +
        'jscrash-com.example.demo-2048-20260512170652\n' +
        'bad line; rm -rf\n' +
        'cppcrash-com.example.demo-1024-20260510101010\n'
    );
    await expect(adapter.listCrashLogs('/hdc', 'dev-1')).resolves.toEqual([
      'jscrash-com.example.demo-2048-20260512170652',
      'cppcrash-com.example.demo-1024-20260510101010',
    ]);
    expect(spawnMock.mock.calls[0][1]).toEqual(HIDUMPER_LIST_ARGS);
  });

  it('filters crash filenames by bundle, case-insensitively', async () => {
    stubStream(
      'jscrash-com.example.demo-2048-20260512170652\n' +
        'cppcrash-com.other.app-1024-20260510101010\n'
    );
    await expect(
      adapter.listCrashLogs('/hdc', 'dev-1', 'Com.Example.Demo')
    ).resolves.toEqual(['jscrash-com.example.demo-2048-20260512170652']);
  });

  it('throws when the faultlogger query fails', async () => {
    stubStream('', 'service unavailable', 1);
    await expect(adapter.listCrashLogs('/hdc', 'dev-1')).rejects.toThrow(
      /Failed to list crash logs: service unavailable/
    );
  });

  it('reports missing crash logs as a notice, not an error', async () => {
    stubStream('');
    await expect(adapter.getLatestCrashLog('dev-1')).resolves.toBeUndefined();
    await expect(adapter.getCrashLog('dev-1')).resolves.toBe(
      'No crash logs found.'
    );
    await expect(
      adapter.getCrashLog('dev-1', 'com.example.demo')
    ).resolves.toBe("No crash logs found for bundle 'com.example.demo'.");
  });

  it('fetches the newest crash file by trailing timestamp', async () => {
    stubStreamOnce(
      'jscrash-com.example.demo-100-20260512170652\n' +
        'cppcrash-com.example.demo-100-20260513101010\n'
    );
    stubStream('stack-frame-a\n', 'note-b');
    const content = await adapter.getLatestCrashLog('dev-1');
    expect(content).toBe(
      '--- Latest Crash Log File: cppcrash-com.example.demo-100-20260513101010 ---' +
        'stack-frame-a\nnote-b'
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][1]).toEqual([
      '-t',
      'dev-1',
      'shell',
      'hidumper',
      '-s',
      '1201',
      '-a',
      '-p Faultlogger -f cppcrash-com.example.demo-100-20260513101010',
    ]);
    // getCrashLog passes existing content through unchanged.
    stubStreamOnce(
      'jscrash-com.example.demo-100-20260512170652\n' +
        'cppcrash-com.example.demo-100-20260513101010\n'
    );
    await expect(adapter.getCrashLog('dev-1')).resolves.toBe(content);
  });

  it('warns and still returns partial content when the fetch fails', async () => {
    stubStream('partial-content', 'read-error', 1);
    await expect(
      adapter.fetchCrashLogContent(
        '/hdc',
        'dev-1',
        'jscrash-com.example.demo-100-20260513101010'
      )
    ).resolves.toBe('partial-contentread-error');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Failed to fetch crash logs')
    );
  });
});

describe('HilogAdapter.selectDevice', () => {
  beforeEach(() => {
    listDevicesMock.mockReset();
    listDevicesWithNameMock.mockReset();
  });

  it('auto-selects the single connected device', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: '127.0.0.1:5555', status: 'device' },
    ]);
    await expect(adapter.selectDevice()).resolves.toBe('127.0.0.1:5555');
    expect(listDevicesWithNameMock).not.toHaveBeenCalled();
  });

  it('accepts a serial without querying device names', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    await expect(adapter.selectDevice('emu-2')).resolves.toBe('emu-2');
    expect(listDevicesWithNameMock).not.toHaveBeenCalled();
  });

  it('resolves a device by its display name', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
      { serial: 'emu-2', name: 'Emu Two' },
    ]);
    await expect(adapter.selectDevice('Emu One')).resolves.toBe('emu-1');
  });

  it('falls back to the only named device when several serials reply', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
    ]);
    await expect(adapter.selectDevice()).resolves.toBe('emu-1');
  });

  it('lists available devices when the argument matches nothing', async () => {
    listDevicesMock.mockResolvedValue([{ serial: 'emu-1', status: 'device' }]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
    ]);
    let caught: unknown;
    try {
      await adapter.selectDevice('nope');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TraceError);
    const traceError = caught as TraceError;
    expect(traceError.message).toContain("Device 'nope' not found.");
    expect(traceError.message).toContain('  - Emu One (emu-1)');
    expect(traceError.traceMessage).toBe('Device not found.');
  });

  it('refuses to guess between multiple devices', async () => {
    listDevicesMock.mockResolvedValue([
      { serial: 'emu-1', status: 'device' },
      { serial: 'emu-2', status: 'device' },
    ]);
    listDevicesWithNameMock.mockResolvedValue([
      { serial: 'emu-1', name: 'Emu One' },
      { serial: 'emu-2', name: 'Emu Two' },
    ]);
    let caught: unknown;
    try {
      await adapter.selectDevice();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TraceError);
    const traceError = caught as TraceError;
    expect(traceError.message).toContain('Multiple devices found.');
    expect(traceError.message).toContain('  - Emu One (emu-1)');
    expect(traceError.message).toContain('  - Emu Two (emu-2)');
    expect(traceError.traceMessage).toBe('Multiple devices found.');
  });

  it('errors when nothing is connected', async () => {
    listDevicesMock.mockResolvedValue([]);
    await expect(adapter.selectDevice()).rejects.toThrow(
      /No active devices found/
    );
  });
});

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
