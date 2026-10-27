/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';

/** Error thrown when the cache directory is unusable. */
export class CacheDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheDirError';
  }
}

let _cacheDir: string | null = null;

/** Set the cache directory. Called by createDocsEngine before any path resolution. */
export function setCacheDir(dir: string): void {
  _cacheDir = path.resolve(dir);
}

/** Get the cache directory. Must be set via setCacheDir first. */
export function getCacheDir(): string {
  if (_cacheDir === null) {
    throw new CacheDirError(
      'Cache directory not initialized. Call createDocsEngine first.'
    );
  }
  return _cacheDir;
}

/** Ensure the cache directory exists and is a writable directory. */
export async function assertCacheDirSafe(): Promise<string> {
  const dataDir = getCacheDir();
  await fs.promises.mkdir(dataDir, { recursive: true });
  const realDir = await fs.promises.realpath(dataDir);
  const stat = await fs.promises.stat(realDir);
  if (!stat.isDirectory()) {
    throw new CacheDirError('Cache directory must be a writable directory.');
  }
  return realDir;
}

/* --- Path containment helpers (inlined from cli utils/path-containment.ts) --- */

/** Pure string check: is `child` equal to or under `parent`? (no FS I/O) */
export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..')
  );
}

export function resolveCanonicalPath(value: string): string {
  const resolved = path.resolve(value);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length === 0
        ? real
        : path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function resolvePathInsideRoot(
  child: string,
  root: string
): string | null {
  const realRoot = resolveCanonicalPath(root);
  const realChild = resolveCanonicalPath(child);
  return isPathInside(realChild, realRoot) ? realChild : null;
}
