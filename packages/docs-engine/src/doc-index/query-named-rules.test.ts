/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  applyNamedConceptBoosts,
  extractNamedConceptTokens,
  getStageModelPreparedOverride,
  inferNamedSearchCatalog,
  isPureApiSymbolQuery,
  shouldMergeReferencesWithGlobalFallback,
} from './query-named-rules.js';
import { CATALOG_NAME_TO_ID } from './constants.js';
import { CATALOG_NAMES } from '../portal/catalog.js';

// Same order as CATALOG_NAMES: guides, references, best-practices, faqs, releases, roadmap.
const [GUIDES, REFERENCES, , FAQS] = CATALOG_NAMES;

describe('isPureApiSymbolQuery', () => {
  it.each([
    ['Navigation', true],
    ['UIAbility', true],
    ['Nav', true],
    [' Navigation ', true],
    ['navigation', false],
    ['getUserAgent', false],
    ['Nav igation', false],
  ])('isPureApiSymbolQuery(%s) → %s', (input, expected) => {
    expect(isPureApiSymbolQuery(input)).toBe(expected);
  });
});

describe('extractNamedConceptTokens', () => {
  it('expands the exact stage-model query', () => {
    expect(extractNamedConceptTokens('Stage 模型')).toEqual([
      'Stage模型',
      'Stage模型开发概述',
    ]);
  });

  it('expands the English stage-model alias', () => {
    expect(extractNamedConceptTokens('stage model')).toEqual([
      'Stage模型',
      'Stage模型开发概述',
    ]);
  });

  it('returns nothing for a non-exact stage query', () => {
    expect(extractNamedConceptTokens('Stage 模型开发概述')).toEqual([]);
  });

  it('expands declare-permission phrasings', () => {
    expect(extractNamedConceptTokens('如何声明应用权限')).toEqual(['声明权限']);
    expect(extractNamedConceptTokens('声明应用权限')).toEqual(['声明权限']);
  });

  it('expands the stage entry page flow', () => {
    expect(
      extractNamedConceptTokens('Stage 模型 EntryAbility 跳转新页面')
    ).toEqual(['页面路由', 'pushUrl']);
  });

  it('expands the UIAbility lifecycle concept', () => {
    expect(extractNamedConceptTokens('UIAbility 生命周期')).toEqual([
      'UIAbility组件生命周期',
    ]);
  });

  it('tolerates the UIAblity misspelling', () => {
    expect(extractNamedConceptTokens('UIAblity 生命周期')).toEqual([
      'UIAbility组件生命周期',
    ]);
  });

  it('returns nothing for unrelated UIAbility queries', () => {
    expect(extractNamedConceptTokens('UIAbility 基础')).toEqual([]);
  });

  it('returns nothing for plain queries', () => {
    expect(extractNamedConceptTokens('普通查询')).toEqual([]);
  });
});

describe('getStageModelPreparedOverride', () => {
  it('returns the prepared override for the exact Chinese query', () => {
    expect(getStageModelPreparedOverride('Stage 模型')).toEqual({
      expandedQuery: 'Stage模型开发概述',
      tokens: ['Stage模型开发概述', 'Stage模型'],
    });
  });

  it('accepts the query without any whitespace', () => {
    expect(getStageModelPreparedOverride('Stage模型')).not.toBeNull();
  });

  it('returns null for non-exact stage queries', () => {
    expect(getStageModelPreparedOverride('Stage 模型概述')).toBeNull();
  });
});

describe('applyNamedConceptBoosts', () => {
  it('boosts guides and dampens references for UIAbility lifecycle', () => {
    const boosts = new Map<number, number>();
    applyNamedConceptBoosts('UIAbility 生命周期', boosts);
    expect(boosts.get(CATALOG_NAME_TO_ID[GUIDES])).toBeCloseTo(1.85, 10);
    expect(boosts.get(CATALOG_NAME_TO_ID[REFERENCES])).toBeCloseTo(0.65, 10);
    expect(boosts.get(CATALOG_NAME_TO_ID[FAQS])).toBeCloseTo(0.82, 10);
  });

  it('applies multi-catalog weights for the router-route rule', () => {
    const boosts = new Map<number, number>();
    applyNamedConceptBoosts('Router 路由', boosts);
    expect(boosts.get(CATALOG_NAME_TO_ID[GUIDES])).toBeCloseTo(1.65, 10);
    expect(boosts.get(CATALOG_NAME_TO_ID[REFERENCES])).toBeCloseTo(1.4, 10);
    expect(boosts.get(CATALOG_NAME_TO_ID[FAQS])).toBeCloseTo(0.72, 10);
    expect(boosts.get(CATALOG_NAME_TO_ID['best-practices'])).toBeCloseTo(
      0.72,
      10
    );
  });

  it('multiplies weights when two rules match the same query', () => {
    const boosts = new Map<number, number>();
    applyNamedConceptBoosts('Router 路由 Dialog 弹窗', boosts);
    expect(boosts.get(CATALOG_NAME_TO_ID[GUIDES])).toBeCloseTo(1.65 * 1.65, 10);
    expect(boosts.get(CATALOG_NAME_TO_ID[FAQS])).toBeCloseTo(0.72 * 0.72, 10);
  });

  it('leaves the map untouched for a plain query', () => {
    const boosts = new Map<number, number>();
    applyNamedConceptBoosts('普通查询', boosts);
    expect(boosts.size).toBe(0);
  });
});

describe('shouldMergeReferencesWithGlobalFallback', () => {
  it('returns false when an explicit catalog is given', () => {
    expect(shouldMergeReferencesWithGlobalFallback('Navigation', GUIDES)).toBe(
      false
    );
  });

  it('returns true for an @ohos module query (功能性引用)', () => {
    expect(shouldMergeReferencesWithGlobalFallback('@ohos.hilog')).toBe(true);
  });

  it('returns true for a pure PascalCase API symbol', () => {
    expect(shouldMergeReferencesWithGlobalFallback('Navigation')).toBe(true);
  });

  it('returns true for whitelisted manager compounds', () => {
    expect(shouldMergeReferencesWithGlobalFallback('wifiManager')).toBe(true);
  });

  it('returns false for plain Chinese queries', () => {
    expect(shouldMergeReferencesWithGlobalFallback('如何开发应用')).toBe(false);
  });
});

describe('inferNamedSearchCatalog', () => {
  it.each([
    ['@ohos.hilog', REFERENCES],
    ['Navigation', REFERENCES],
    ['Stage 模型', GUIDES],
    ['UIAbility 生命周期', GUIDES],
    ['@State 装饰器', GUIDES],
    ['状态管理原理', GUIDES],
    ['如何声明应用权限', GUIDES],
    ['Router 路由', GUIDES],
    ['Dialog 弹窗', GUIDES],
    ['普通查询', undefined],
  ])('inferNamedSearchCatalog(%s) → %s', (input, expected) => {
    expect(inferNamedSearchCatalog(input)).toBe(expected);
  });
});
