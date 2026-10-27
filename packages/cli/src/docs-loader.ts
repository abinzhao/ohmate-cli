/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { loadSemver } from './utils/semver.js';
import { getCliDataDir } from './utils/cli-data-dir.js';
import { debugLog } from './utils/logger.js';
import { DOCS_PKG_NAME, getSupportedDocsApi } from './update/constants.js';

const require = createRequire(import.meta.url);

interface DocsCandidate {
  version: string;
  apiVersion: number;
  dir: string;
}

export interface DocsEngineModule {
  apiVersion: number;
  createDocsEngine(options: { cacheDir: string }): Promise<unknown>;
  CATALOG_NAMES?: readonly string[];
  [key: string]: unknown;
}

async function findBundledDocs(): Promise<DocsCandidate | null> {
  try {
    const manifest = require.resolve(`${DOCS_PKG_NAME}/package.json`);
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    return {
      version: pkg.version,
      apiVersion: pkg.apiVersion ?? 0,
      dir: dirname(manifest),
    };
  } catch {
    return null;
  }
}

async function findUpdatedDocs(): Promise<DocsCandidate | null> {
  const dataDir = getCliDataDir();
  const currentFile = join(dataDir, 'doc-data', 'current.json');
  let current: { version: string; apiVersion: number };
  try {
    current = JSON.parse(await readFile(currentFile, 'utf8'));
  } catch {
    return null;
  }
  const dir = join(dataDir, 'doc-data', current.version);
  try {
    await access(join(dir, 'dist', 'engine', 'index.js'));
    await access(join(dir, 'docs.zip'));
    await access(join(dir, 'index.zip'));
    return { version: current.version, apiVersion: current.apiVersion, dir };
  } catch {
    return null;
  }
}

/** Gather installed docs candidates (updated > bundled), newest version first. */
async function collectDocsCandidates(): Promise<DocsCandidate[]> {
  const semver = await loadSemver();
  const candidates = [await findUpdatedDocs(), await findBundledDocs()]
    .filter((c): c is DocsCandidate => c !== null)
    .sort((a, b) => semver.rcompare(a.version, b.version));
  return candidates;
}

/**
 * Returns the version of the highest installed docs candidate the running CLI
 * can load, or null when none is compatible. Used by the update notifier to
 * decide whether a newer compatible docs version is available.
 */
export async function getCurrentDocsVersion(): Promise<string | null> {
  const supportedApi = getSupportedDocsApi();
  for (const candidate of await collectDocsCandidates()) {
    if (candidate.apiVersion <= supportedApi) {
      return candidate.version;
    }
  }
  return null;
}

/**
 * Returns the version installed in the data directory via `docs update`, or
 * null when no updated copy exists. Unlike {@link getCurrentDocsVersion}, this
 * does NOT fall back to the bundled copy — callers that decide whether to
 * download use this to distinguish "nothing installed" from "an older version
 * is installed".
 */
export async function getInstalledDocsVersion(): Promise<string | null> {
  const supportedApi = getSupportedDocsApi();
  const updated = await findUpdatedDocs();
  if (updated && updated.apiVersion <= supportedApi) {
    return updated.version;
  }
  return null;
}

export async function loadDocsEngineModule(): Promise<DocsEngineModule> {
  const supportedApi = getSupportedDocsApi();
  const candidates = await collectDocsCandidates();

  let foundCompatible = false;

  for (const candidate of candidates) {
    if (candidate.apiVersion > supportedApi) {
      debugLog(
        `docs: skip candidate v${candidate.version} (apiVersion ${candidate.apiVersion} > ${supportedApi})`
      );
      continue;
    }
    foundCompatible = true;
    try {
      const entry = join(candidate.dir, 'dist', 'engine', 'index.js');
      const mod = await import(pathToFileURL(entry).href);
      return mod as DocsEngineModule;
    } catch (e) {
      debugLog(
        `docs: candidate v${candidate.version} load failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  if (candidates.length > 0 && !foundCompatible) {
    throw new Error(
      'Documentation package version is incompatible, please upgrade CLI'
    );
  }
  throw new Error(
    'No available documentation package, please run `devecocli docs update` or reinstall CLI'
  );
}
