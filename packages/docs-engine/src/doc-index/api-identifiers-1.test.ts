/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  buildFtsMatch,
  buildFtsOrMatch,
  buildSplitApiAndMatch,
  escapeFtsToken,
} from './api-identifiers.js';

describe('escapeFtsToken', () => {
  it.each([
    ['abc', '"abc"'],
    ['中文 词', '"中文 词"'],
    ['', '""'],
    ['a"b', '"a""b"'],
    ['a""b', '"a""""b"'],
  ])('escapeFtsToken(%s) → %s', (input, expected) => {
    expect(escapeFtsToken(input)).toBe(expected);
  });
});

describe('buildFtsMatch', () => {
  it('returns empty match for empty token list', () => {
    expect(buildFtsMatch([], 'OR')).toBe('""');
  });

  it('joins tokens with OR operator', () => {
    expect(buildFtsMatch(['a', 'b'], 'OR')).toBe('"a" OR "b"');
  });

  it('joins tokens with AND operator', () => {
    expect(buildFtsMatch(['a', 'b'], 'AND')).toBe('"a" AND "b"');
  });

  it('deduplicates tokens keeping first occurrence', () => {
    expect(buildFtsMatch(['a', 'b', 'a'], 'OR')).toBe('"a" OR "b"');
  });

  it('filters out empty tokens before joining', () => {
    expect(buildFtsMatch(['a', '', 'b'], 'OR')).toBe('"a" OR "b"');
  });

  it('escapes embedded quotes in tokens', () => {
    expect(buildFtsMatch(['a"x'], 'AND')).toBe('"a""x"');
  });
});

describe('buildFtsOrMatch', () => {
  it('returns empty match for empty token list', () => {
    expect(buildFtsOrMatch([])).toBe('""');
  });

  it('delegates to buildFtsMatch with OR', () => {
    expect(buildFtsOrMatch(['a', 'b'])).toBe('"a" OR "b"');
  });
});

describe('buildSplitApiAndMatch', () => {
  it('wraps both sides in parentheses joined by AND', () => {
    expect(buildSplitApiAndMatch(['a', 'b'], ['c', 'd'])).toBe(
      '("a" OR "b") AND ("c" OR "d")'
    );
  });

  it('deduplicates tokens inside each side', () => {
    expect(buildSplitApiAndMatch(['a', 'a'], ['c', 'c'])).toBe(
      '("a") AND ("c")'
    );
  });

  it('degrades to plain OR match when left side is empty', () => {
    expect(buildSplitApiAndMatch([], ['c', 'd'])).toBe('"c" OR "d"');
  });

  it('degrades to plain OR match when right side is empty', () => {
    expect(buildSplitApiAndMatch(['a', 'b'], [])).toBe('"a" OR "b"');
  });

  it('returns empty match when both sides are empty', () => {
    expect(buildSplitApiAndMatch([], [])).toBe('""');
  });
});
