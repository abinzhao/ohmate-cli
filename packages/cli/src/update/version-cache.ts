/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../utils/logger';

/** On-disk shape of the update cache file (`~/.local/share/deveco-cli/update/cache.json`). */
interface CacheData {
  /** Epoch ms of the last successful or failed registry check */
  lastCheckedTimestamp: number | null;
  /** Most recent version string returned by `npm view` */
  latestVersion: string | null;
  /** Versions declared blocked in package.json on the registry */
  blockedVersions: string[];
  /** Error message from the last check, or null on success */
  checkError: string | null;
  /** Running CLI version captured when the last successful check wrote this cache. */
  checkedAgainstVersion?: string | null;
  /** Publish dist-tag captured when the last successful check wrote this cache. */
  checkedAgainstTag?: string | null;
  /** Docs version published under the CLI's dist-tag, or null if not yet queried. */
  latestDocsVersion?: string | null;
  /** `apiVersion` of the dist-tagged docs version. */
  latestDocsApiVersion?: number | null;
  /** Same as `latestDocsVersion` when compatible, null when the tagged version requires a newer CLI. */
  latestCompatibleDocsVersion?: string | null;
  /** `supportedDocsApi` used to compute `latestCompatibleDocsVersion`. */
  checkedAgainstDocsApi?: number | null;
}

/** Docs fields passed into `writeSuccess`; omitted when the docs query is skipped/fails so prior values are preserved. */
export interface DocsCacheFields {
  latestDocsVersion: string | null;
  latestDocsApiVersion: number | null;
  latestCompatibleDocsVersion: string | null;
  checkedAgainstDocsApi: number;
}

const DEFAULT_CACHE: CacheData = {
  lastCheckedTimestamp: null,
  latestVersion: null,
  blockedVersions: [],
  checkError: null,
  latestDocsVersion: null,
  latestDocsApiVersion: null,
  latestCompatibleDocsVersion: null,
  checkedAgainstDocsApi: null,
};

// Per-process memo: a single CLI invocation reads the cache at least twice
// (preAction → blockedVersions, postAction → latestVersion). Collapse those
// reads into one disk hit; the foreground never writes, so staleness is not
// a concern within a process. Writes keep the memo in sync.
const memoryCache = new Map<string, CacheData>();

/**
 * Manages the local update cache and its companion lock file.
 *
 * All public methods are safe to call concurrently — writes go through
 * an external file lock held by `UpdateNotifier.spawnBackgroundCheck()`.
 */
export class VersionCache {
  /** Local hour that anchors the once-per-day check window (21:00 → 21:00 next day). */
  private static readonly CHECK_WINDOW_HOUR = 21;
  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  private readonly cacheFilePath: string;
  private readonly lockFilePath: string;

  /** @param dir - directory that will hold `cache.json` and `check.lock` */
  constructor(dir: string) {
    this.cacheFilePath = path.join(dir, 'cache.json');
    this.lockFilePath = path.join(dir, 'check.lock');
  }

  /**
   * Record a successful version check with the discovered latest version and
   * blocked list. When `docs` is supplied its fields overwrite the prior docs
   * cache (even with nulls); when omitted, prior docs fields are preserved so a
   * failed docs query does not wipe a previously known compatible version.
   */
  async writeSuccess(
    latestVersion: string | null,
    blockedVersions: string[] = [],
    checkedAgainstVersion: string,
    checkedAgainstTag: string,
    docs?: DocsCacheFields
  ): Promise<void> {
    const prev = this.read();
    await this.write({
      lastCheckedTimestamp: Date.now(),
      latestVersion,
      blockedVersions,
      checkError: null,
      checkedAgainstVersion,
      checkedAgainstTag,
      latestDocsVersion: docs ? docs.latestDocsVersion : (prev.latestDocsVersion ?? null),
      latestDocsApiVersion: docs ? docs.latestDocsApiVersion : (prev.latestDocsApiVersion ?? null),
      latestCompatibleDocsVersion: docs
        ? docs.latestCompatibleDocsVersion
        : (prev.latestCompatibleDocsVersion ?? null),
      checkedAgainstDocsApi: docs ? docs.checkedAgainstDocsApi : (prev.checkedAgainstDocsApi ?? null),
    });
  }

