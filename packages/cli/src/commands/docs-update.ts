/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { cyan, yellow } from 'colorette';
import * as path from 'path';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { compareVersions } from '../utils/semver.js';
import { getSupportedDocsApi } from '../update/index.js';
import {
  resolveDocsVersions,
  type DocsVersionMeta,
} from '../update/docs-registry.js';
import { installDocsVersion } from '../update/docs-installer.js';
import { getInstalledDocsVersion } from '../docs-loader.js';

interface UpdateDocsOptions {
  force?: boolean;
  check?: boolean;
}

/** Shared tail line for the "latest is incompatible" guidance. */
function latestIncompatibleHint(latestVersion: string): string {
  return yellow(
    `If you want the latest docs(${latestVersion}), please update CLI first: run \`devecocli update\` to update`
  );
}

/** Print when no docs version is compatible with this CLI at all. */
function reportNoCompatible(latest: DocsVersionMeta): void {
  console.log(
    yellow(
      `Latest docs v${latest.version} (apiVersion ${latest.apiVersion}) is incompatible with current CLI.`
    )
  );
  console.log(latestIncompatibleHint(latest.version));
}

/** Print the `--check` report (no install). */
function reportCheckOnly(
  compatibleVersion: string,
  installedDocs: string | null,
  hasUpdate: boolean
): void {
  if (hasUpdate) {
    console.log(
      cyan(
        `New docs version ${compatibleVersion} found (current v${installedDocs ?? 'none'})`
      )
    );
  } else {
    console.log(
      cyan(`Documentation is already up to date v${compatibleVersion}`)
    );
  }
}

async function runDocsUpdate(opts: UpdateDocsOptions): Promise<void> {
  const supportedApi = getSupportedDocsApi();
  console.log(cyan('Checking for documentation updates...'));
  const { latest, compatible } = await resolveDocsVersions(supportedApi);

  if (!compatible) {
    reportNoCompatible(latest);
    return;
  }

  const installedDocs = await getInstalledDocsVersion();
  const hasUpdate =
    !installedDocs || (await compareVersions(compatible.version, installedDocs)) > 0;

  if (opts.check) {
    reportCheckOnly(compatible.version, installedDocs, hasUpdate);
    return;
  }

  if (!opts.force && !hasUpdate) {
    console.log(yellow(`Docs is already up to date v${compatible.version}`));
    return;
  }

  console.log(
    cyan(`Downloading documentation package v${compatible.version}...`)
  );
  await installDocsVersion(
    {
      version: compatible.version,
      apiVersion: compatible.apiVersion,
      dist: compatible.dist,
    },
    path.join(getCliDataDir(), 'doc-data'),
    'docs-update'
  );
  console.log(yellow(`Docs successfully upgrade to ${compatible.version}`));
}

const docsUpdateCommand = new Command('update')
  .description('Update documentation to the latest compatible version')
  .option('--force', 'Force re-download even if up to date')
  .option('--check', 'Check for updates without installing')
  .action(async (opts: UpdateDocsOptions) => {
    await runDocsUpdate(opts);
  });

export default docsUpdateCommand;
