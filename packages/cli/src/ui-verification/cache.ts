/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UI_VERIFICATION_CACHE_DIR = path.join(
  os.tmpdir(),
  'ui-verification',
  'cache'
);

const MAX_CACHE_ENTRIES = 15;

export function pruneUiVerificationCache(
  cacheDir = UI_VERIFICATION_CACHE_DIR,
  maxEntries = MAX_CACHE_ENTRIES
): void {
  if (!fs.existsSync(cacheDir)) {
    return;
  }

  const entries = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const entryPath = path.join(cacheDir, entry.name);
      return { entryPath, mtime: fs.statSync(entryPath).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);

  for (const entry of entries.slice(0, Math.max(0, entries.length - maxEntries))) {
    fs.rmSync(entry.entryPath, { recursive: true, force: true });
  }
}
