/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  readFileSync: vi.fn(),
  resolve: vi.fn(),
  process: {
    argv: [] as string[],
    env: {} as NodeJS.ProcessEnv,
    execPath: '/node',
    platform: 'linux',
    exitCode: undefined as number | undefined,
    on: vi.fn(),
    off: vi.fn(),
    stderr: { write: vi.fn() },
    exit: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }));
vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mocks.resolve }),
}));
vi.mock('node:process', () => ({ default: mocks.process }));

describe('CLI wrapper', () => {
  let child: EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.process.argv = ['/node', '/wrapper/cli.js', 'build', '--flag'];
    mocks.process.env = {};
    mocks.process.platform = 'linux';
    mocks.process.exitCode = undefined;
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        name: '@fixture/wrapper',
        version: '1.2.3',
        dependencies: {
          '@ohmate/cli-common': '1.2.3',
        },
      })
    );
    mocks.resolve.mockReturnValue('/implementation/dist/cli.js');
    child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
  });

  const load = () => import('../cli.js');
  function signal(name: NodeJS.Signals) {
    const registered = mocks.process.on.mock.calls.find(
      ([event]) => event === name
    );
    expect(registered).toBeDefined();
    registered![1]();
  }
  function expectListenersRemoved() {
    for (const [event, handler] of mocks.process.on.mock.calls) {
      expect(mocks.process.off).toHaveBeenCalledWith(event, handler);
    }
  }

  it.each([
    ['linux', '@ohmate/cli-common'],
    ['darwin', '@ohmate/cli-common'],
    ['win32', '@ohmate/cli-common'],
    ['openharmony', '@ohmate/cli-common'],
  ])(
    'selects the %s implementation and forwards arguments, identity and stdio',
    async (platform, implementation) => {
      mocks.process.platform = platform;
      await load();
      expect(mocks.resolve).toHaveBeenCalledWith(
        `${implementation}/dist/cli.js`
      );
      expect(mocks.spawn).toHaveBeenCalledWith(
        '/node',
        ['/implementation/dist/cli.js', 'build', '--flag'],
        {
          shell: false,
          detached: platform !== 'win32',
          stdio: 'inherit',
          windowsHide: true,
        }
      );
      expect(mocks.process.env.OHMATE_WRAPPER_NAME).toBe(
        '@fixture/wrapper'
      );
      expect(mocks.process.env.OHMATE_WRAPPER_VERSION).toBe('1.2.3');
    }
  );

  it.each([
    ['linux', 'SIGINT'],
    ['linux', 'SIGTERM'],
    ['linux', 'SIGHUP'],
    ['darwin', 'SIGINT'],
    ['darwin', 'SIGTERM'],
    ['darwin', 'SIGHUP'],
    ['openharmony', 'SIGINT'],
    ['openharmony', 'SIGTERM'],
    ['openharmony', 'SIGHUP'],
  ] as const)(
    'forwards %s %s and waits for child close',
    async (platform, name) => {
      mocks.process.platform = platform;
      await load();
      signal(name);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith(name);
      expect(mocks.process.exitCode).toBeUndefined();
      child.emit('close', 23, null);
      expect(mocks.process.exitCode).toBe(23);
      expectListenersRemoved();
    }
  );

  it('waits for Windows console Ctrl+C cleanup without force-killing the child', async () => {
    mocks.process.platform = 'win32';
    await load();
    signal('SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.process.exitCode).toBeUndefined();
    child.emit('close', 0, null);
    expect(mocks.process.exitCode).toBe(0);
    expectListenersRemoved();
  });

  it.each(['linux', 'win32', 'openharmony'])(
    'leaves the implementation alive to clean processes and persist a forced cancellation on %s',
    async (platform) => {
      mocks.process.platform = platform;
      await load();
      signal('SIGINT');
      signal('SIGINT');
      if (platform === 'win32') { expect(child.kill).not.toHaveBeenCalled(); }
      else { expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGINT']]); }
    }
  );

  it.each([
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const },
  ])('does not signal a child that has already exited: %o', async (state) => {
    await load();
    Object.assign(child, state);
    signal('SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([0, 7])(
    'preserves child exit code %i and removes signal listeners',
    async (code) => {
      await load();
      child.emit('close', code, null);
      expect(mocks.process.exitCode).toBe(code);
      expectListenersRemoved();
    }
  );

  it.each(['SIGINT', 'SIGTERM', 'SIGKILL'] as const)(
    'maps child termination by %s to its exit code',
    async (name) => {
      await load();
      child.emit('close', null, name);
      expect(mocks.process.exitCode).toBe(128 + constants.signals[name]);
      expectListenersRemoved();
    }
  );

  it('reports a spawn error, removes signal listeners and keeps the failure exit code', async () => {
    await load();
    child.emit('error', new Error('spawn ENOENT'));
    expect(mocks.process.stderr.write).toHaveBeenCalledWith(
      'ohmatecli: failed to spawn implementation: spawn ENOENT\n'
    );
    expect(mocks.process.exitCode).toBe(1);
    expectListenersRemoved();
    child.emit('close', null, null);
    expect(mocks.process.exitCode).toBe(1);
  });
});
