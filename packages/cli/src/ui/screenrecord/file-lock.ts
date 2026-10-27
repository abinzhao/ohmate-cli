/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lock as guardLock } from 'proper-lockfile';
import { debugLog } from '../../utils/logger.js';
import { encodeSerial } from './recording-paths.js';
import { ScreenRecordError } from './types.js';

export interface LockLease {
  readonly token: string;
  /** Aborted when this process provably lost the lock (assertOwned failure). */
  readonly signal: AbortSignal;
  /** Verify the lock file still names this lease; throws LOCK_LOST otherwise. */
  assertOwned(): Promise<void>;
}

interface LockMetadata {
  pid: number;
  createdAt: number;
  token: string;
}

/** Guard (proper-lockfile) auto-expiry for crashed metadata operations. */
const GUARD_STALE_MS = 5 * 60_000;
/** A lock whose metadata is unparseable is only reclaimed after this age. */
const CORRUPT_RECLAIM_MS = 5 * 60_000;
/** Retry budget for acquiring the guard during release (normal metadata
 * maintenance by another process is short; this outlasts it). */
const RELEASE_GUARD_WAIT_MS = 10_000;
const DEFAULT_WAIT_MS = 60_000;
const RETRY_INTERVAL_MS = 200;

export function isPidAlive(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'unknown';
  }
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return 'dead';
    }
    // EPERM: process exists but is not ours; anything else: cannot tell.
    return code === 'EPERM' ? 'alive' : 'unknown';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newToken(): string {
  return randomBytes(8).toString('hex');
}

