/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../portal/catalog.js';
import type { LocalSearchResult } from '../service/local-doc-service.js';
import type { DocumentIndexSource } from './segment-types.js';

export interface SqliteBackend {
  resetCache(): void;
  buildSearchIndex(
    dbPath: string,
    sources: DocumentIndexSource[],
    onProgress?: (current: number, total: number) => Promise<void> | void
  ): Promise<void>;
  searchIndex(
    keywords: string[],
    catalog: CatalogName | undefined,
    limit: number,
    dbPath: string,
    match: string,
    query: string,
    rawQuery: string
  ): Promise<LocalSearchResult[]>;
}
