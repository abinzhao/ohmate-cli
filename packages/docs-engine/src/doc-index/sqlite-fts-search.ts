/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../portal/catalog.js';
import type { LocalSearchResult } from '../service/local-doc-service.js';
import { CATALOG_NAME_TO_ID, CATALOG_RERANK_POOL_FACTOR } from './constants.js';
import {
  extractQueryApiSymbolTokens,
  getManagerSplitApiCompound,
  rowMatchesManagerApiModule,
} from './api-identifiers.js';
import {
  inferCatalogBoosts,
  orderRowsWithTailCatalogsLast,
} from './catalog-routing.js';
import { extractSearchSnippet } from './sqlite-snippet.js';

export interface FtsSearchRow {
  document_id: string;
  doc_title: string;
  section_title: string;
  lead_text: string;
  excerpt_truncated: number;
  catalog_id: number;
  bm25: number;
}

export interface FtsDbReader {
  all<T>(sql: string, ...params: (string | number)[]): T[];
}

export const FTS_SEARCH_SQL = `
  SELECT d.document_id, d.doc_title, s.section_title, s.lead_text, s.excerpt_truncated,
         d.catalog_id, bm25(segments_fts) AS bm25
  FROM segments_fts
  JOIN segments s ON s.id = segments_fts.rowid
  JOIN documents d ON d.id = s.doc_id
  WHERE segments_fts MATCH ?
  ORDER BY bm25(segments_fts)
  LIMIT ?
`;

export const FTS_SEARCH_CATALOG_SQL = `
  SELECT d.document_id, d.doc_title, s.section_title, s.lead_text, s.excerpt_truncated,
         d.catalog_id, bm25(segments_fts) AS bm25
  FROM segments_fts
  JOIN segments s ON s.id = segments_fts.rowid
  JOIN documents d ON d.id = s.doc_id
  WHERE segments_fts MATCH ? AND d.catalog_id = ?
  ORDER BY bm25(segments_fts)
  LIMIT ?
`;

const MANAGER_API_RERANK_BOOST = 3.5;
const MANAGER_API_REFERENCE_EXTRA = 1.4;
const TITLE_EXACT_MATCH_BOOST = 4;
const TITLE_PREFIX_MATCH_BOOST = 1.8;
const TITLE_TERMS_MATCH_BOOST = 1.35;
const BROAD_SINGLE_TERM_EXACT_TITLE_BOOST = 3.5;
const BROAD_SINGLE_TERM_PREFIX_TITLE_BOOST = 1.8;
const MIN_RERANK_FETCH_LIMIT = 120;
const TITLE_PREFIX_MIN_CHARS = 6;

function normalizeForRerank(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}@.]+/gu, '');
}

function splitRerankTerms(rawQuery: string): string[] {
  return rawQuery
    .split(/[^\p{L}\p{N}@.]+/u)
    .map(normalizeForRerank)
    .filter((term) => term.length >= 2);
}

function containsAllTerms(field: string, terms: string[]): boolean {
  return terms.length > 1 && terms.every((term) => field.includes(term));
}

function isBroadSingleAsciiTerm(rawQuery: string): boolean {
  return /^[a-z0-9]{1,4}$/.test(rawQuery.trim().toLowerCase());
}

function broadSingleTermTitleBoost(title: string, term: string): number {
  if (title === term) {
    return BROAD_SINGLE_TERM_EXACT_TITLE_BOOST;
  }
  if (title.startsWith(term) || title.includes(`@ohos.${term}`)) {
    return BROAD_SINGLE_TERM_PREFIX_TITLE_BOOST;
  }
  return 1;
}

function titleMatchBoost(row: FtsSearchRow, rawQuery: string): number {
  const normalizedQuery = normalizeForRerank(rawQuery);
  if (normalizedQuery.length < 2) {
    return 1;
  }

  const title = normalizeForRerank(row.doc_title);
  if (isBroadSingleAsciiTerm(rawQuery)) {
    return broadSingleTermTitleBoost(title, normalizedQuery);
  }

  if (title.includes(normalizedQuery)) {
    return TITLE_EXACT_MATCH_BOOST;
  }
  if (
    normalizedQuery.length >= TITLE_PREFIX_MIN_CHARS &&
    title.includes(normalizedQuery.slice(0, TITLE_PREFIX_MIN_CHARS))
  ) {
    return TITLE_PREFIX_MATCH_BOOST;
  }

  const terms = splitRerankTerms(rawQuery);
  if (containsAllTerms(title, terms)) {
    return TITLE_TERMS_MATCH_BOOST;
  }
  return 1;
}

function applyTitleBoost(score: number, boost: number): number {
  if (boost <= 1) {
    return score;
  }
  return score < 0 ? score * boost : score / boost;
}

