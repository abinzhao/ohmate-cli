/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import {
  API_COMPOUND_SUFFIXES,
  COMPOUND_FIRST_BLOCKLIST,
  COMPOUND_SECOND_BLOCKLIST,
  MANAGER_REFERENCE_MERGE_FIRST_WORDS,
} from './api-suffixes.js';

export const OHOS_MODULE_RE = /@ohos\.[a-z][a-zA-Z0-9.]+/gi;
export const CAMEL_CASE_API_RE = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+\b/g;
export const PASCAL_CASE_API_RE = /[A-Z][a-zA-Z0-9]{2,}/g;
export const DECORATOR_TOKEN_RE = /@[A-Z][a-zA-Z0-9]*/g;
export const QUALIFIED_SYMBOL_RE = /[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]+/g;

export const CAMEL_CASE_MIN_LEN = 6;
const IDENTIFIER_PART_RE = /^[a-z][a-z0-9]{2,}$/;
const SPLIT_API_QUERY_RE = /^([a-z][a-z0-9]{2,})\s+([a-z][a-z0-9]{2,})$/;
const OHOS_MODULE_QUERY_RE = /^@ohos\.[a-z][a-zA-Z0-9.]+$/i;
const SINGLE_CAMEL_CASE_QUERY_RE = /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+$/;
const SINGLE_PASCAL_CASE_QUERY_RE = /^[A-Z][a-zA-Z0-9]+$/;

export interface SplitApiPhrase {
  first: string;
  second: string;
  camelCase: string;
  lower: string;
}

export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export function buildFtsMatch(
  tokens: string[],
  operator: 'OR' | 'AND'
): string {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (unique.length === 0) {
    return '""';
  }
  return unique.map(escapeFtsToken).join(` ${operator} `);
}

export function buildFtsOrMatch(tokens: string[]): string {
  return buildFtsMatch(tokens, 'OR');
}

export function buildSplitApiAndMatch(left: string[], right: string[]): string {
  const l = [...new Set(left.filter(Boolean))];
  const r = [...new Set(right.filter(Boolean))];
  if (l.length === 0 || r.length === 0) {
    return buildFtsOrMatch([...l, ...r]);
  }
  return `(${buildFtsOrMatch(l)}) AND (${buildFtsOrMatch(r)})`;
}

export function isOhosModuleQuery(trimmed: string): boolean {
  return OHOS_MODULE_QUERY_RE.test(trimmed);
}

export function isSingleCamelCaseApiQuery(trimmed: string): boolean {
  return (
    SINGLE_CAMEL_CASE_QUERY_RE.test(trimmed) &&
    trimmed.length >= CAMEL_CASE_MIN_LEN
  );
}

export function isSinglePascalCaseApiQuery(trimmed: string): boolean {
  return SINGLE_PASCAL_CASE_QUERY_RE.test(trimmed);
}

export function isSingleApiLikeQuery(trimmed: string): boolean {
  return (
    isOhosModuleQuery(trimmed) ||
    isSingleCamelCaseApiQuery(trimmed) ||
    isSinglePascalCaseApiQuery(trimmed)
  );
}

export function isApiCompoundSuffix(word: string): boolean {
  const lower = word.trim().toLowerCase();
  if (COMPOUND_SECOND_BLOCKLIST.has(lower)) {
    return false;
  }
  return API_COMPOUND_SUFFIXES.has(lower);
}

export function buildCamelCaseCompound(first: string, second: string): string {
  const head = second.trim().charAt(0).toUpperCase();
  const tail = second.trim().slice(1).toLowerCase();
  return `${first.trim().toLowerCase()}${head}${tail}`;
}

export function ohosModuleLastSegment(modulePath: string): string | undefined {
  const body = modulePath.replace(/^@ohos\./i, '');
  const parts = body.split('.').filter(Boolean);
  const last = parts[parts.length - 1]?.trim();
  return last || undefined;
}

export function extractOhosModules(text: string): string[] {
  return [...text.matchAll(OHOS_MODULE_RE)].map((match) => match[0]);
}

export function extractCamelCaseIdentifiers(
  text: string,
  minLen = CAMEL_CASE_MIN_LEN
): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CAMEL_CASE_API_RE)) {
    if (match[0].length >= minLen) {
      out.push(match[0]);
    }
  }
  return out;
}

export function filterSubsumedTokens(tokens: string[]): string[] {
  return tokens.filter((token) => {
    const lower = token.toLowerCase();
    return !tokens.some((other) => {
      if (other === token) {
        return false;
      }
      const otherLower = other.toLowerCase();
      return (
        otherLower.length > lower.length &&
        otherLower.endsWith(lower) &&
        lower.length >= 4
      );
    });
  });
}

export function appendSymbolVariants(
  target: Set<string>,
  symbol: string
): void {
  const trimmed = symbol.trim();
  if (!trimmed) {
    return;
  }
  target.add(trimmed);
  const lower = trimmed.toLowerCase();
  if (lower !== trimmed) {
    target.add(lower);
  }
}

