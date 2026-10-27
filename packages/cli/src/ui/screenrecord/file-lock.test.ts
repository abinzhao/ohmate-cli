/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { lock as guardLock } from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLock, isPidAlive, type LockLease } from './file-lock.js';
import { encodeSerial } from './recording-paths.js';
import {
  createTestDirectory,
  removeTestDirectory,
} from './test-directory.js';

const SERIAL = '0177832457001024';
const DEAD_PID = 2_000_000_001; // Out of the valid PID range everywhere.

describe('isPidAlive', () => {
  it('classifies the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe('alive');
  });

  it('classifies an out-of-range PID as dead or unknown, never alive', () => {
    expect(isPidAlive(DEAD_PID)).not.toBe('alive');
  });

  it('classifies invalid PIDs as unknown', () => {
    expect(isPidAlive(0)).toBe('unknown');
    expect(isPidAlive(-5)).toBe('unknown');
    expect(isPidAlive(1.5)).toBe('unknown');
  });
});

describe('FileLock', () => {
  let dir: string;
  let lock: FileLock;

  const lockPath = (): string => path.join(dir, `${encodeSerial(SERIAL)}.lock`);

  const writeLock = async (metadata: unknown): Promise<void> => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(lockPath(), JSON.stringify(metadata));
  };

  beforeEach(async () => {
    dir = await createTestDirectory('record-lock-');
    lock = new FileLock(dir);
  });

  afterEach(async () => {
    await removeTestDirectory(dir);
  });

  it('serializes an action and releases the lock', async () => {
    const seen: string[] = [];
    await lock.withDeviceLock(SERIAL, async (lease) => {
      seen.push(lease.token);
      expect(fs.existsSync(lockPath())).toBe(true);
    });
    expect(seen).toHaveLength(1);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('releases the lock even when the action throws', async () => {
    await expect(
      lock.withDeviceLock(SERIAL, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrowError('boom');
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('times out while another lease holds the lock', async () => {
    await lock.withDeviceLock(SERIAL, async (holder) => {
      void holder;
      await expect(
        lock.withDeviceLock(SERIAL, async () => undefined, 700)
      ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    });
  });

  it('reclaims a lock whose holder PID is dead', async () => {
    await writeLock({
      pid: DEAD_PID,
      createdAt: Date.now(),
      token: 'stale',
    });
    await lock.withDeviceLock(SERIAL, async (lease) => {
      expect(lease.token).not.toBe('stale');
    });
  });

  it('never preempts a live holder by age', async () => {
    await writeLock({
      pid: process.pid,
      createdAt: Date.now() - 30 * 60_000,
      token: 'alive-but-old',
    });
    await expect(
      lock.withDeviceLock(SERIAL, async () => undefined, 700)
    ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    // The live holder's lock is untouched.
    const raw = await fs.promises.readFile(lockPath(), 'utf8');
    expect(JSON.parse(raw).token).toBe('alive-but-old');
  });

  it('leaves a fresh corrupt lock alone but reclaims an old one', async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(lockPath(), 'garbage{');
    await expect(
      lock.withDeviceLock(SERIAL, async () => undefined, 700)
    ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    expect(fs.existsSync(lockPath())).toBe(true);

    const old = new Date(Date.now() - 10 * 60_000);
    await fs.promises.utimes(lockPath(), old, old);
    await lock.withDeviceLock(SERIAL, async () => undefined, 5_000);
  });

  it('assertOwned fails once the lock file is gone or replaced', async () => {
    let captured: LockLease | undefined;
    await lock.withDeviceLock(SERIAL, async (lease) => {
      captured = lease;
      await lease.assertOwned();
    });
    await expect(captured!.assertOwned()).rejects.toMatchObject({
      code: 'LOCK_LOST',
    });
    expect(captured!.signal.aborted).toBe(true);
  });

  it('isolates locks per device', async () => {
    await lock.withDeviceLock(SERIAL, async () => {
      await lock.withDeviceLock('OTHER-DEVICE', async (lease) => {
        expect(lease.token).toBeTruthy();
      });
    });
  });

  it('keeps the session directory guard artifacts from deadlocking re-entry', async () => {
    for (let i = 0; i < 3; i++) {
      await lock.withDeviceLock(SERIAL, async () => undefined);
    }
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('surfaces LOCK_RELEASE_FAILED when the guard stays contended', async () => {
    const contended = new FileLock(dir, { releaseGuardWaitMs: 200 });
    let freeGuard: () => Promise<void> = () => Promise.resolve();
    const action = contended.withDeviceLock(SERIAL, async () => {
      // 故意持有 guard 超过释放预算:释放拿不到 guard,必须上报。
      freeGuard = await guardLock(
        path.join(dir, `${encodeSerial(SERIAL)}.guard`),
        { realpath: false }
      );
    });
    await expect(action).rejects.toMatchObject({
      code: 'LOCK_RELEASE_FAILED',
    });
    expect(fs.existsSync(lockPath())).toBe(true);
    await freeGuard();
  });

  it('keeps the action error primary when release also fails', async () => {
    const contended = new FileLock(dir, { releaseGuardWaitMs: 100 });
    let freeGuard: () => Promise<void> = () => Promise.resolve();
    const action = contended.withDeviceLock(SERIAL, async () => {
      freeGuard = await guardLock(
        path.join(dir, `${encodeSerial(SERIAL)}.guard`),
        { realpath: false }
      );
      throw new Error('boom');
    });
    await expect(action).rejects.toThrowError('boom');
    await freeGuard();
  });
});
