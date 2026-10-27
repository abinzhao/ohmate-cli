/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  assertCacheDirSafe,
  CacheDirError,
  getCacheDir,
  resolveCanonicalPath,
  resolvePathInsideRoot,
} from '../data-dir.js';
import {
  getBuildLockFile,
  getBuildMetaFile,
  getBuildStatusFile,
  getDocsDir,
  getIndexDir,
  getIndexTmpDir,
  getSearchDbFile,
} from './doc-paths.js';
import { INDEX_LEXICON_FILES } from './lexicon.js';

class DocPathSafetyError extends Error {
  constructor(message: string) {
    super(`Unsafe documentation path: ${message}`);
    this.name = 'DocPathSafetyError';
  }
}

type DocStorageAssertMode = 'read' | 'write';

interface AssertDocStorageOptions {
  /** `read` skips `.tmp`; `write` is full (default). */
  mode?: DocStorageAssertMode;
}

export function isDocStorageError(error: unknown): error is Error {
  return (
    error instanceof CacheDirError ||
    error instanceof DocPathSafetyError ||
    (error instanceof Error &&
      (error.name === 'CacheDirError' || error.name === 'DocPathSafetyError'))
  );
}

function unsafePath(message: string): DocPathSafetyError {
  return new DocPathSafetyError(message);
}

function dataRootForContainment(): string {
  return resolveCanonicalPath(getCacheDir());
}

function assertInsideDataRoot(
  target: string,
  dataRoot: string,
  label: string
): string {
  const realTarget = resolvePathInsideRoot(target, dataRoot);
  if (realTarget === null) {
    throw unsafePath(`${label} resolves outside the data directory.`);
  }
  return realTarget;
}

async function assertSafeDirectory(
  directory: string,
  dataRoot: string
): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true });
  const realDir = assertInsideDataRoot(directory, dataRoot, 'directory');
  const entry = await fs.promises.stat(realDir);
  if (!entry.isDirectory()) {
    throw unsafePath('path must be a directory.');
  }
}

/** Existing path must resolve to a regular file inside the data root (ENOENT ok). */
export function assertSafeRegularFile(filePath: string): void {
  const dataRoot = dataRootForContainment();
  try {
    const realFile = assertInsideDataRoot(filePath, dataRoot, 'file');
    if (!fs.statSync(realFile).isFile()) {
      throw unsafePath('path must be a regular file.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      assertInsideDataRoot(path.dirname(filePath), dataRoot, 'file parent');
      return;
    }
    throw error;
  }
}

/** Ensures documentation paths under DATA_DIR stay inside the resolved data root. */
export async function assertDocStorageSafe(
  options: AssertDocStorageOptions = {}
): Promise<void> {
  const mode = options.mode ?? 'write';
  const dataRoot = await assertCacheDirSafe();
  await assertSafeDirectory(getDocsDir(), dataRoot);
  await assertSafeDirectory(getIndexDir(), dataRoot);
  if (mode === 'write') {
    await assertSafeDirectory(getIndexTmpDir(), dataRoot);
  }

  for (const filePath of [
    getSearchDbFile(),
    getBuildMetaFile(),
    getBuildStatusFile(),
    getBuildLockFile(),
    ...INDEX_LEXICON_FILES.map((name) => path.join(getIndexDir(), name)),
  ]) {
    assertSafeRegularFile(filePath);
  }
}
