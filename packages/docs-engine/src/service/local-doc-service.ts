/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../portal/catalog.js';
import { awaitDocReady, DocInitializer } from '../init/doc-initializer.js';
import { readMarkdownFromDocsZip } from '../doc-index/docs-zip-reader.js';
import {
  resetSearchDbCache,
  searchSqliteIndex,
} from '../doc-index/sqlite-index.js';

export interface LocalSearchResult {
  title: string;
  documentId: string;
  snippet: string;
  sectionTitle?: string;
}

function isCorruptSearchIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is not a database|database disk image is malformed|SQLITE_CORRUPT/i.test(
    message
  );
}

export class LocalDocService {
  async search(
    keywords: string[],
    catalog?: CatalogName,
    limit = 10
  ): Promise<LocalSearchResult[]> {
    await awaitDocReady();
    try {
      return await searchSqliteIndex(keywords, catalog, limit);
    } catch (error) {
      if (!isCorruptSearchIndexError(error)) {
        throw error;
      }
      resetSearchDbCache();
      await DocInitializer.run({
        builtBy: 'doc-init',
        force: true,
        quiet: true,
        assumeStorageSafe: true,
      });
      return searchSqliteIndex(keywords, catalog, limit);
    }
  }

  async readDocument(relativePath: string): Promise<string> {
    return readMarkdownFromDocsZip(relativePath);
  }
}

export const localDocService = new LocalDocService();
