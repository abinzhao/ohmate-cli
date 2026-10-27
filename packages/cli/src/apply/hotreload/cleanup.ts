/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as path from 'path';
import { debugLog } from '../../utils/logger.js';

export interface CleanupResult {
  success: boolean;
  deletedFiles: string[];
  message: string;
}

export class Cleanup {
  public static deleteAbcFiles(abcOutputDir: string): CleanupResult {
    if (!fs.existsSync(abcOutputDir)) {
      const msg = `abc output directory does not exist, skipping cleanup: ${abcOutputDir}`;
      debugLog(`[Cleanup] ${msg}`);
      return {
        success: true,
        deletedFiles: [],
        message: msg,
      };
    }

    const abcFiles = Cleanup.findAbcFiles(abcOutputDir);

    if (abcFiles.length === 0) {
      const msg = `No .abc files found in ${abcOutputDir}, nothing to clean up.`;
      debugLog(`[Cleanup] ${msg}`);
      return {
        success: true,
        deletedFiles: [],
        message: msg,
      };
    }

    const deletedFiles: string[] = [];
    let hasError = false;

    for (const filePath of abcFiles) {
      try {
        fs.unlinkSync(filePath);
        deletedFiles.push(filePath);
        debugLog(`[Cleanup] Deleted: ${filePath}`);
      } catch (error) {
        hasError = true;
        console.error(
          `[HotReload] Failed to delete ${filePath}: ${(error as Error).message}`
        );
      }
    }

    if (hasError) {
      return {
        success: false,
        deletedFiles,
        message: `Cleanup completed with errors. Deleted ${deletedFiles.length}/${abcFiles.length} .abc files.`,
      };
    }

    console.log(`[HotReload] Cleanup: deleted ${deletedFiles.length} .abc file(s).`);
    return {
      success: true,
      deletedFiles,
      message: `Successfully deleted ${deletedFiles.length} .abc file(s).`,
    };
  }

  private static findAbcFiles(dir: string): string[] {
    const results: string[] = [];

    const walk = (currentDir: string): void => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.abc')) {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results.sort();
  }
}
