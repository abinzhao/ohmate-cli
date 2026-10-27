/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { cyan, yellow } from 'colorette';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { UpdateNotifier } from './update-notifier.js';
import { VersionCache } from './version-cache.js';
import type { DocsCacheFields } from './version-cache.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

const getCliDataDirMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/cli-data-dir.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/cli-data-dir.js')>();
  return { ...actual, getCliDataDir: getCliDataDirMock };
});

const getCurrentVersionMock = vi.hoisted(() => vi.fn());
const getPublishTagMock = vi.hoisted(() => vi.fn());
const getSupportedDocsApiMock = vi.hoisted(() => vi.fn());
vi.mock('./constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./constants.js')>();
  return {
    ...actual,
    getCurrentVersion: getCurrentVersionMock,
    getPublishTag: getPublishTagMock,
    getSupportedDocsApi: getSupportedDocsApiMock,
  };
});

const getInstalledDocsVersionMock = vi.hoisted(() => vi.fn());
vi.mock('../docs-loader.js', () => ({
  getInstalledDocsVersion: getInstalledDocsVersionMock,
}));

interface FakeCommand {
  name(): string;
  parent?: FakeCommand | null;
}

function makeCommand(name: string, parent: FakeCommand | null = null): Command {
  return { name: () => name, parent } as unknown as Command;
}

describe('UpdateNotifier.checkAndNotify', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let unrefSpy: ReturnType<typeof vi.fn>;
  const originalArgv = process.argv;
  const fakeEntry = path.join(os.tmpdir(), 'deveco-fake-dist', 'cli.js');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-update-notifier-'));
    getCliDataDirMock.mockReturnValue(root);
    getCurrentVersionMock.mockReturnValue('1.0.0');
    getPublishTagMock.mockReturnValue('latest');
    getSupportedDocsApiMock.mockReturnValue(1);
    getInstalledDocsVersionMock.mockReset();
    unrefSpy = vi.fn();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ unref: unrefSpy }));
    process.argv = ['node', fakeEntry];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function seedCache(
    latestVersion: string | null,
    checkedAgainstVersion: string,
    checkedAgainstTag: string,
    docs?: DocsCacheFields
  ): Promise<void> {
    const cache = new VersionCache(path.join(root, 'update'));
    await cache.writeSuccess(
      latestVersion,
      [],
      checkedAgainstVersion,
      checkedAgainstTag,
      docs
    );
  }

  /** Re-acquire and release the notifier's lock — rejects while the lock is still held. */
  async function assertLockReleased(): Promise<void> {
    const release = await lockfile.lock(
      path.join(root, 'update', 'check.lock'),
      {
        stale: 60_000,
        retries: 0,
        realpath: false,
      }
    );
    await release();
  }

  it('skips notify when the invoked command is update itself', async () => {
    await new UpdateNotifier(makeCommand('update')).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('skips notify when an ancestor command is update', async () => {
    const leaf = makeCommand('_check', makeCommand('update'));
    await new UpdateNotifier(leaf).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('shows the cli upgrade banner for a cached newer version without refreshing', async () => {
    await seedCache('2.0.0', '1.0.0', 'latest');
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).toHaveBeenCalledWith();
    expect(logSpy).toHaveBeenCalledWith(
      yellow(
        'New cli version 2.0.0 available, run `devecocli update` to update'
      )
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stays silent when the cached latest matches the running version', async () => {
    await seedCache('1.0.0', '1.0.0', 'latest');
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns a detached background check with the skip env on first run', async () => {
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [fakeEntry, 'update', '_check'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    );
    const options = spawnMock.mock.calls[0][2] as {
      env: Record<string, string>;
    };
    expect(options.env.DEVECO_CLI_SKIP_VERSION_CHECK).toBe('1');
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('refreshes without a banner when the CLI version changed since the last check', async () => {
    await seedCache(null, '0.9.0', 'latest');
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached version on a tag switch and forces a refresh', async () => {
    await seedCache('2.0.0', '1.0.0', 'beta');
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('shows the docs upgrade banner when a newer compatible docs version is cached', async () => {
    getInstalledDocsVersionMock.mockResolvedValue('1.2.0');
    await seedCache('1.0.0', '1.0.0', 'latest', {
      latestDocsVersion: '2.0.0',
      latestDocsApiVersion: 1,
      latestCompatibleDocsVersion: '1.5.0',
      checkedAgainstDocsApi: 1,
    });
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).toHaveBeenCalledWith(
      cyan(
        'New docs version 1.5.0 available, run `devecocli docs update` to upgrade'
      )
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stays silent when the installed docs version is up to date', async () => {
    getInstalledDocsVersionMock.mockResolvedValue('1.5.0');
    await seedCache('1.0.0', '1.0.0', 'latest', {
      latestDocsVersion: '2.0.0',
      latestDocsApiVersion: 1,
      latestCompatibleDocsVersion: '1.5.0',
      checkedAgainstDocsApi: 1,
    });
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('shows both the cli and docs banners together', async () => {
    getInstalledDocsVersionMock.mockResolvedValue('1.0.0');
    await seedCache('2.0.0', '1.0.0', 'latest', {
      latestDocsVersion: '2.0.0',
      latestDocsApiVersion: 1,
      latestCompatibleDocsVersion: '1.5.0',
      checkedAgainstDocsApi: 1,
    });
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).toHaveBeenCalledWith(
      yellow(
        'New cli version 2.0.0 available, run `devecocli update` to update'
      )
    );
    expect(logSpy).toHaveBeenCalledWith(
      cyan(
        'New docs version 1.5.0 available, run `devecocli docs update` to upgrade'
      )
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('forces a background refresh without a banner when the cached docs api differs', async () => {
    await seedCache('1.0.0', '1.0.0', 'latest', {
      latestDocsVersion: '2.0.0',
      latestDocsApiVersion: 2,
      latestCompatibleDocsVersion: '2.0.0',
      checkedAgainstDocsApi: 2,
    });
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('swallows docs version lookup failures without a banner', async () => {
    await seedCache('1.0.0', '1.0.0', 'latest', {
      latestDocsVersion: '2.0.0',
      latestDocsApiVersion: 1,
      latestCompatibleDocsVersion: '1.5.0',
      checkedAgainstDocsApi: 1,
    });
    getInstalledDocsVersionMock.mockRejectedValue(
      new Error('docs lookup failed')
    );
    await expect(
      new UpdateNotifier(makeCommand('build')).checkAndNotify()
    ).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('skips the background spawn in tsx dev mode', async () => {
    process.argv = ['node', 'x:\\dev\\src\\cli.ts'];
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('skips the background spawn when the lock is held by another process', async () => {
    const lockDir = path.join(root, 'update');
    fs.mkdirSync(lockDir, { recursive: true });
    const release = await lockfile.lock(path.join(lockDir, 'check.lock'), {
      stale: 60_000,
      retries: 0,
      realpath: false,
    });
    try {
      await new UpdateNotifier(makeCommand('build')).checkAndNotify();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  });

  it('releases the lock after a successful background spawn', async () => {
    await new UpdateNotifier(makeCommand('build')).checkAndNotify();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await assertLockReleased();
  });

  it('releases the lock when the background spawn throws', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    await expect(
      new UpdateNotifier(makeCommand('build')).checkAndNotify()
    ).resolves.toBeUndefined();
    await assertLockReleased();
  });

  it('swallows errors thrown while gathering version info', async () => {
    getCurrentVersionMock.mockImplementation(() => {
      throw new Error('version lookup failed');
    });
    await expect(
      new UpdateNotifier(makeCommand('build')).checkAndNotify()
    ).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
