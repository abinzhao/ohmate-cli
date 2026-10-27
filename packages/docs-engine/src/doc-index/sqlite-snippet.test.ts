/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  extractSearchSnippet,
  truncateAtWordBoundary,
} from './sqlite-snippet.js';

describe('truncateAtWordBoundary', () => {
  it('returns short text unchanged without truncation flag', () => {
    expect(truncateAtWordBoundary('short', 10)).toEqual({
      text: 'short',
      excerptTruncated: false,
    });
  });

  it('returns empty result for blank text', () => {
    expect(truncateAtWordBoundary('   ', 10)).toEqual({
      text: '',
      excerptTruncated: false,
    });
  });

  it('hard-cuts when no word boundary exists in the window', () => {
    expect(truncateAtWordBoundary('hello world', 5)).toEqual({
      text: 'hello',
      excerptTruncated: true,
    });
  });

  it('cuts back to the last word boundary inside the window', () => {
    expect(truncateAtWordBoundary('hello world', 8)).toEqual({
      text: 'hello',
      excerptTruncated: true,
    });
  });

  it('supports CJK punctuation as a word boundary', () => {
    // 切点落在边界字符本身，边界字符不计入结果
    expect(truncateAtWordBoundary('第一句。第二句。第三句。', 6)).toEqual({
      text: '第一句',
      excerptTruncated: true,
    });
  });

  it('cuts to empty string when maxLen is zero', () => {
    expect(truncateAtWordBoundary('hello', 0)).toEqual({
      text: '',
      excerptTruncated: true,
    });
  });
});

describe('extractSearchSnippet', () => {
  it('returns empty string for blank content', () => {
    expect(extractSearchSnippet('   ', 'query')).toBe('');
  });

  it('returns full content when it fits the limit', () => {
    expect(extractSearchSnippet('short content', 'q')).toBe('short content');
  });

  it('appends ellipsis to fitting content marked as truncated', () => {
    expect(
      extractSearchSnippet('short content', 'q', { excerptTruncated: true })
    ).toBe('short content...');
  });

  it('normalizes whitespace before measuring', () => {
    expect(extractSearchSnippet('  a   b  c  ', 'q')).toBe('a b c');
  });

  it('centres the window on the first query token hit', () => {
    const content = 'aaa token bbb ccc ddd eee fff ggg hhh iii';
    const snippet = extractSearchSnippet(content, 'token', {
      maxLen: 20,
      contextChars: 5,
    });
    expect(snippet).toBe('aaa token bbb ccc...');
  });

  it('starts the window at the beginning when no token hits', () => {
    const content = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll';
    const snippet = extractSearchSnippet(content, 'zzz', {
      maxLen: 20,
      contextChars: 5,
    });
    expect(snippet.startsWith('aaa bbb')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('prepends ellipsis when the window starts past the beginning', () => {
    const content = 'aaaa bbbb cccc dddd';
    const snippet = extractSearchSnippet(content, 'cccc', {
      maxLen: 10,
      contextChars: 5,
    });
    expect(snippet).toBe('...bbbb cccc...');
  });

  it('matches query tokens case-insensitively', () => {
    const content = 'aaa TOKEN bbb ccc ddd eee fff ggg hhh iii';
    const snippet = extractSearchSnippet(content, 'token', {
      maxLen: 20,
      contextChars: 5,
    });
    expect(snippet).toBe('aaa TOKEN bbb ccc...');
  });
});
