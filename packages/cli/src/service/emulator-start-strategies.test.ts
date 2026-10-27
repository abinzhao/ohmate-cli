/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildEmulatorStartArgCandidates,
  runAllEmulatorStartStrategies,
} from './emulator-start-strategies.js';
import type { EmulatorInfo } from './emulator-types.js';
import type { EmulatorSpawnHandle } from '../utils/emulator-spawn.js';

function makeEmulator(overrides: Partial<EmulatorInfo> = {}): EmulatorInfo {
  return { name: 'AAA', ...overrides };
}

function makeHandle(
  started: Promise<void>,
  tracker?: { stop: () => Promise<number> }
): EmulatorSpawnHandle {
  return { pid: 4321, started, tracker };
}

const bareEmulator: EmulatorInfo = { name: 'Phone' };

describe('buildEmulatorStartArgCandidates', () => {
  it('keeps the snapshot boot mode when no option is given', () => {
    expect(
      buildEmulatorStartArgCandidates('Phone', bareEmulator, 'snapshot')
    ).toEqual([['-start', 'Phone', '-bootmode', 'snapshot']]);
  });

  it('passes a non-snapshot native boot mode through', () => {
    expect(
      buildEmulatorStartArgCandidates('Phone', bareEmulator, 'coldboot')
    ).toEqual([['-start', 'Phone', '-bootmode', 'coldboot']]);
  });

  it('omits the boot mode when neither native nor requested', () => {
    expect(buildEmulatorStartArgCandidates('Phone', bareEmulator)[0]).toEqual([
      '-start',
      'Phone',
    ]);
  });

  it('appends hdcport, boot mode and no window', () => {
    expect(
      buildEmulatorStartArgCandidates('Phone', bareEmulator, 'snapshot', {
        hdcPort: 12345,
        bootMode: 'reset',
        noWindow: true,
      })
    ).toEqual([
      [
        '-start',
        'Phone',
        '-bootmode',
        'reset',
        '-hdcport',
        '12345',
        '-noWindow',
      ],
    ]);
  });

  it('lets the requested boot mode override the native snapshot default', () => {
    const candidates = buildEmulatorStartArgCandidates(
      'Phone',
      bareEmulator,
      'snapshot',
      { bootMode: 'coldboot' }
    );
    expect(candidates[0]).toEqual(['-start', 'Phone', '-bootmode', 'coldboot']);
  });

  it('adds the options to every -hvd fallback strategy', () => {
    const emulator: EmulatorInfo = {
      name: 'Phone',
      instancePath: 'C:/emu/deployed/Phone',
      imageRoot: 'C:/sdk',
    };
    const extras = ['-bootmode', 'snapshot', '-hdcport', '10000', '-noWindow'];
    expect(
      buildEmulatorStartArgCandidates('Phone', emulator, 'snapshot', {
        hdcPort: 10000,
        noWindow: true,
      })
    ).toEqual([
      ['-start', 'Phone', ...extras],
      [
        '-hvd',
        'Phone',
        '-path',
        'C:/emu/deployed',
        '-imageRoot',
        'C:/sdk',
        ...extras,
      ],
      ['-hvd', 'Phone', '-path', 'C:/emu/deployed', ...extras],
    ]);
  });
});

describe('runAllEmulatorStartStrategies', () => {
  const emulator = makeEmulator({ instancePath: '/data/deployed/AAA' });

  it('resolves with the first candidate that starts successfully', async () => {
    const tracker = { stop: vi.fn() };
    const execute = vi.fn(() => makeHandle(Promise.resolve(), tracker));

    const result = await runAllEmulatorStartStrategies(
      'AAA',
      emulator,
      execute
    );

    expect(result).toEqual({ ok: true, args: ['-start', 'AAA'], tracker });
    expect(tracker.stop).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops the tracker of a failed attempt and falls through to the next candidate', async () => {
    const failingStop = vi.fn();
    const goodTracker = { stop: vi.fn() };
    const execute = vi
      .fn()
      .mockImplementationOnce(() =>
        makeHandle(Promise.reject(new Error('start rejected')), {
          stop: failingStop,
        })
      )
      .mockImplementationOnce(() => makeHandle(Promise.resolve(), goodTracker));

    const result = await runAllEmulatorStartStrategies(
      'AAA',
      emulator,
      execute
    );

    expect(result).toEqual({
      ok: true,
      args: ['-hvd', 'AAA', '-path', '/data/deployed'],
      tracker: goodTracker,
    });
    expect(failingStop).toHaveBeenCalledTimes(1);
    expect(goodTracker.stop).not.toHaveBeenCalled();
  });

  it('tolerates a tracker without a stop hook and one whose stop rejects', async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(() =>
        makeHandle(Promise.reject(new Error('no tracker')), undefined)
      )
      .mockImplementationOnce(() =>
        makeHandle(Promise.reject(new Error('stop throws')), {
          stop: vi.fn().mockRejectedValue(new Error('stop failed')),
        })
      )
      .mockImplementationOnce(() => makeHandle(Promise.resolve()));

    const result = await runAllEmulatorStartStrategies(
      'AAA',
      makeEmulator({
        instancePath: '/data/deployed/AAA',
        imageRoot: '/images',
      }),
      execute
    );

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('reports the last error after every candidate fails', async () => {
    const execute = vi.fn((args: string[]) =>
      makeHandle(Promise.reject(new Error(`boom: ${args.join(' ')}`)))
    );

    const result = await runAllEmulatorStartStrategies(
      'AAA',
      emulator,
      execute
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastError).toBeInstanceOf(Error);
      expect(result.lastError.message).toBe(
        'boom: -hvd AAA -path /data/deployed'
      );
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('survives a synchronous throw from the executor and tries the next candidate', async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('spawn ENOENT');
      })
      .mockImplementationOnce(() => makeHandle(Promise.resolve()));

    const result = await runAllEmulatorStartStrategies(
      'AAA',
      emulator,
      execute
    );

    expect(result).toEqual({
      ok: true,
      args: ['-hvd', 'AAA', '-path', '/data/deployed'],
      tracker: undefined,
    });
  });
});
