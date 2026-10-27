/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { yellow, cyan } from 'colorette';
import lockfile from 'proper-lockfile';
import { debugLog } from '../utils/logger.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { compareVersions } from '../utils/semver.js';
import { getCurrentVersion, getPublishTag, getSupportedDocsApi } from './constants.js';
import { VersionCache } from './version-cache.js';
import { getInstalledDocsVersion } from '../docs-loader.js';

/**
 * Orchestrates non-blocking update notifications.
 *
 * Lifecycle: constructed per CLI invocation → `checkAndNotify()` called from
 * the Commander `postAction` hook so the prompt appears *after* the user's
 * command completes. The actual registry query runs in a detached child
 * process (`update _check`) so the foreground command is never blocked.
 */
export class UpdateNotifier {
  private readonly cache = new VersionCache(
    path.join(getCliDataDir(), 'update')
  );

  /** @param actionCommand - the leaf Commander command that was invoked */
  constructor(private readonly actionCommand: Command) {}

  /** Show an upgrade banner if a newer version is cached, then schedule a background refresh if due. */
  async checkAndNotify(): Promise<void> {
    if (this.shouldSkip()) {
      return;
    }

    try {
      const current = getCurrentVersion();
      const currentTag = getPublishTag();
      const cachedVersion = this.cache.getCheckedAgainstVersion();
      const cachedTag = this.cache.getCheckedAgainstTag();

      // A tag switch invalidates the cached latestVersion: it was fetched via
      // `npm view dist-tags.<oldTag>`, so it belongs to the wrong dist-tag and
      // must not be surfaced — just force a refresh.
      const tagChanged = cachedTag != null && cachedTag !== currentTag;
      const versionChanged = cachedVersion != null && cachedVersion !== current;

      const messages: string[] = [];

      // CLI line (yellow, current style).
      const latestVersion = tagChanged ? null : this.cache.getLatestVersion();
      if (latestVersion && (await compareVersions(latestVersion, current)) > 0) {
        messages.push(
          yellow(
            `New cli version ${latestVersion} available, run \`devecocli update\` to update`
          )
        );
      }

      // Docs line (cyan).
      const docs = await this.buildDocsMessage();
      if (docs.message) {
        messages.push(docs.message);
      }

      if (messages.length > 0) {
        console.log();
        for (const msg of messages) {
          console.log(msg);
        }
      }

      if (
        tagChanged ||
        versionChanged ||
        docs.stale ||
        this.cache.isCheckNeeded()
      ) {
        await this.spawnBackgroundCheck();
      }
    } catch (error) {
      debugLog(
        `Update check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Build the docs upgrade line (cyan) when a newer compatible version is
   * cached for the running CLI's `supportedDocsApi`.
   *
   * Returns `stale: true` ONLY when the cache was computed under a DIFFERENT
   * supported api (a real API change → force a background refresh). A null
   * `checkedAgainstDocsApi` means the docs query never succeeded (or never
   * ran); that is NOT treated as stale — it relies on the normal daily
   * `isCheckNeeded()` cycle so a transient docs-query failure does not
   * re-launch the background check on every command.
   */
  private async buildDocsMessage(): Promise<{
    message: string | null;
    stale: boolean;
  }> {
    const supportedApi = getSupportedDocsApi();
    const cachedApi = this.cache.getCheckedAgainstDocsApi();
    if (cachedApi != null && cachedApi !== supportedApi) {
      return { message: null, stale: true };
    }
    const compatibleDocs = this.cache.getLatestCompatibleDocsVersion();
    if (!compatibleDocs) {
      return { message: null, stale: false };
    }
    const installedDocs = await getInstalledDocsVersion();
    if (installedDocs && (await compareVersions(compatibleDocs, installedDocs)) <= 0) {
      return { message: null, stale: false };
    }
    return {
      message: cyan(
        `New docs version ${compatibleDocs} available, run \`devecocli docs update\` to upgrade`
      ),
      stale: false,
    };
  }

  /** Skip notification when the user is already running an `update` subcommand. */
  private shouldSkip(): boolean {
    let current: Command | null = this.actionCommand;
    while (current) {
      if (current.name() === 'update') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** Spawn `devecocli update _check` as a detached background process under a file lock. */
  private async spawnBackgroundCheck(): Promise<void> {
    // In tsx dev mode the entry is a .ts file that bare `node` can't execute,
    // so a detached child would silently fail — skip the background spawn.
    if (process.argv[1]?.endsWith('.ts')) {
      return;
    }
    try {
      await withLock(this.cache.getLockPath(), () => {
        // Production entry is dist/cli.js; argv[1] resolves to it when installed.
        const args = [process.argv[1], 'update', '_check'];
        debugLog(`Executing: ${process.execPath} ${args.join(' ')}`);

        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            ...process.env,
            // Prevent recursive version checks in the child process
            DEVECO_CLI_SKIP_VERSION_CHECK: '1',
          },
        });
        child.unref();
      });
    } catch {
      debugLog('Update check lock held by another process, skipping');
    }
  }
}

/** Acquire a short-lived file lock, run `fn`, then release — guarantees cleanup on success or failure. */
async function withLock(
  lockPath: string,
  fn: () => void | Promise<void>
): Promise<void> {
  // Ensure the parent dir exists before locking; the background write that
  // would normally create it only runs after this lock is acquired.
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const release = await lockfile.lock(lockPath, {
    stale: 60_000, // auto-break locks older than 60 s to avoid deadlocks
    retries: 0, // don't wait — another check is already running
    realpath: false,
  });
  try {
    await fn();
  } finally {
    await release();
  }
}