  /** Record a failed check while preserving the previously cached version. */
  async writeError(error: string): Promise<void> {
    const current = this.read();
    await this.write({
      ...current,
      lastCheckedTimestamp: Date.now(),
      checkError: error,
    });
  }

  /** Return the last known latest version, or null if no check has succeeded yet. */
  getLatestVersion(): string | null {
    return this.read().latestVersion;
  }

  /** Return the cached blocked-versions list (empty when no check has succeeded). */
  getBlockedVersions(): string[] {
    return [...this.read().blockedVersions];
  }

  /** Return the running version captured when the cache was last written. */
  getCheckedAgainstVersion(): string | null | undefined {
    return this.read().checkedAgainstVersion;
  }

  /** Return the publish dist-tag captured when the cache was last written. */
  getCheckedAgainstTag(): string | null | undefined {
    return this.read().checkedAgainstTag;
  }

  /** Return the cached dist-tagged docs version, or null if not yet queried. */
  getLatestDocsVersion(): string | null | undefined {
    return this.read().latestDocsVersion ?? null;
  }

  /** Return the `apiVersion` of the cached dist-tagged docs version. */
  getLatestDocsApiVersion(): number | null | undefined {
    return this.read().latestDocsApiVersion ?? null;
  }

  /** Return the cached docs version if compatible, null if the tagged version needs a newer CLI. */
  getLatestCompatibleDocsVersion(): string | null | undefined {
    return this.read().latestCompatibleDocsVersion ?? null;
  }

  /** Return the `supportedDocsApi` used when the docs compatible version was cached. */
  getCheckedAgainstDocsApi(): number | null | undefined {
    return this.read().checkedAgainstDocsApi ?? null;
  }

  /**
   * Determine whether a background version check should run.
   *
   * The check cadence is anchored to 21:00 local time: each window runs
   * 21:00 → 21:00 the next day and fires at most one check. A check that
   * ran at 20:59 still triggers a fresh check at 21:00 (new window); a
   * check that ran at 21:30 suppresses further checks until 21:00 tomorrow.
   * The window start is 21:00 today when now is at or after 21:00, else 21:00
   * yesterday.
   *
   * Returns true when:
   * - No previous check exists (timestamp is null)
   * - The stored timestamp is in the future (corrupt / clock skew → treat as missing)
   * - The last check fell in an earlier window than the current one
   */
  isCheckNeeded(): boolean {
    const { lastCheckedTimestamp } = this.read();
    if (!lastCheckedTimestamp || lastCheckedTimestamp > Date.now()) {
      return true;
    }
    const today21 = new Date().setHours(
      VersionCache.CHECK_WINDOW_HOUR,
      0,
      0,
      0
    );
    const windowStart =
      today21 > Date.now() ? today21 - VersionCache.ONE_DAY_MS : today21;
    return lastCheckedTimestamp < windowStart;
  }

  /** Path to the lock file used to serialise concurrent background checks. */
  getLockPath(): string {
    return this.lockFilePath;
  }

  /** Read and parse the cache file; return defaults on any IO or parse error. */
  private read(): CacheData {
    const cached = memoryCache.get(this.cacheFilePath);
    if (cached) {
      return cached;
    }
    try {
      const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheData;
      memoryCache.set(this.cacheFilePath, parsed);
      return parsed;
    } catch {
      return { ...DEFAULT_CACHE };
    }
  }

  /** Atomically write the cache, creating parent directories as needed. */
  private async write(cache: CacheData): Promise<void> {
    debugLog(
      () =>
        `Writing update cache: lastChecked=${cache.lastCheckedTimestamp}, latest=${cache.latestVersion}, blocked=[${cache.blockedVersions.join(',')}], error=${cache.checkError}`
    );
    await fs.promises.mkdir(path.dirname(this.cacheFilePath), {
      recursive: true,
    });
    await fs.promises.writeFile(
      this.cacheFilePath,
      JSON.stringify(cache, null, 2),
      'utf-8'
    );
    memoryCache.set(this.cacheFilePath, cache);
  }
}
