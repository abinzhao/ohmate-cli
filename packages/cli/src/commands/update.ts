/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import * as path from 'path';
import { red, cyan, yellow } from 'colorette';
import { execa } from 'execa';
import {
  getPackageName,
  getCurrentVersion,
  getPublishTag,
  getSupportedDocsApi,
  getUpdateDisableMode,
} from '../update/index.js';
import { VersionCache, type DocsCacheFields } from '../update/version-cache.js';
import { resolveDocsVersions, unwrapViewResult } from '../update/docs-registry.js';
import { installDocsVersion } from '../update/docs-installer.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { compareVersions } from '../utils/semver.js';
import { debugLog } from '../utils/logger.js';
import { detectInstallMismatch } from '../install-check/index.js';
import { telemetry, EventType } from '../trace/index.js';
import type { CommandExecuted, TrackMeasurement } from '../trace/index.js';
import { getInstalledDocsVersion } from '../docs-loader.js';

const updateCommand = new Command('update').description(
  'Update deveco-cli to latest'
);

updateCommand.command('_check', { hidden: true }).action(async () => {
  const start = Date.now();
  const cache = new VersionCache(path.join(getCliDataDir(), 'update'));

  try {
    const publishTag = getPublishTag();
    const pkgName = getPackageName();

    // Fetch the tag-pinned version's package.json. npm <=11 returns flat
    // version metadata (with `version`/`blockedVersions`); npm 12 returns the
    // full packument (no top-level `version`), so resolve via dist-tags.
    debugLog(`Executing: npm view ${pkgName}@${publishTag} --json`);
    const { stdout } = await execa('npm', [
      'view',
      `${pkgName}@${publishTag}`,
      '--json',
    ]);
    const { latestVersion, blockedVersions } = resolveCliVersionMeta(
      stdout,
      publishTag
    );

    // Docs version is best-effort: a failure must not invalidate the CLI result
    // or wipe a previously cached compatible version.
    const docs = await resolveDocsCacheFields().catch((err) => {
      debugLog(
        `Docs version check failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    });

    await cache.writeSuccess(
      latestVersion,
      blockedVersions,
      getCurrentVersion(),
      publishTag,
      docs
    );
    await trackUpdateCheck(start, true, null);
  } catch (error) {
    await cache.writeError(
      error instanceof Error ? error.message : String(error)
    );
    const e = error as NodeJS.ErrnoException;
    const errorCode = e.code ?? e.name ?? 'UnknownError';
    await trackUpdateCheck(start, false, errorCode);
  }
});

/**
 * Resolve docs knowledgebase versions and shape them for the cache. Runs under
 * the background `_check` process using the running CLI's `supportedDocsApi`.
 */
async function resolveDocsCacheFields(): Promise<DocsCacheFields> {
  const supportedApi = getSupportedDocsApi();
  const { latest, compatible } = await resolveDocsVersions(supportedApi);
  return {
    latestDocsVersion: latest.version,
    latestDocsApiVersion: latest.apiVersion,
    latestCompatibleDocsVersion: compatible?.version ?? null,
    checkedAgainstDocsApi: supportedApi,
  };
}

/** Shape of the CLI package metadata returned by `npm view <pkg>@<tag> --json`. */
interface CliVersionMeta {
  version?: string;
  blockedVersions?: string[];
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { blockedVersions?: string[] }>;
}

/**
 * Parse `npm view <pkg>@<tag> --json` output into the latest version and
 * blocked-versions list. npm <=11 returns flat version metadata; npm 12 wraps
 * the result in a single-element array AND returns the full packument (no
 * top-level `version`), so the version is resolved via `dist-tags` and
 * `blockedVersions` via `versions[<ver>]` in that case.
 */
function resolveCliVersionMeta(
  stdout: string,
  publishTag: string
): { latestVersion: string | null; blockedVersions: string[] } {
  const info = unwrapViewResult<CliVersionMeta>(JSON.parse(stdout));
  let latestVersion: string | null = null;
  if (typeof info.version === 'string') {
    latestVersion = info.version.trim();
  } else if (info['dist-tags']?.[publishTag]) {
    latestVersion = info['dist-tags'][publishTag]!.trim();
  }
  let blockedVersions: string[] = [];
  if (Array.isArray(info.blockedVersions)) {
    blockedVersions = info.blockedVersions;
  } else if (latestVersion && info.versions?.[latestVersion]?.blockedVersions) {
    blockedVersions = info.versions[latestVersion]!.blockedVersions!;
  }
  return { latestVersion, blockedVersions };
}

const updateEvent: CommandExecuted = {
  event: EventType.CommandExecuted,
  args: ['update'],
};

const updateCheckEvent: CommandExecuted = {
  event: EventType.CommandExecuted,
  args: ['update', '_check'],
};

async function trackUpdate(
  start: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(updateEvent, measurement).catch(() => {});
}

async function trackUpdateCheck(
  start: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(updateCheckEvent, measurement).catch(() => {});
}

/** Report a CLI update failure and exit with telemetry. */
async function reportUpdateFailure(
  pkgName: string,
  start: number,
  error: unknown
): Promise<void> {
  const e = error as NodeJS.ErrnoException;
  const errorCode = e.code ?? e.name ?? 'UnknownError';
  console.error(red(`Failed to update ${pkgName}`));
  if (e.message) {
    console.error(red(e.message));
  }
  await trackUpdate(start, false, errorCode);
  process.exit(1);
}

updateCommand.action(async () => {
  if (getUpdateDisableMode() === 'all') {
    throw new Error('devecocli update is disabled (DEVECO_CLI_DISABLE_UPDATE=all).');
  }
  await detectInstallMismatch(getPackageName());
  const start = Date.now();
  const currentVersion = getCurrentVersion();
  const publishTag = getPublishTag();
  const pkgName = getPackageName();

  console.log(cyan(`Checking for updates...`));
  try {
    // Get the tagged version from npm registry
    const { stdout: latestVersion } = await execa('npm', [
      'view',
      pkgName,
      `dist-tags.${publishTag}`,
    ]);
    const latest = latestVersion.trim();

    if (!latest || latest === currentVersion) {
    console.log(yellow(`\n${pkgName} is already up to date (v${currentVersion}, tag: ${publishTag})`));
      await trackUpdate(start, true, null);
      return;
    }

    console.log(
      cyan(`\nNew version found: ${latest} (current: ${currentVersion})`)
    );
    console.log(cyan(`Updating ${pkgName}...`));

    await execa('npm', ['install', '-g', `${pkgName}@${publishTag}`], {
      stdio: 'inherit',
    });

    console.log(yellow(`\nCLI successfully updated to ${latest}`));

    // Silently sync Docs to the latest version compatible with the upgraded
    // CLI, then Re-check for an even newer compatible Docs. Non-fatal: the CLI
    // upgrade itself already succeeded.
    await autoSyncDocs(latest).catch((err) => {
      debugLog(
        `Docs auto-sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    await trackUpdate(start, true, null);
  } catch (error) {
    await reportUpdateFailure(pkgName, start, error);
  }
});

/**
 * After the CLI is upgraded to `latestCliVersion`, read the upgraded CLI's
 * `supportedDocsApi` from its published metadata and sync Docs to the highest
 * compatible version. Then Re-check whether an even newer compatible Docs was
 * published in the window and surface it as a manual upgrade prompt.
 */
async function autoSyncDocs(latestCliVersion: string): Promise<void> {
  const pkgName = getPackageName();
  debugLog(`Executing: npm view ${pkgName}@${latestCliVersion} --json`);
  const { stdout } = await execa('npm', [
    'view',
    `${pkgName}@${latestCliVersion}`,
    '--json',
  ]);
  const info = unwrapViewResult<{ supportedDocsApi?: number }>(
    JSON.parse(stdout)
  );
  const newSupportedApi =
    typeof info.supportedDocsApi === 'number'
      ? info.supportedDocsApi
      : getSupportedDocsApi();

  const { compatible } = await resolveDocsVersions(newSupportedApi);
  if (!compatible) {
    debugLog('Docs auto-sync: no compatible docs version found, skipping');
    return;
  }

  const docDataDir = path.join(getCliDataDir(), 'doc-data');
  const installedDocs = await getInstalledDocsVersion();
  if (!installedDocs || (await compareVersions(compatible.version, installedDocs)) > 0) {
    await installDocsVersion(
      {
        version: compatible.version,
        apiVersion: compatible.apiVersion,
        dist: compatible.dist,
      },
      docDataDir,
      'cli-update'
    );
  }
  console.log(
    yellow(
      `Docs has been automatically synced to the compatible version ${compatible.version}`
    )
  );

  // Re-check: a newer compatible Docs may have been published in the window.
  const recheck = await resolveDocsVersions(newSupportedApi).catch(() => null);
  if (
    recheck?.compatible &&
    (await compareVersions(recheck.compatible.version, compatible.version)) > 0
  ) {
    console.log(
      cyan(
        `New docs version ${recheck.compatible.version} available, run \`devecocli docs update\` to upgrade`
      )
    );
  }
}

export default updateCommand;
