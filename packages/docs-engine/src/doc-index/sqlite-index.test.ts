/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogName } from '../portal/catalog.js';
import { CATALOG_NAMES, CATALOG_TITLES } from '../portal/catalog.js';
import type { LocalSearchResult } from '../service/local-doc-service.js';
import type { DocumentIndexSource } from './segment-types.js';
import type { PreparedQuery } from './query-normalizer.js';
import {
  buildSqliteSearchIndex,
  resetSearchDbCache,
  searchSqliteIndex,
} from './sqlite-index.js';

function catalogNameOfTitle(title: string): CatalogName {
  const matched = CATALOG_NAMES.find((name) => CATALOG_TITLES[name] === title);
  if (!matched) {
    throw new Error(`Unknown catalog title: ${title}`);
  }
  return matched;
}

const GUIDES_CATALOG = catalogNameOfTitle('开发指南');
const REFERENCES_CATALOG = catalogNameOfTitle('API参考');
const RELEASES_CATALOG = catalogNameOfTitle('版本说明');
const ROADMAP_CATALOG = catalogNameOfTitle('变更预告');

const mocks = vi.hoisted(() => ({
  prepareSearchQuery: vi.fn(),
  shouldMergeReferencesWithGlobalFallback: vi.fn(),
  inferSearchCatalog: vi.fn(),
  buildFtsMatch: vi.fn(),
  getSearchDbFile: vi.fn(),
  getSqliteBackend: vi.fn(),
  resetSqliteBackendCache: vi.fn(),
  buildSearchIndex: vi.fn(),
  searchIndex: vi.fn(),
}));

vi.mock('./query-normalizer.js', () => ({
  prepareSearchQuery: mocks.prepareSearchQuery,
}));

vi.mock('./query-named-rules.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./query-named-rules.js')>()),
  shouldMergeReferencesWithGlobalFallback:
    mocks.shouldMergeReferencesWithGlobalFallback,
}));

vi.mock('./catalog-routing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./catalog-routing.js')>()),
  inferSearchCatalog: mocks.inferSearchCatalog,
}));

vi.mock('./api-identifiers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-identifiers.js')>()),
  buildFtsMatch: mocks.buildFtsMatch,
}));

vi.mock('./doc-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./doc-paths.js')>()),
  getSearchDbFile: mocks.getSearchDbFile,
}));

vi.mock('./sqlite-backend-cache.js', () => ({
  getSqliteBackend: mocks.getSqliteBackend,
  resetSqliteBackendCache: mocks.resetSqliteBackendCache,
}));

function basePrepared(overrides: Partial<PreparedQuery> = {}): PreparedQuery {
  return {
    rawQuery: 'raw-query',
    expandedQuery: 'expanded-query',
    tokens: ['tokenA', 'tokenB'],
    preferAnd: false,
    ...overrides,
  };
}

function result(documentId: string): LocalSearchResult {
  return { title: documentId, documentId, snippet: `snippet-${documentId}` };
}

function documentIds(results: LocalSearchResult[]): string[] {
  return results.map((item) => item.documentId);
}

function searchByCatalog(byCatalog: Record<string, LocalSearchResult[]>): void {
  mocks.searchIndex.mockImplementation(
    async (
      keywords: string[],
      catalog: CatalogName | undefined
    ): Promise<LocalSearchResult[]> => {
      const key = catalog ?? '*';
      return byCatalog[key] ?? [];
    }
  );
}

