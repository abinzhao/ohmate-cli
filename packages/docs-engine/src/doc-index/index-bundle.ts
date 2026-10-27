/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import {
  findBundledIndexZip,
  getIndexDir,
  getIndexTmpDir,
} from './doc-paths.js';
import { INDEX_VERSION } from './constants.js';
import { INDEX_LEXICON_FILES } from './lexicon.js';
import { assertDocStorageSafe } from './path-safety.js';
import type { BuildMeta } from './segment-types.js';

const BUNDLE_FILES = [
  'search.db',
  'build-meta.json',
  ...INDEX_LEXICON_FILES,
] as const;
const LEGACY_INDEX_FILES = [
  'corpus.json',
  'corpus-offsets.json',
  'orama.dpack',
];

async function cleanLegacyIndexArtifacts(indexDir: string): Promise<void> {
  for (const name of LEGACY_INDEX_FILES) {
    await fs.promises.rm(path.join(indexDir, name), { force: true });
  }
}

function readBundleMetaFromZip(indexZipPath: string): BuildMeta {
  const zip = new AdmZip(indexZipPath);
  const entry = zip.getEntry('build-meta.json');
  if (!entry) {
    throw new Error('index.zip is missing build-meta.json');
  }
  return JSON.parse(entry.getData().toString('utf-8')) as BuildMeta;
}

async function commitBundleFiles(tmpDir: string): Promise<void> {
  const indexDir = getIndexDir();
  await fs.promises.mkdir(indexDir, { recursive: true });

  for (const file of BUNDLE_FILES) {
    const target = path.join(indexDir, file);
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(path.join(tmpDir, file), target);
  }

  await cleanLegacyIndexArtifacts(indexDir);
  await fs.promises.rm(getIndexTmpDir(), { recursive: true, force: true });
}

export function hasBundledIndexZip(): boolean {
  const bundlePath = findBundledIndexZip();
  return bundlePath !== null && fs.existsSync(bundlePath);
}

export function isBundledIndexUsable(docsZipSha256: string): boolean {
  const bundlePath = findBundledIndexZip();
  if (!bundlePath) {
    return false;
  }
  try {
    const meta = readBundleMetaFromZip(bundlePath);
    return (
      meta.indexVersion === INDEX_VERSION &&
      meta.docsZipSha256 === docsZipSha256 &&
      meta.segmentCount > 0
    );
  } catch {
    return false;
  }
}

export async function installBundledIndex(
  docsZipSha256: string
): Promise<BuildMeta> {
  await assertDocStorageSafe({ mode: 'write' });
  const bundlePath = findBundledIndexZip();
  if (!bundlePath) {
    throw new Error('index.zip not found');
  }

  const bundleMeta = readBundleMetaFromZip(bundlePath);
  if (bundleMeta.docsZipSha256 !== docsZipSha256) {
    throw new Error(
      'Bundled index.zip does not match docs.zip. Rebuild index.zip with npm run build:index.'
    );
  }
  if (bundleMeta.segmentCount <= 0) {
    throw new Error('Bundled index.zip is empty');
  }

  const tmpDir = getIndexTmpDir();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const zip = new AdmZip(bundlePath);
  for (const file of BUNDLE_FILES) {
    const entry = zip.getEntry(file);
    if (!entry) {
      throw new Error(`index.zip is missing ${file}`);
    }
    await fs.promises.writeFile(path.join(tmpDir, file), entry.getData());
  }

  const installedMeta = JSON.parse(
    await fs.promises.readFile(path.join(tmpDir, 'build-meta.json'), 'utf-8')
  ) as BuildMeta;

  if (!fs.existsSync(path.join(tmpDir, 'search.db'))) {
    throw new Error('index.zip is missing search.db');
  }

  await commitBundleFiles(tmpDir);
  return installedMeta;
}

export async function resetBundledInstallScratch(): Promise<void> {
  await fs.promises.rm(getIndexTmpDir(), { recursive: true, force: true });
  const indexDir = getIndexDir();
  for (const file of BUNDLE_FILES) {
    await fs.promises.rm(path.join(indexDir, file), { force: true });
  }
}
