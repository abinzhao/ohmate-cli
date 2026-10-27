/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getCacheDir, isPathInside } from '../data-dir.js';

const DOCS_DIR_NAME = 'docs';

export function getDocsDir(): string {
  return path.join(getCacheDir(), DOCS_DIR_NAME);
}

export function getIndexDir(): string {
  return path.join(getDocsDir(), '.index');
}

export function getBuildLockFile(): string {
  return path.join(getIndexDir(), 'build.lock');
}

export function getBuildStatusFile(): string {
  return path.join(getIndexDir(), 'build-status.json');
}

export function getBuildMetaFile(): string {
  return path.join(getIndexDir(), 'build-meta.json');
}

export function getSearchDbFile(): string {
  return path.join(getIndexDir(), 'search.db');
}

export function getIndexTmpDir(): string {
  return path.join(getIndexDir(), '.tmp');
}

function getDistDir(currentFilePath: string, currentDir: string): string {
  let dir = currentDir;
  while (!dir.endsWith(`${path.sep}dist`) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  return dir;
}

function getPackageRootFromDist(
  currentFilePath: string,
  currentDir: string
): string {
  return path.dirname(getDistDir(currentFilePath, currentDir));
}

export function getPackageRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);

  if (currentFilePath.includes(`${path.sep}dist${path.sep}`)) {
    return getPackageRootFromDist(currentFilePath, currentDir);
  }

  return path.join(currentDir, '..', '..', '..');
}

function resolvePackageRelativePath(...segments: string[]): string[] {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);

  if (currentFilePath.includes(`${path.sep}dist${path.sep}`)) {
    return [
      path.join(
        getPackageRootFromDist(currentFilePath, currentDir),
        ...segments
      ),
    ];
  }

  return [path.join(currentDir, '..', '..', '..', ...segments)];
}

function findBundledAsset(...segments: string[]): string | null {
  const packageRoot = getPackageRoot();
  const realPackageRoot = fs.realpathSync(packageRoot);
  for (const candidate of resolvePackageRelativePath(...segments)) {
    try {
      const entry = fs.lstatSync(candidate);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Unsafe documentation package asset: ${segments.join('/')} must be a regular file.`
        );
      }
      const realCandidate = fs.realpathSync(candidate);
      if (!isPathInside(realCandidate, realPackageRoot)) {
        throw new Error(
          `Unsafe documentation package asset: ${segments.join('/')} is outside the package.`
        );
      }
      return realCandidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return null;
}

export function findDocsZip(): string | null {
  return findBundledAsset('docs.zip');
}

export function findBundledIndexZip(): string | null {
  return findBundledAsset('index.zip');
}

export function getBuildLexiconDir(): string {
  const root = getPackageRoot();
  const candidates = [
    path.join(root, 'packages', 'docs-index-builder', 'data'),
    path.join(root, 'docs-index-builder', 'data'),
    path.join(root, '..', 'packages', 'docs-index-builder', 'data'),
    path.join(root, 'index', 'data'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'harmonyos-terms.txt'))) {
      return c;
    }
  }
  return candidates[0];
}
