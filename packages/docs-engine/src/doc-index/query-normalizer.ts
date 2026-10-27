/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import {
  QUERY_AND_MAX_TOKENS,
  QUERY_MAX_FTS_TOKENS,
  QUERY_MAX_RAW_CHARS,
  SYNONYM_EXPAND_MAX_PARTS,
} from './constants.js';
import {
  buildFtsOrMatch,
  buildSingleApiQueryTokens,
  buildSplitApiAndMatch,
  extractPriorityApiTokens,
  isSingleApiLikeQuery,
  parseSplitApiPhraseQuery,
  shouldSkipSynonymExpansion,
} from './api-identifiers.js';
import {
  extractNamedConceptTokens,
  getStageModelPreparedOverride,
} from './query-named-rules.js';
import { expandSynonymsLimited } from './query-rewriter.js';
import { tokenizeForQuery } from './tokenizer.js';

export interface PreparedQuery {
  rawQuery: string;
  expandedQuery: string;
  tokens: string[];
  preferAnd: boolean;
  /** When set, used directly as FTS MATCH (split-API AND, etc.). */
  ftsMatch?: string;
}

export function normalizeSearchInput(keywords: string[]): string {
  return keywords
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUERY_MAX_RAW_CHARS);
}

function capTokens(priority: string[], general: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const token of [...priority, ...general]) {
    const key = token.toLowerCase();
    if (!token || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(token);
    if (out.length >= QUERY_MAX_FTS_TOKENS) {
      break;
    }
  }

  return out;
}

/** 分词后 2–4 个 token 时先 AND 检索，不足 limit 再 OR 补全（见 sqlite-index searchWithAndFallback）。 */
function shouldPreferAndMatch(tokens: string[]): boolean {
  return tokens.length >= 2 && tokens.length <= QUERY_AND_MAX_TOKENS;
}

function buildSplitApiPrepared(
  rawQuery: string,
  split: ReturnType<typeof parseSplitApiPhraseQuery>
): PreparedQuery {
  const expandedQuery = expandSynonymsLimited(
    rawQuery,
    SYNONYM_EXPAND_MAX_PARTS
  );
  const synonymParts = expandedQuery.split(/\s+/).filter(Boolean);
  const left = [
    split!.first,
    ...synonymParts.filter((part) => part !== split!.second),
    split!.lower,
    split!.camelCase,
  ];
  const right = [split!.second, split!.lower, split!.camelCase];
  const tokens = capTokens(left, right);

  return {
    rawQuery,
    expandedQuery,
    tokens,
    preferAnd: false,
    ftsMatch: buildSplitApiAndMatch(left, right),
  };
}

function buildSingleApiPrepared(
  rawQuery: string,
  trimmed: string
): PreparedQuery {
  const tokens = capTokens(buildSingleApiQueryTokens(trimmed), []);
  return {
    rawQuery,
    expandedQuery: rawQuery,
    tokens,
    preferAnd: false,
    ftsMatch: buildFtsOrMatch(tokens),
  };
}

export async function prepareSearchQuery(
  keywords: string[]
): Promise<PreparedQuery> {
  const rawQuery = normalizeSearchInput(keywords);
  const trimmed = rawQuery.trim();
  const stageOverride = getStageModelPreparedOverride(trimmed);
  if (stageOverride) {
    return {
      rawQuery,
      expandedQuery: stageOverride.expandedQuery,
      tokens: stageOverride.tokens,
      preferAnd: false,
    };
  }

  const splitApi = parseSplitApiPhraseQuery(trimmed);
  if (splitApi) {
    return buildSplitApiPrepared(rawQuery, splitApi);
  }

  if (isSingleApiLikeQuery(trimmed)) {
    return buildSingleApiPrepared(rawQuery, trimmed);
  }

  const conceptPriority = extractNamedConceptTokens(rawQuery);
  const priorityTokens = [
    ...extractPriorityApiTokens(rawQuery),
    ...conceptPriority,
  ];
  const skipSynonyms = shouldSkipSynonymExpansion(trimmed);
  const expandedQuery = skipSynonyms
    ? rawQuery
    : expandSynonymsLimited(rawQuery, SYNONYM_EXPAND_MAX_PARTS);
  const generalTokens = await tokenizeForQuery(expandedQuery);
  const tokens = capTokens(priorityTokens, generalTokens);

  return {
    rawQuery,
    expandedQuery,
    tokens,
    preferAnd: conceptPriority.length === 0 && shouldPreferAndMatch(tokens),
  };
}
