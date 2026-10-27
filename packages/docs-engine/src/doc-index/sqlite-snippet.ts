/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import {
  DOC_SNIPPET_CONTEXT_CHARS,
  DOC_SNIPPET_MAX_CHARS,
} from './constants.js';

export interface SnippetOptions {
  maxLen?: number;
  contextChars?: number;
  /** Index-time flag: lead_text was truncated or this row is a section slice. */
  excerptTruncated?: boolean;
}

const WORD_BOUNDARY_CHARS = [
  ' ',
  '。',
  '，',
  '；',
  '、',
  '.',
  '!',
  '?',
] as const;

function findLastWordBoundary(text: string, minIndex: number): number {
  let best = -1;
  for (const ch of WORD_BOUNDARY_CHARS) {
    const idx = text.lastIndexOf(ch);
    if (idx > best) {
      best = idx;
    }
  }
  return best >= minIndex ? best : -1;
}

export function truncateAtWordBoundary(
  text: string,
  maxLen: number
): { text: string; excerptTruncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return { text: trimmed, excerptTruncated: false };
  }

  const slice = trimmed.slice(0, maxLen);
  const lastBreak = findLastWordBoundary(slice, maxLen - 20);
  const cut = lastBreak >= 0 ? lastBreak : maxLen;
  return { text: trimmed.slice(0, cut).trimEnd(), excerptTruncated: true };
}

export function extractSearchSnippet(
  content: string,
  query: string,
  opts: SnippetOptions = {}
): string {
  const {
    maxLen = DOC_SNIPPET_MAX_CHARS,
    contextChars = DOC_SNIPPET_CONTEXT_CHARS,
    excerptTruncated = false,
  } = opts;
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLen) {
    return excerptTruncated ? `${normalized}...` : normalized;
  }

  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  let bestIndex = 0;
  for (const token of tokens) {
    const idx = normalized.toLowerCase().indexOf(token.toLowerCase());
    if (idx >= 0) {
      bestIndex = idx;
      break;
    }
  }

  const start = Math.max(0, bestIndex - contextChars);
  let end = Math.min(normalized.length, start + maxLen);
  const window = normalized.slice(start, end);
  const lastBreak = findLastWordBoundary(window, maxLen - 25);
  if (lastBreak >= 0) {
    end = start + lastBreak;
  }

  const snippet = normalized.slice(start, end).trim();
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length || excerptTruncated ? '...' : '';
  return `${prefix}${snippet}${suffix}`;
}