export function buildOhosModuleQueryTokens(modulePath: string): string[] {
  const tokens = new Set<string>();
  appendSymbolVariants(tokens, modulePath);
  const last = ohosModuleLastSegment(modulePath);
  if (last) {
    appendSymbolVariants(tokens, last);
  }
  return filterSubsumedTokens([...tokens]);
}

export function buildSingleApiQueryTokens(trimmed: string): string[] {
  if (isOhosModuleQuery(trimmed)) {
    return buildOhosModuleQueryTokens(trimmed);
  }
  const tokens = new Set<string>();
  appendSymbolVariants(tokens, trimmed);
  return filterSubsumedTokens([...tokens]);
}

export function parseSplitApiPhraseQuery(raw: string): SplitApiPhrase | null {
  const trimmed = raw.trim();
  if (/[A-Z]/.test(trimmed)) {
    return null;
  }

  const match = trimmed.match(SPLIT_API_QUERY_RE);
  if (!match) {
    return null;
  }

  const first = match[1].toLowerCase();
  const second = match[2].toLowerCase();
  if (!IDENTIFIER_PART_RE.test(first) || COMPOUND_FIRST_BLOCKLIST.has(first)) {
    return null;
  }
  if (!isApiCompoundSuffix(second)) {
    return null;
  }

  const camelCase = buildCamelCaseCompound(first, second);
  return { first, second, camelCase, lower: camelCase.toLowerCase() };
}

/** Split query whose second word compounds to *Manager (e.g. wifi manager). */
export function getManagerSplitApiCompound(
  rawQuery: string
): SplitApiPhrase | null {
  const split = parseSplitApiPhraseQuery(rawQuery.trim());
  if (!split || split.second !== 'manager') {
    return null;
  }
  return split;
}

function managerMergeFirstWord(camelCase: string): string | null {
  const match = camelCase.match(/^([a-z][a-z0-9]*)Manager$/i);
  if (!match) {
    return null;
  }
  return match[1].toLowerCase();
}

/** Narrow option C: API 参考先搜 + 全库补全（wifi/notification 等 *Manager）。 */
export function shouldReferencesFirstForManagerQuery(
  rawQuery: string
): boolean {
  const trimmed = rawQuery.trim();
  const split = getManagerSplitApiCompound(trimmed);
  if (split && MANAGER_REFERENCE_MERGE_FIRST_WORDS.has(split.first)) {
    return true;
  }
  if (isSingleCamelCaseApiQuery(trimmed)) {
    const first = managerMergeFirstWord(trimmed);
    return first !== null && MANAGER_REFERENCE_MERGE_FIRST_WORDS.has(first);
  }
  return false;
}

export function rowMatchesManagerApiModule(
  docTitle: string,
  sectionTitle: string,
  compoundCamel: string
): boolean {
  const compoundLower = compoundCamel.toLowerCase();
  const ohosModuleRe = new RegExp(`@ohos\\.[^\\s(]*${compoundCamel}`, 'i');
  for (const field of [docTitle, sectionTitle]) {
    if (!field) {
      continue;
    }
    if (field.toLowerCase().includes(compoundLower)) {
      return true;
    }
    if (ohosModuleRe.test(field)) {
      return true;
    }
  }
  return false;
}

export function extractPriorityApiTokens(text: string): string[] {
  const trimmed = text.trim();
  if (isSingleApiLikeQuery(trimmed)) {
    return buildSingleApiQueryTokens(trimmed);
  }

  const tokens = new Set<string>();
  for (const modulePath of extractOhosModules(text)) {
    appendSymbolVariants(tokens, modulePath);
    const last = ohosModuleLastSegment(modulePath);
    if (last) {
      appendSymbolVariants(tokens, last);
    }
  }
  for (const camel of extractCamelCaseIdentifiers(text)) {
    appendSymbolVariants(tokens, camel);
  }
  for (const match of text.matchAll(DECORATOR_TOKEN_RE)) {
    tokens.add(match[0]);
  }
  for (const match of text.matchAll(QUALIFIED_SYMBOL_RE)) {
    tokens.add(match[0]);
  }
  for (const match of text.matchAll(PASCAL_CASE_API_RE)) {
    if (match[0].length >= 4) {
      tokens.add(match[0]);
    }
  }
  return filterSubsumedTokens([...tokens]);
}

export function extractQueryApiSymbolTokens(rawQuery: string): string[] {
  const trimmed = rawQuery.trim();
  if (isSingleApiLikeQuery(trimmed)) {
    return buildSingleApiQueryTokens(trimmed);
  }

  const tokens = new Set<string>();
  const split = parseSplitApiPhraseQuery(trimmed);
  if (split) {
    appendSymbolVariants(tokens, split.camelCase);
  }
  for (const token of extractPriorityApiTokens(trimmed)) {
    tokens.add(token);
  }
  for (const match of trimmed.matchAll(/\b[a-z][a-zA-Z0-9]{3,}\b/g)) {
    const value = match[0];
    if (value !== value.toLowerCase()) {
      tokens.add(value);
    }
  }
  return filterSubsumedTokens([...tokens]);
}

export function shouldSkipSynonymExpansion(trimmed: string): boolean {
  return isSingleApiLikeQuery(trimmed);
}
