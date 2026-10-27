/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  FTS_SEARCH_CATALOG_SQL,
  FTS_SEARCH_SQL,
  runFtsSearch,
  type FtsDbReader,
  type FtsSearchRow,
} from './sqlite-fts-search.js';
import { CATALOG_NAME_TO_ID } from './constants.js';
import { CATALOG_NAMES } from '../portal/catalog.js';

// Same order as CATALOG_NAMES: guides, references, best-practices, faqs, releases, roadmap.
const [, GUIDES, , , RELEASES] = CATALOG_NAMES;

// runFtsSearch 通过 FtsDbReader 接口注入数据源，以下为内存假实现
// （接口注入的测试替身，非 vi.mock 模块替换）。

const makeRow = (overrides: Partial<FtsSearchRow> = {}): FtsSearchRow => ({
  document_id: 'doc-1',
  doc_title: 'Title One',
  section_title: '',
  lead_text: 'lead text content',
  excerpt_truncated: 0,
  catalog_id: 0,
  bm25: -1,
  ...overrides,
});

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeReader(
  rows: FtsSearchRow[]
): FtsDbReader & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    all<T>(sql: string, ...params: unknown[]): T[] {
      calls.push({ sql, params });
      return rows as unknown as T[];
    },
  };
}

describe('FTS SQL constants', () => {
  it('global search matches on the fts table ordered by bm25', () => {
    expect(FTS_SEARCH_SQL).toContain('MATCH ?');
    expect(FTS_SEARCH_SQL).toContain('ORDER BY bm25');
    expect(FTS_SEARCH_SQL).not.toContain('catalog_id = ?');
  });

  it('catalog search additionally filters by catalog id', () => {
    expect(FTS_SEARCH_CATALOG_SQL).toContain('MATCH ?');
    expect(FTS_SEARCH_CATALOG_SQL).toContain('catalog_id = ?');
  });
});

describe('runFtsSearch', () => {
  it('uses the global SQL without a catalog filter', () => {
    const reader = makeReader([]);
    runFtsSearch(reader, undefined, 10, '"a" OR "b"', 'a b', 'a b');
    expect(reader.calls[0].sql).toBe(FTS_SEARCH_SQL);
    expect(reader.calls[0].params[0]).toBe('"a" OR "b"');
    expect(reader.calls[0].params[1]).toBe(120);
  });

  it('uses the catalog SQL with the catalog id bound', () => {
    const reader = makeReader([]);
    runFtsSearch(reader, 'best-practices', 10, '"a" OR "b"', 'a b', 'a b');
    expect(reader.calls[0].sql).toBe(FTS_SEARCH_CATALOG_SQL);
    expect(reader.calls[0].params[0]).toBe('"a" OR "b"');
    expect(reader.calls[0].params[1]).toBe(
      CATALOG_NAME_TO_ID['best-practices']
    );
    expect(reader.calls[0].params[2]).toBe(120);
  });

  it('widens the fetch limit by the rerank pool factor', () => {
    const reader = makeReader([]);
    runFtsSearch(reader, undefined, 50, '"a"', 'a', 'a');
    expect(reader.calls[0].params[1]).toBe(300);
  });

  it('returns an empty array when no rows match', async () => {
    const results = runFtsSearch(
      makeReader([]),
      undefined,
      10,
      '"a"',
      'demo',
      'demo'
    );
    expect(results).toEqual([]);
  });

  it('maps rows to search results with snippet generation', () => {
    const reader = makeReader([
      makeRow({ section_title: '小节标题', excerpt_truncated: 1 }),
    ]);
    const results = runFtsSearch(
      reader,
      undefined,
      10,
      '"demo"',
      'demo',
      'demo'
    );
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Title One');
    expect(results[0].documentId).toBe('doc-1');
    expect(results[0].sectionTitle).toBe('小节标题');
    expect(results[0].snippet).toBe('lead text content...');
  });

  it('omits sectionTitle when the section title is blank', () => {
    const results = runFtsSearch(
      makeReader([makeRow()]),
      undefined,
      10,
      '"demo"',
      'demo',
      'demo'
    );
    expect(results[0].sectionTitle).toBeUndefined();
  });

  it('picks the best segment per document by effective score', () => {
    const reader = makeReader([
      makeRow({ document_id: 'doc-1', section_title: 'secB', bm25: -1 }),
      makeRow({ document_id: 'doc-1', section_title: 'secA', bm25: -5 }),
    ]);
    const results = runFtsSearch(
      reader,
      undefined,
      10,
      '"demo"',
      'demo',
      'demo'
    );
    expect(results).toHaveLength(1);
    expect(results[0].sectionTitle).toBe('secA');
  });

  it('boosts rows whose title contains the query', () => {
    const reader = makeReader([
      makeRow({ document_id: 'doc-b', doc_title: '无关标题', bm25: -0.4 }),
      makeRow({
        document_id: 'doc-a',
        doc_title: 'Navigation 指南',
        bm25: -0.2,
      }),
    ]);
    const results = runFtsSearch(
      reader,
      undefined,
      10,
      '"navigation"',
      'navigation',
      'navigation'
    );
    expect(results[0].documentId).toBe('doc-a');
  });

  it('keeps tail catalog rows last in global searches', () => {
    const reader = makeReader([
      makeRow({
        document_id: 'doc-release',
        doc_title: '版本内容',
        catalog_id: CATALOG_NAME_TO_ID[RELEASES],
        bm25: -10,
      }),
      makeRow({
        document_id: 'doc-guide',
        doc_title: '指南内容',
        catalog_id: CATALOG_NAME_TO_ID[GUIDES],
        bm25: -1,
      }),
    ]);
    const results = runFtsSearch(
      reader,
      undefined,
      10,
      '"查询"',
      '查询',
      '普通查询'
    );
    expect(results.map((r) => r.documentId)).toEqual([
      'doc-guide',
      'doc-release',
    ]);
  });

  it('does not push tail catalogs last when a catalog is specified', () => {
    const reader = makeReader([
      makeRow({
        document_id: 'doc-release',
        doc_title: '版本内容',
        catalog_id: CATALOG_NAME_TO_ID[RELEASES],
        bm25: -10,
      }),
      makeRow({
        document_id: 'doc-guide',
        doc_title: '指南内容',
        catalog_id: CATALOG_NAME_TO_ID[GUIDES],
        bm25: -1,
      }),
    ]);
    const results = runFtsSearch(
      reader,
      'best-practices',
      10,
      '"查询"',
      '查询',
      '普通查询'
    );
    expect(results.map((r) => r.documentId)).toEqual([
      'doc-release',
      'doc-guide',
    ]);
  });

  it('truncates the final result list to the requested limit', () => {
    const reader = makeReader([
      makeRow({ document_id: 'doc-1', bm25: -3 }),
      makeRow({ document_id: 'doc-2', bm25: -2 }),
      makeRow({ document_id: 'doc-3', bm25: -1 }),
    ]);
    const results = runFtsSearch(
      reader,
      undefined,
      2,
      '"demo"',
      'demo',
      'demo'
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.documentId)).toEqual(['doc-1', 'doc-2']);
  });
});
