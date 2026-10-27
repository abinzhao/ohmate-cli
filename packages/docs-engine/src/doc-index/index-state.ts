/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { INDEX_VERSION } from './constants.js';
import {
  findDocsZip,
  getBuildMetaFile,
  getBuildStatusFile,
  getSearchDbFile,
} from './doc-paths.js';
import { INDEX_LEXICON_FILES } from './lexicon.js';
import { isDocsZipAvailable } from './docs-zip-reader.js';
import { hasBundledIndexZip } from './index-bundle.js';
import { sha256File } from './hash-utils.js';
import { getSynonymsHash, getTermsHash } from './query-rewriter.js';
import type { BuildMeta, BuildStatus, RebuildReason } from './segment-types.js';

const DEFAULT_STATUS: BuildStatus = {
  state: 'idle',
  phase: 0,
  phaseLabel: 'Idle',
  current: 0,
  total: 0,
  message: '',
  startedAt: 0,
  updatedAt: 0,
  error: null,
};

export async function readBuildStatus(): Promise<BuildStatus> {
  try {
    const raw = await fs.promises.readFile(getBuildStatusFile(), 'utf-8');
    return JSON.parse(raw) as BuildStatus;
  } catch {
    return { ...DEFAULT_STATUS };
  }
}

export async function writeBuildStatus(status: BuildStatus): Promise<void> {
  const filePath = getBuildStatusFile();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(status, null, 2));
}

export function createInitialStatus(message: string): BuildStatus {
  const now = Date.now();
  return {
    state: 'installing',
    phase: 1,
    phaseLabel: 'Preparing documentation index',
    current: 0,
    total: 0,
    message,
    startedAt: now,
    updatedAt: now,
    error: null,
  };
}

export async function updateBuildStatus(
  partial: Partial<BuildStatus>
): Promise<BuildStatus> {
  const current = await readBuildStatus();
  const next: BuildStatus = {
    ...current,
    ...partial,
    updatedAt: Date.now(),
  };
  await writeBuildStatus(next);
  return next;
}

export async function getBundledDocsZipSha256(): Promise<string | null> {
  const zipPath = findDocsZip();
  if (!zipPath) {
    return null;
  }
  return sha256File(zipPath);
}

export async function readBuildMeta(): Promise<BuildMeta | null> {
  try {
    const raw = await fs.promises.readFile(getBuildMetaFile(), 'utf-8');
    return JSON.parse(raw) as BuildMeta;
  } catch {
    return null;
  }
}

export async function needsRebuildIndex(
  force = false
): Promise<RebuildReason | null> {
  if (force) {
    return 'no-index';
  }

  const meta = await readBuildMeta();
  if (!meta || meta.segmentCount === 0) {
    return 'no-index';
  }

  const bundled = await getBundledDocsZipSha256();
  if (bundled && meta.docsZipSha256 !== bundled) {
    return 'docs-changed';
  }
  if (meta.indexVersion !== INDEX_VERSION) {
    return 'engine-upgraded';
  }
  if (meta.termsHash !== getTermsHash()) {
    return 'terms-changed';
  }
  if (meta.synonymsHash !== getSynonymsHash()) {
    return 'synonyms-changed';
  }

  return null;
}

export function isIndexReady(): boolean {
  if (!isDocsZipAvailable()) {
    return false;
  }
  if (!fs.existsSync(getSearchDbFile()) || !fs.existsSync(getBuildMetaFile())) {
    return false;
  }
  const indexDir = path.dirname(getSearchDbFile());
  if (
    !INDEX_LEXICON_FILES.every((name) =>
      fs.existsSync(path.join(indexDir, name))
    )
  ) {
    return false;
  }
  try {
    const raw = fs.readFileSync(getBuildMetaFile(), 'utf-8');
    const meta = JSON.parse(raw) as BuildMeta;
    return meta.segmentCount > 0;
  } catch {
    return false;
  }
}

export async function needsIndexInstall(force = false): Promise<boolean> {
  if (force) {
    return true;
  }
  if (!isDocsZipAvailable()) {
    return false;
  }
  if (!isIndexReady()) {
    return true;
  }
  return (await needsRebuildIndex()) !== null;
}

export async function isBuildInProgress(): Promise<boolean> {
  const status = await readBuildStatus();
  return ['installing', 'indexing', 'persisting'].includes(status.state);
}

export { hasBundledIndexZip };