describe('searchSqliteIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareSearchQuery.mockResolvedValue(basePrepared());
    mocks.shouldMergeReferencesWithGlobalFallback.mockReturnValue(false);
    mocks.inferSearchCatalog.mockReturnValue(undefined);
    mocks.buildFtsMatch.mockImplementation(
      (tokens: string[], mode: string) => `match-${mode}`
    );
    mocks.getSearchDbFile.mockReturnValue('/default/search.db');
    mocks.getSqliteBackend.mockResolvedValue({
      resetCache: vi.fn(),
      buildSearchIndex: mocks.buildSearchIndex,
      searchIndex: mocks.searchIndex,
    });
    mocks.searchIndex.mockResolvedValue([]);
  });

  it('uses the prepared ftsMatch directly without AND/OR fallback', async () => {
    mocks.prepareSearchQuery.mockResolvedValue(
      basePrepared({ ftsMatch: 'custom-match' })
    );
    mocks.searchIndex.mockResolvedValue([result('doc-1')]);

    const results = await searchSqliteIndex(['module']);

    expect(documentIds(results)).toEqual(['doc-1']);
    expect(mocks.searchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchIndex).toHaveBeenCalledWith(
      ['module'],
      undefined,
      10,
      '/default/search.db',
      'custom-match',
      'expanded-query',
      'raw-query'
    );
  });

  it('searches with an OR match when preferAnd is false', async () => {
    await searchSqliteIndex(['module']);

    expect(mocks.searchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchIndex.mock.calls[0][4]).toBe('match-OR');
    expect(mocks.buildFtsMatch).toHaveBeenCalledWith(
      ['tokenA', 'tokenB'],
      'OR'
    );
  });

  it('keeps the AND results without an OR fallback when they fill the limit', async () => {
    mocks.prepareSearchQuery.mockResolvedValue(
      basePrepared({ preferAnd: true })
    );
    mocks.searchIndex.mockResolvedValue([
      result('a'),
      result('b'),
      result('c'),
    ]);

    const results = await searchSqliteIndex(['module'], undefined, 3);

    expect(documentIds(results)).toEqual(['a', 'b', 'c']);
    expect(mocks.searchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchIndex.mock.calls[0][4]).toBe('match-AND');
  });

  it('falls back to OR and merges when AND returns fewer than the limit', async () => {
    mocks.prepareSearchQuery.mockResolvedValue(
      basePrepared({ preferAnd: true })
    );
    mocks.searchIndex.mockImplementation(
      async (
        keywords: string[],
        catalog: CatalogName | undefined,
        limit: number,
        dbPath: string,
        match: string
      ): Promise<LocalSearchResult[]> =>
        match === 'match-AND'
          ? [result('a'), result('b')]
          : [result('b'), result('c')]
    );

    const results = await searchSqliteIndex(['module'], undefined, 3);

    expect(documentIds(results)).toEqual(['a', 'b', 'c']);
    expect(mocks.searchIndex).toHaveBeenCalledTimes(2);
    expect(mocks.searchIndex.mock.calls[0][4]).toBe('match-AND');
    expect(mocks.searchIndex.mock.calls[1][4]).toBe('match-OR');
  });

  it('caps the merged AND/OR results at the limit', async () => {
    mocks.prepareSearchQuery.mockResolvedValue(
      basePrepared({ preferAnd: true })
    );
    mocks.searchIndex.mockImplementation(
      async (
        keywords: string[],
        catalog: CatalogName | undefined,
        limit: number,
        dbPath: string,
        match: string
      ): Promise<LocalSearchResult[]> =>
        match === 'match-AND'
          ? [result('a')]
          : [result('b'), result('c'), result('d')]
    );

    const results = await searchSqliteIndex(['module'], undefined, 2);

    expect(documentIds(results)).toEqual(['a', 'b']);
  });

  it('merges references-first results with a global fallback', async () => {
    mocks.shouldMergeReferencesWithGlobalFallback.mockReturnValue(true);
    searchByCatalog({
      [REFERENCES_CATALOG]: [result('ref-1')],
      '*': [result('global-1'), result('ref-1')],
    });

    const results = await searchSqliteIndex(['module'], undefined, 10);

    expect(documentIds(results)).toEqual(['ref-1', 'global-1']);
    expect(mocks.searchIndex).toHaveBeenCalledTimes(2);
    expect(mocks.searchIndex.mock.calls[0][1]).toBe(REFERENCES_CATALOG);
    expect(mocks.searchIndex.mock.calls[1][1]).toBeUndefined();
  });

  it('skips the global fallback when references results fill the limit', async () => {
    mocks.shouldMergeReferencesWithGlobalFallback.mockReturnValue(true);
    mocks.searchIndex.mockResolvedValue([result('ref-1'), result('ref-2')]);

    const results = await searchSqliteIndex(['module'], undefined, 2);

    expect(documentIds(results)).toEqual(['ref-1', 'ref-2']);
    expect(mocks.searchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchIndex.mock.calls[0][1]).toBe(REFERENCES_CATALOG);
  });

  it('moves tail-catalog documents to the end when no user catalog is given', async () => {
    const tailDocumentId = `${CATALOG_TITLES[RELEASES_CATALOG]}/release-notes`;
    mocks.searchIndex.mockResolvedValue([
      result(tailDocumentId),
      result('zh-cn/application-dev/guide'),
    ]);

    const results = await searchSqliteIndex(['版本说明']);

    expect(documentIds(results)).toEqual([
      'zh-cn/application-dev/guide',
      tailDocumentId,
    ]);
  });

  it('keeps the result order when an explicit catalog is provided', async () => {
    const tailDocumentId = `${CATALOG_TITLES[ROADMAP_CATALOG]}/roadmap`;
    const ordered = [result(tailDocumentId), result('guide')];
    mocks.searchIndex.mockResolvedValue(ordered);

    const results = await searchSqliteIndex(['路由'], GUIDES_CATALOG, 10);

    expect(documentIds(results)).toEqual([tailDocumentId, 'guide']);
    expect(mocks.searchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchIndex.mock.calls[0][1]).toBe(GUIDES_CATALOG);
  });

  it('infers the effective catalog from the raw query when no catalog is given', async () => {
    mocks.inferSearchCatalog.mockReturnValue(GUIDES_CATALOG);

    await searchSqliteIndex(['Stage模型']);

    expect(mocks.inferSearchCatalog).toHaveBeenCalledWith('raw-query');
    expect(mocks.searchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchIndex.mock.calls[0][1]).toBe(GUIDES_CATALOG);
  });

  it('passes an explicit dbPath through instead of the default', async () => {
    await searchSqliteIndex(['module'], undefined, 5, '/custom/search.db');

    expect(mocks.getSearchDbFile).not.toHaveBeenCalled();
    expect(mocks.searchIndex).toHaveBeenCalledWith(
      ['module'],
      undefined,
      5,
      '/custom/search.db',
      'match-OR',
      'expanded-query',
      'raw-query'
    );
  });

  it('forwards the raw query and catalog to the references-merge gate', async () => {
    await searchSqliteIndex(['module'], REFERENCES_CATALOG, 10);

    expect(mocks.shouldMergeReferencesWithGlobalFallback).toHaveBeenCalledWith(
      'raw-query',
      REFERENCES_CATALOG
    );
  });
});

describe('buildSqliteSearchIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSqliteBackend.mockResolvedValue({
      resetCache: vi.fn(),
      buildSearchIndex: mocks.buildSearchIndex,
      searchIndex: mocks.searchIndex,
    });
  });

  it('delegates to the backend buildSearchIndex with all arguments', async () => {
    const sources: DocumentIndexSource[] = [
      {
        documentId: 'doc-1',
        catalogId: 1,
        docTitle: 'Guide',
        sectionTitle: '',
        titleTokens: 'guide',
        headingsText: 'Guide',
        apiSymbols: [],
        bodySample: 'body',
        leadText: 'lead',
        excerptTruncated: false,
      },
    ];
    const onProgress = vi.fn();

    await buildSqliteSearchIndex('/target/search.db', sources, onProgress);

    expect(mocks.buildSearchIndex).toHaveBeenCalledWith(
      '/target/search.db',
      sources,
      onProgress
    );
  });
});

describe('resetSearchDbCache', () => {
  it('resets the sqlite backend cache', () => {
    resetSearchDbCache();

    expect(mocks.resetSqliteBackendCache).toHaveBeenCalledTimes(1);
  });
});
