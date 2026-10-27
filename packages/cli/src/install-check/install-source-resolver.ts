/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { execa } from 'execa';
import { yellow } from 'colorette';
import { debugLog } from '../utils/logger.js';
import { isPathInside } from '../utils/path-containment.js';

/** Skip in dev mode (tsx runs a .ts entry) or when the entry path is missing. */
function shouldSkipCheck(entryPath: string | undefined): boolean {
  if (!entryPath) {
    return true;
  }
  return entryPath.endsWith('.ts');
}

/** Check if a directory's package.json has `name === pkgName`. */
function packageNameMatches(dir: string, pkgName: string): boolean {
  const pj = path.join(dir, 'package.json');
  try {
    const json = JSON.parse(
      fs.readFileSync(pj, 'utf8')
    ) as { name?: unknown };
    return json.name === pkgName;
  } catch {
    return false;
  }
}

/**
 * Walk up from a cli.js entry to find its package root: the nearest ancestor
 * whose `package.json` has `name === pkgName`. Returns the dir, or null when
 * the entry is unreadable or no matching package.json is found within 20 levels.
 */
function resolveRunningPackageRoot(
  entryPath: string,
  pkgName: string
): string | null {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(entryPath));
  } catch {
    return null;
  }
  for (let i = 0; i < 20 && dir && dir !== path.dirname(dir); i++) {
    if (packageNameMatches(dir, pkgName)) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** Spawn `npm root -g` and return the global node_modules dir, or null on failure. */
async function resolveNpmGlobalRoot(): Promise<string | null> {
  try {
    debugLog('Executing: npm root -g');
    const { stdout } = await execa('npm', ['root', '-g']);
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch (error) {
    debugLog(
      `[install-check] npm root -g failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** True when `packageRoot` lives inside `npmGlobalRoot` (same npm installation). */
function isSameInstallTree(
  packageRoot: string,
  npmGlobalRoot: string
): boolean {
  return isPathInside(packageRoot, npmGlobalRoot);
}

/**
 * Check whether the running binary lives in the same install tree as npm's
 * global root. If not, warns (yellow, non-blocking) so the user can see the
 * mismatch and Ctrl+C the update before it lands in the wrong place.
 * Does NOT abort the update — the user decides whether to continue.
 */
export async function detectInstallMismatch(
  pkgName: string
): Promise<void> {
  if (process.env.DEVECO_CLI_SKIP_INSTALL_CHECK) {
    return;
  }
  const entryPath = process.argv[1];
  if (shouldSkipCheck(entryPath)) {
    return;
  }
  const npmGlobalRoot = await resolveNpmGlobalRoot();
  if (!npmGlobalRoot) {
    return;
  }
  const runningRoot = resolveRunningPackageRoot(entryPath!, pkgName);
  if (!runningRoot) {
    debugLog('[install-check] running package root not found, skipping');
    return;
  }
  if (isSameInstallTree(runningRoot, npmGlobalRoot)) {
    return;
  }
  console.log();
  console.log(
    yellow(
      `Warning: devecocli is running from\n  ${runningRoot}\nbut \`npm\` in PATH installs global packages to\n  ${npmGlobalRoot}\n` +
        `The devecocli binary in PATH does not match the npm that \`devecocli update\` uses.\n` +
        `The update would land in the wrong place and would not reach the binary you are running.\n` +
        `Continuing with update — abort if this is unexpected.\n` +
        `Fix: run \`which -a devecocli\` (Windows: \`where devecocli\`) to list all shims, remove the stale one, or reinstall with the matching npm: \`npm install -g ${pkgName}@latest\`.`
    )
  );
}
