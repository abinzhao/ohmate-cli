/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../portal/catalog.js';
import type { LocalSearchResult } from '../service/local-doc-service.js';
import { getSearchDbFile } from './doc-paths.js';
import { prepareSearchQuery, type PreparedQuery } from './query-normalizer.js';
import {
  inferSearchCatalog,
  orderLocalResultsWithTailCatalogsLast,
} from './catalog-routing.js';
import { buildFtsMatch } from './api-identifiers.js';
import { shouldMergeReferencesWithGlobalFallback } from './query-named-rules.js';
import type { DocumentIndexSource } from './segment-types.js';
import { getSqliteBackend, resetSqliteBackendCache } from './sqlite-backend-cache.js';

async function runSearch(
  keywords: string[],
  catalog: CatalogName | undefined,
  limit: number,
  match: string,
  query: string,
  rawQuery: string,
  dbPath?: string
): Promise<LocalSearchResult[]> {
  const backend = await getSqliteBackend();
  const resolvedDbPath = dbPath ?? getSearchDbFile();
  return backend.searchIndex(
    keywords,
    catalog,
    limit,
    resolvedDbPath,
    match,
    query,
    rawQuery
  );
}

export function resetSearchDbCache(): void {
  resetSqliteBackendCache();
}

export async function buildSqliteSearchIndex(
  dbPath: string,
  sources: DocumentIndexSource[],
  onProgress?: (current: number, total: number) => Promise<void> | void
): Promise<void> {
  const backend = await getSqliteBackend();
  await backend.buildSearchIndex(dbPath, sources, onProgress);
}

function mergeSearchResults(
  primary: LocalSearchResult[],
  secondary: LocalSearchResult[],
  limit: number
): LocalSearchResult[] {
  const seen = new Set<string>();
  const merged: LocalSearchResult[] = [];

  for (const result of [...primary, ...secondary]) {
    if (seen.has(result.documentId)) {
      continue;
    }
    seen.add(result.documentId);
    merged.push(result);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function runPreparedMatch(
  keywords: string[],
  catalog: CatalogName | undefined,
  limit: number,
  prepared: PreparedQuery,
  match: string,
  dbPath?: string
): Promise<LocalSearchResult[]> {
  return runSearch(
    keywords,
    catalog,
    limit,
    match,
    prepared.expandedQuery,
    prepared.rawQuery,
    dbPath
  );
}

async function searchWithAndFallback(
  keywords: string[],
  catalog: CatalogName | undefined,
  limit: number,
  prepared: PreparedQuery,
  dbPath?: string
): Promise<LocalSearchResult[]> {
  const andResults = await runPreparedMatch(
    keywords,
    catalog,
    limit,
    prepared,
    buildFtsMatch(prepared.tokens, 'AND'),
    dbPath
  );
  if (andResults.length >= limit) {
    return andResults;
  }
  const orResults = await runPreparedMatch(
    keywords,
    catalog,
    limit,
    prepared,
    buildFtsMatch(prepared.tokens, 'OR'),
    dbPath
  );
  return mergeSearchResults(andResults, orResults, limit);
}

async function searchWithPrepared(
  keywords: string[],
  catalog: CatalogName | undefined,
  limit: number,
  prepared: PreparedQuery,
  dbPath?: string
): Promise<LocalSearchResult[]> {
  if (prepared.ftsMatch) {
    return runPreparedMatch(
      keywords,
      catalog,
      limit,
      prepared,
      prepared.ftsMatch,
      dbPath
    );
  }
  if (!prepared.preferAnd) {
    return runPreparedMatch(
      keywords,
      catalog,
      limit,
      prepared,
      buildFtsMatch(prepared.tokens, 'OR'),
      dbPath
    );
  }
  return searchWithAndFallback(keywords, catalog, limit, prepared, dbPath);
}

async function searchWithReferencesGlobalFallback(
  keywords: string[],
  limit: number,
  prepared: PreparedQuery,
  dbPath?: string
): Promise<LocalSearchResult[]> {
  const primary = await searchWithPrepared(
    keywords,
    'harmonyos-references',
    limit,
    prepared,
    dbPath
  );
  if (primary.length >= limit) {
    return primary;
  }
  const secondary = await searchWithPrepared(
    keywords,
    undefined,
    limit,
    prepared,
    dbPath
  );
  return mergeSearchResults(primary, secondary, limit);
}

function applyTailCatalogOrderWhenGlobal(
  results: LocalSearchResult[],
  userCatalog?: CatalogName
): LocalSearchResult[] {
  if (userCatalog !== undefined) {
    return results;
  }
  return orderLocalResultsWithTailCatalogsLast(results);
}

export async function searchSqliteIndex(
  keywords: string[],
  catalog?: CatalogName,
  limit = 10,
  dbPath?: string
): Promise<LocalSearchResult[]> {
  const prepared = await prepareSearchQuery(keywords);
  if (shouldMergeReferencesWithGlobalFallback(prepared.rawQuery, catalog)) {
    const merged = await searchWithReferencesGlobalFallback(
      keywords,
      limit,
      prepared,
      dbPath
    );
    return applyTailCatalogOrderWhenGlobal(merged, catalog);
  }
  const effectiveCatalog = catalog ?? inferSearchCatalog(prepared.rawQuery);
  const results = await searchWithPrepared(
    keywords,
    effectiveCatalog,
    limit,
    prepared,
    dbPath
  );
  return applyTailCatalogOrderWhenGlobal(results, catalog);
}
