/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  appendSymbolVariants,
  buildOhosModuleQueryTokens,
  buildSingleApiQueryTokens,
  extractCamelCaseIdentifiers,
  extractOhosModules,
  filterSubsumedTokens,
  ohosModuleLastSegment,
} from './api-identifiers.js';

describe('ohosModuleLastSegment', () => {
  it.each([
    ['@ohos.hilog', 'hilog'],
    ['@ohos.file.picker', 'picker'],
    ['@Ohos.Hilog', 'Hilog'],
    ['@ohos.hilog.', 'hilog'],
    ['@ohos.', undefined],
  ])('ohosModuleLastSegment(%s) → %s', (input, expected) => {
    expect(ohosModuleLastSegment(input)).toBe(expected);
  });
});

describe('extractOhosModules', () => {
  it('extracts a single module mention', () => {
    expect(extractOhosModules('使用 @ohos.hilog 记录日志')).toEqual([
      '@ohos.hilog',
    ]);
  });

  it('extracts multiple module mentions in order', () => {
    expect(extractOhosModules('@ohos.file.picker 与 @ohos.hilog')).toEqual([
      '@ohos.file.picker',
      '@ohos.hilog',
    ]);
  });

  it('returns empty array when no module is mentioned', () => {
    expect(extractOhosModules('普通文本没有模块')).toEqual([]);
  });

  it('does not match a module path with a single trailing character', () => {
    expect(extractOhosModules('@ohos.a')).toEqual([]);
  });
});

describe('extractCamelCaseIdentifiers', () => {
  it('extracts a camelCase identifier from mixed text', () => {
    expect(extractCamelCaseIdentifiers('使用 getUserAgent 接口')).toEqual([
      'getUserAgent',
    ]);
  });

  it('keeps identifiers at exactly the default min length', () => {
    expect(extractCamelCaseIdentifiers('fooBar baz')).toEqual(['fooBar']);
  });

  it('drops identifiers below the default min length', () => {
    expect(extractCamelCaseIdentifiers('getUI 接口')).toEqual([]);
  });

  it('honours an explicit minLen override', () => {
    expect(extractCamelCaseIdentifiers('fooBar', 7)).toEqual([]);
    expect(extractCamelCaseIdentifiers('fooBarX', 7)).toEqual(['fooBarX']);
  });
});

describe('filterSubsumedTokens', () => {
  it('drops a token that another token ends with (min 4 chars)', () => {
    expect(filterSubsumedTokens(['hilog', '@ohos.hilog'])).toEqual([
      '@ohos.hilog',
    ]);
  });

  it('keeps tokens that merely share a suffix', () => {
    expect(filterSubsumedTokens(['hilog', 'xilog'])).toEqual([
      'hilog',
      'xilog',
    ]);
  });

  it('keeps short sub-strings below the 4-char threshold', () => {
    expect(filterSubsumedTokens(['abc', 'xxabc'])).toEqual(['abc', 'xxabc']);
  });

  it('keeps case variants of equal length', () => {
    expect(filterSubsumedTokens(['Manager', 'manager'])).toEqual([
      'Manager',
      'manager',
    ]);
  });

  it('keeps a token that is only a prefix of a longer token', () => {
    // 吞并规则仅看后缀：前缀重叠不构成吞并
    expect(filterSubsumedTokens(['getUser', 'getUserAgent'])).toEqual([
      'getUser',
      'getUserAgent',
    ]);
  });
});

describe('appendSymbolVariants', () => {
  it('adds both original and lowercased form for mixed-case symbol', () => {
    const target = new Set<string>();
    appendSymbolVariants(target, 'Nav');
    expect([...target]).toEqual(['Nav', 'nav']);
  });

  it('adds only the original form for already-lowercase symbol', () => {
    const target = new Set<string>();
    appendSymbolVariants(target, 'nav');
    expect([...target]).toEqual(['nav']);
  });

  it('ignores blank symbols', () => {
    const target = new Set<string>();
    appendSymbolVariants(target, '   ');
    expect(target.size).toBe(0);
  });

  it('trims surrounding whitespace before adding', () => {
    const target = new Set<string>();
    appendSymbolVariants(target, ' Nav ');
    expect([...target]).toEqual(['Nav', 'nav']);
  });
});

describe('buildOhosModuleQueryTokens', () => {
  it('keeps only the full module path for a simple module', () => {
    expect(buildOhosModuleQueryTokens('@ohos.hilog')).toEqual(['@ohos.hilog']);
  });

  it('subsumes tail segments of a nested module path', () => {
    expect(buildOhosModuleQueryTokens('@ohos.file.picker')).toEqual([
      '@ohos.file.picker',
    ]);
  });
});

describe('buildSingleApiQueryTokens', () => {
  it('returns original and lowercase variant for a PascalCase query', () => {
    expect(buildSingleApiQueryTokens('Navigation')).toEqual([
      'Navigation',
      'navigation',
    ]);
  });

  it('delegates module queries to the module token builder', () => {
    expect(buildSingleApiQueryTokens('@ohos.hilog')).toEqual(['@ohos.hilog']);
  });
});
