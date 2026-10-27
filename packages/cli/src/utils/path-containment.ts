/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';

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
