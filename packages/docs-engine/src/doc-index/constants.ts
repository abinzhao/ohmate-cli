/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { CATALOG_NAMES, CATALOG_TITLES } from '../portal/catalog.js';

export const INDEX_VERSION = '1.9.1';
export const INDEX_DB_MAX_BYTES = 48 * 1024 * 1024;
export const DOC_CHUNK_MIN_LINES = 280;
export const DOC_CHUNK_MIN_H4_SECTIONS = 6;
export const DOC_CHUNK_MIN_LINES_RELAXED = 100;
export const DOC_CHUNK_MIN_H4_SECTIONS_RELAXED = 3;
export const DOC_MAX_INDEX_SECTIONS_PER_DOC = 28;
export const DOC_API_SECTION_BATCH_SIZE = 10;
export const DOC_CHUNK_API_PATH_RE = /API参考|APIReference/i;
export const QUERY_MAX_RAW_CHARS = 200;
export const QUERY_MAX_FTS_TOKENS = 12;
export const QUERY_AND_MAX_TOKENS = 4;
export const SYNONYM_EXPAND_MAX_PARTS = 8;
export const CATALOG_RERANK_POOL_FACTOR = 6;
export const DOC_BODY_HEAD_CHARS = 700;
export const DOC_BODY_TAIL_CHARS = 250;
export const DOC_HEADINGS_MAX_CHARS = 400;
export const DOC_SEARCH_TEXT_MAX_CHARS = 1320;
export const DOC_SEARCH_BUDGET_TITLE = 120;
export const DOC_SEARCH_BUDGET_API_SYMBOLS = 450;
export const DOC_SEARCH_BUDGET_HEADINGS = 250;
export const DOC_SEARCH_BUDGET_BODY = 500;
export const DOC_SECTION_SEARCH_TEXT_MAX_CHARS = 480;
export const DOC_SECTION_BUDGET_TITLE = 80;
export const DOC_SECTION_BUDGET_API_SYMBOLS = 200;
export const DOC_SECTION_BUDGET_HEADINGS = 60;
export const DOC_SECTION_BUDGET_BODY = 200;
export const DOC_API_SYMBOLS_MAX_COUNT = 40;
export const DOC_LEAD_TEXT_CHARS = 200;
export const DOC_SNIPPET_MAX_CHARS = 200;
export const DOC_SNIPPET_CONTEXT_CHARS = 40;
export const INSERT_BATCH_SIZE = 500;

export const CATALOG_TITLE_TO_ID: Record<string, number> = Object.fromEntries(
  CATALOG_NAMES.map((name, index) => [CATALOG_TITLES[name], index])
);

export const CATALOG_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  CATALOG_NAMES.map((name, index) => [name, index])
);
