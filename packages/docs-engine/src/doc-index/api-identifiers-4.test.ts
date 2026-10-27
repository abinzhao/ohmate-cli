/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  extractPriorityApiTokens,
  extractQueryApiSymbolTokens,
  getManagerSplitApiCompound,
  parseSplitApiPhraseQuery,
  rowMatchesManagerApiModule,
  shouldReferencesFirstForManagerQuery,
} from './api-identifiers.js';

describe('parseSplitApiPhraseQuery', () => {
  it('parses a valid noun + suffix phrase', () => {
    expect(parseSplitApiPhraseQuery('camera picker')).toEqual({
      first: 'camera',
      second: 'picker',
      camelCase: 'cameraPicker',
      lower: 'camerapicker',
    });
  });

  it('collapses repeated whitespace between words', () => {
    expect(parseSplitApiPhraseQuery('camera  picker')).toEqual({
      first: 'camera',
      second: 'picker',
      camelCase: 'cameraPicker',
      lower: 'camerapicker',
    });
  });

  it('trims surrounding whitespace before matching', () => {
    expect(parseSplitApiPhraseQuery(' camera picker ')).not.toBeNull();
  });

  it('parses wifi manager into its compound', () => {
    expect(parseSplitApiPhraseQuery('wifi manager')).toEqual({
      first: 'wifi',
      second: 'manager',
      camelCase: 'wifiManager',
      lower: 'wifimanager',
    });
  });

  it.each([
    ['Camera picker'],
    ['camera Picker'],
    ['ab picker'],
    ['how picker'],
    ['stage model'],
    ['camera ability'],
    ['camera'],
  ])('rejects non-compound phrase: %s', (input) => {
    expect(parseSplitApiPhraseQuery(input)).toBeNull();
  });
});

describe('getManagerSplitApiCompound', () => {
  it('returns the split when the second word is manager', () => {
    expect(getManagerSplitApiCompound('wifi manager')?.camelCase).toBe(
      'wifiManager'
    );
  });

  it('returns the split for any noun + manager phrase', () => {
    expect(getManagerSplitApiCompound('xyz manager')?.first).toBe('xyz');
  });

  it('returns null for non-manager suffixes', () => {
    expect(getManagerSplitApiCompound('camera picker')).toBeNull();
  });
});

describe('shouldReferencesFirstForManagerQuery', () => {
  it.each([
    ['wifi manager', true],
    ['notification manager', true],
    ['wifiManager', true],
    ['xyz manager', false],
    ['xyzManager', false],
    ['camera picker', false],
    ['cameraPicker', false],
  ])('shouldReferencesFirstForManagerQuery(%s) → %s', (input, expected) => {
    expect(shouldReferencesFirstForManagerQuery(input)).toBe(expected);
  });
});

describe('rowMatchesManagerApiModule', () => {
  it('matches when the section title contains the compound', () => {
    expect(
      rowMatchesManagerApiModule('文档标题', 'wifimanager', 'wifiManager')
    ).toBe(true);
  });

  it('matches case-insensitively against lowercased compound', () => {
    expect(
      rowMatchesManagerApiModule('WIFIMANAGER 说明', '', 'wifiManager')
    ).toBe(true);
  });

  it('does not match the spaced phrase form of the compound', () => {
    // 复合匹配只认连写形式，空格分隔的短语不算
    expect(
      rowMatchesManagerApiModule('WIFI Manager 说明', '', 'wifiManager')
    ).toBe(false);
  });

  it('matches an @ohos-prefixed title via the compound substring check', () => {
    // @ohos.<compound> 标题必然连续包含 compound，先命中 includes 分支即返回 true；
    // ohosModuleRe 分支因此不可达，待单独的生产代码改动删除
    expect(
      rowMatchesManagerApiModule('@ohos.wifiManager 简介', '', 'wifiManager')
    ).toBe(true);
  });

  it('returns false for unrelated titles', () => {
    expect(
      rowMatchesManagerApiModule('无关标题', '无关章节', 'wifiManager')
    ).toBe(false);
  });

  it('returns false when both fields are blank', () => {
    expect(rowMatchesManagerApiModule('', '   ', 'wifiManager')).toBe(false);
  });
});

describe('extractPriorityApiTokens', () => {
  it('returns original and lowercase variants for a single Pascal query', () => {
    expect(extractPriorityApiTokens('Navigation')).toEqual([
      'Navigation',
      'navigation',
    ]);
  });

  it('keeps the full module path for an inline module mention', () => {
    expect(extractPriorityApiTokens('使用 @ohos.hilog 记录')).toEqual([
      '@ohos.hilog',
    ]);
  });

  it('extracts camelCase identifiers with their lowercase variants', () => {
    expect(extractPriorityApiTokens('调用 wifiManager 接口')).toEqual([
      'wifiManager',
      'wifimanager',
    ]);
  });

  it('extracts decorator tokens', () => {
    expect(extractPriorityApiTokens('@State 装饰器')).toEqual(['@State']);
  });

  it('extracts long PascalCase words without a lowercase variant', () => {
    // 空闲文本中的 Pascal 词只收原形；小写变体仅来自 camel/模块/单查询路径
    expect(extractPriorityApiTokens('UIAbility 生命周期')).toEqual([
      'UIAbility',
    ]);
  });

  it('returns empty array for blank input', () => {
    expect(extractPriorityApiTokens('')).toEqual([]);
  });
});

describe('extractQueryApiSymbolTokens', () => {
  it('delegates single-API queries to the single token builder', () => {
    expect(extractQueryApiSymbolTokens('Navigation')).toEqual([
      'Navigation',
      'navigation',
    ]);
  });

  it('adds the compound for a split-phrase query', () => {
    expect(extractQueryApiSymbolTokens('camera picker')).toEqual([
      'cameraPicker',
      'camerapicker',
    ]);
  });

  it('adds the manager compound for a manager split query', () => {
    expect(extractQueryApiSymbolTokens('wifi manager')).toEqual([
      'wifiManager',
      'wifimanager',
    ]);
  });
});