function effectiveBm25Score(
  row: FtsSearchRow,
  boosts: Map<number, number>,
  titleQuery: string,
  managerCompound?: string
): number {
  let score = row.bm25 / (boosts.get(row.catalog_id) ?? 1);
  score = applyTitleBoost(score, titleMatchBoost(row, titleQuery));
  if (
    managerCompound &&
    rowMatchesManagerApiModule(
      row.doc_title,
      row.section_title,
      managerCompound
    )
  ) {
    score /= MANAGER_API_RERANK_BOOST;
    if (row.catalog_id === CATALOG_NAME_TO_ID['harmonyos-references']) {
      score /= MANAGER_API_REFERENCE_EXTRA;
    }
  }
  return score;
}

function minScoreRow(
  rows: FtsSearchRow[],
  boosts: Map<number, number>,
  titleQuery: string,
  managerCompound?: string
): FtsSearchRow {
  return rows.reduce((best, row) =>
    effectiveBm25Score(row, boosts, titleQuery, managerCompound) <
    effectiveBm25Score(best, boosts, titleQuery, managerCompound)
      ? row
      : best
  );
}

function segmentMatchesApiSymbols(
  row: FtsSearchRow,
  apiSymbols: string[]
): boolean {
  return apiSymbols.some(
    (symbol) =>
      row.section_title.includes(symbol) || row.doc_title.includes(symbol)
  );
}

function pickBestSegmentForDocument(
  segments: FtsSearchRow[],
  apiSymbols: string[],
  boosts: Map<number, number>,
  titleQuery: string,
  managerCompound?: string
): FtsSearchRow {
  if (managerCompound) {
    const managerMatches = segments.filter((row) =>
      rowMatchesManagerApiModule(
        row.doc_title,
        row.section_title,
        managerCompound
      )
    );
    if (managerMatches.length > 0) {
      return minScoreRow(managerMatches, boosts, titleQuery, managerCompound);
    }
  }
  if (apiSymbols.length > 0) {
    const titleMatches = segments.filter((row) =>
      segmentMatchesApiSymbols(row, apiSymbols)
    );
    if (titleMatches.length > 0) {
      return minScoreRow(titleMatches, boosts, titleQuery, managerCompound);
    }
  }
  return minScoreRow(segments, boosts, titleQuery, managerCompound);
}

function finalizeSearchRows(
  rows: FtsSearchRow[],
  rawQuery: string,
  titleQuery: string,
  limit: number,
  deprioritizeTailCatalogs: boolean
): FtsSearchRow[] {
  const boosts = inferCatalogBoosts(rawQuery);
  const apiSymbols = extractQueryApiSymbolTokens(rawQuery);
  const managerSplit = getManagerSplitApiCompound(rawQuery);
  const managerCompound = managerSplit?.camelCase;
  const byDocument = new Map<string, FtsSearchRow[]>();

  for (const row of rows) {
    const segments = byDocument.get(row.document_id) ?? [];
    segments.push(row);
    byDocument.set(row.document_id, segments);
  }

  const representatives: FtsSearchRow[] = [];
  for (const segments of byDocument.values()) {
    representatives.push(
      pickBestSegmentForDocument(
        segments,
        apiSymbols,
        boosts,
        titleQuery,
        managerCompound
      )
    );
  }

  const sorted = representatives.sort(
    (left, right) =>
      effectiveBm25Score(left, boosts, titleQuery, managerCompound) -
      effectiveBm25Score(right, boosts, titleQuery, managerCompound)
  );
  const ordered = deprioritizeTailCatalogs
    ? orderRowsWithTailCatalogsLast(sorted)
    : sorted;
  return ordered.slice(0, limit);
}

export function runFtsSearch(
  reader: FtsDbReader,
  catalog: CatalogName | undefined,
  limit: number,
  match: string,
  query: string,
  rawQuery: string
): LocalSearchResult[] {
  const catalogId = catalog ? CATALOG_NAME_TO_ID[catalog] : undefined;
  const fetchLimit = Math.max(
    limit,
    limit * CATALOG_RERANK_POOL_FACTOR,
    MIN_RERANK_FETCH_LIMIT
  );

  const rows =
    catalogId === undefined
      ? reader.all<FtsSearchRow>(FTS_SEARCH_SQL, match, fetchLimit)
      : reader.all<FtsSearchRow>(
          FTS_SEARCH_CATALOG_SQL,
          match,
          catalogId,
          fetchLimit
        );

  const ranked =
    catalogId === undefined
      ? finalizeSearchRows(rows, rawQuery, query, limit, true)
      : finalizeSearchRows(rows, rawQuery, query, limit, false);

  return ranked.map((row) => ({
    title: row.doc_title,
    documentId: row.document_id,
    sectionTitle: row.section_title || undefined,
    snippet: extractSearchSnippet(row.lead_text, query, {
      excerptTruncated: Boolean(row.excerpt_truncated),
    }),
  }));
}