async function readOwnedToken(lockPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(lockPath, 'utf8');
  } catch {
    return undefined; // Missing or unreadable: not attributable to anyone.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-device critical-section lock: an exclusive (`wx`) metadata file under
 * `<recordDir>/<serialHex>.lock`. A live holder is never preempted; a dead
 * holder's lock is reclaimed, and an unparseable lock only after 5 minutes.
 * A short-lived proper-lockfile guard serializes metadata read/write so two
 * reclaimers cannot delete each other's fresh lock.
 *
 * This lock serializes CLI processes on this host and data directory only; it
 * does not fence device-side state.
 */
export class FileLock {
  private readonly releaseGuardWaitMs: number;

  constructor(
    private readonly recordDir: string,
    options: { releaseGuardWaitMs?: number } = {}
  ) {
    this.releaseGuardWaitMs =
      options.releaseGuardWaitMs ?? RELEASE_GUARD_WAIT_MS;
  }

  private lockPath(serial: string): string {
    return path.join(this.recordDir, `${encodeSerial(serial)}.lock`);
  }

  private guardPath(serial: string): string {
    return path.join(this.recordDir, `${encodeSerial(serial)}.guard`);
  }

  public async withDeviceLock<T>(
    serial: string,
    action: (lease: LockLease) => Promise<T>,
    waitMs: number = DEFAULT_WAIT_MS
  ): Promise<T> {
    const lease = await this.acquire(serial, waitMs);
    let result: T;
    try {
      result = await action(lease);
    } catch (actionError) {
      try {
        await this.releaseOwned(serial, lease);
      } catch (releaseError) {
        // The action error stays primary; the release failure is logged so
        // it is still diagnosable.
        debugLog(
          `lock release failed after action error: ${(releaseError as Error).message}`
        );
      }
      throw actionError;
    }
    await this.releaseOwned(serial, lease);
    return result;
  }

  private async withGuard<T>(
    serial: string,
    action: () => Promise<T>,
    waitMs: number = 0
  ): Promise<T> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      let release: () => Promise<void>;
      try {
        release = await guardLock(this.guardPath(serial), {
          realpath: false,
          stale: GUARD_STALE_MS,
          update: 1_000,
          retries: 0,
        });
      } catch (error) {
        // Guard contention (ELOCKED): another process is maintaining lock
        // metadata; retry within the given budget before giving up.
        if (
          (error as NodeJS.ErrnoException).code !== 'ELOCKED' ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await sleep(Math.min(RETRY_INTERVAL_MS, deadline - Date.now()));
        continue;
      }
      try {
        return await action();
      } finally {
        await release();
      }
    }
  }

  private async acquire(serial: string, waitMs: number): Promise<LockLease> {
    await fs.promises.mkdir(this.recordDir, { recursive: true });
    const token = newToken();
    const lockPath = this.lockPath(serial);
    const deadline = Date.now() + waitMs;

    for (;;) {
      let acquired = false;
      try {
        await this.withGuard(serial, async () => {
          acquired = await this.tryCreateOrReclaim(lockPath, token);
        });
      } catch (error) {
        // Guard contention (ELOCKED) just means another process is doing
        // metadata maintenance; retry within the overall budget.
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') {
          throw error;
        }
      }
      if (acquired) {
        return this.buildLease(lockPath, token);
      }
      if (Date.now() + RETRY_INTERVAL_MS > deadline) {
        throw new ScreenRecordError(
          'LOCK_BUSY',
          `Timed out waiting ${waitMs}ms for the device lock (${serial})`
        );
      }
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  /** Inside the guard: create the lock, or reclaim a reclaimable holder. */
  private async tryCreateOrReclaim(
    lockPath: string,
    token: string
  ): Promise<boolean> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      await this.reclaimIfDead(lockPath);
      return false;
    }
    try {
      const metadata: LockMetadata = {
        pid: process.pid,
        createdAt: Date.now(),
        token,
      };
      await handle.writeFile(JSON.stringify(metadata));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  /** Inside the guard: unlink only a provably reclaimable lock. */
  private async reclaimIfDead(lockPath: string): Promise<void> {
    let raw: string;
    let stat: fs.Stats;
    try {
      raw = await fs.promises.readFile(lockPath, 'utf8');
      stat = await fs.promises.stat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // Already gone; nothing to reclaim.
      }
      throw error;
    }
    let metadata: LockMetadata | undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<LockMetadata>;
      if (
        typeof parsed.pid === 'number' &&
        typeof parsed.createdAt === 'number' &&
        typeof parsed.token === 'string'
      ) {
        metadata = parsed as LockMetadata;
      }
    } catch {
      // Fall through: unparseable metadata.
    }
    if (metadata) {
      // Unknown liveness is treated as alive; only a confirmed dead PID is
      // reclaimed. Live holders are never preempted by lock age.
      if (isPidAlive(metadata.pid) === 'dead') {
        await fs.promises.unlink(lockPath);
      }
      return;
    }
    // A crash mid-create can leave an empty/garbage lock. Only reclaim once
    // it is clearly not a concurrent fresh create.
    if (Date.now() - stat.mtimeMs > CORRUPT_RECLAIM_MS) {
      await fs.promises.unlink(lockPath);
    }
  }

  private buildLease(lockPath: string, token: string): LockLease {
    const controller = new AbortController();
    return {
      token,
      signal: controller.signal,
      assertOwned: async () => {
        if ((await readOwnedToken(lockPath)) !== token) {
          controller.abort();
          throw new ScreenRecordError(
            'LOCK_LOST',
            'Lost the device lock; aborting this operation'
          );
        }
      },
    };
  }

  private async releaseOwned(serial: string, lease: LockLease): Promise<void> {
    const lockPath = this.lockPath(serial);
    try {
      await this.withGuard(
        serial,
        async () => {
          // Never delete a lock we cannot attribute to this lease.
          if ((await readOwnedToken(lockPath)) === lease.token) {
            await fs.promises.unlink(lockPath);
          }
        },
        this.releaseGuardWaitMs
      );
    } catch (error) {
      throw new ScreenRecordError(
        'LOCK_RELEASE_FAILED',
        `Could not release the device lock (${serial}): ${(error as Error).message}. ` +
          'The lock stays in place; it is reclaimed by the dead-PID or corrupt-age rule once this process exits.',
        { cause: error }
      );
    }
  }
}
