/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeSearchInput,
  prepareSearchQuery,
} from './query-normalizer.js';

describe('normalizeSearchInput', () => {
  it('joins keyword parts with single spaces', () => {
    expect(normalizeSearchInput(['a', 'b', 'c'])).toBe('a b c');
  });

  it('collapses repeated whitespace inside parts', () => {
    expect(normalizeSearchInput(['  a   b  '])).toBe('a b');
  });

  it('returns empty string for empty keyword list', () => {
    expect(normalizeSearchInput([])).toBe('');
  });

  it('returns empty string for blank parts', () => {
    expect(normalizeSearchInput(['', '   '])).toBe('');
  });

  it('caps raw input at the configured character limit', () => {
    const result = normalizeSearchInput(['x'.repeat(250)]);
    expect(result).toHaveLength(200);
    expect(result).toBe('x'.repeat(200));
  });
});

describe('prepareSearchQuery', () => {
  it('applies the stage-model override for the exact Chinese query', async () => {
    const prepared = await prepareSearchQuery(['Stage 模型']);
    expect(prepared.rawQuery).toBe('Stage 模型');
    expect(prepared.expandedQuery).toBe('Stage模型开发概述');
    expect(prepared.tokens).toEqual(['Stage模型开发概述', 'Stage模型']);
    expect(prepared.preferAnd).toBe(false);
    expect(prepared.ftsMatch).toBeUndefined();
  });

  it('applies the stage-model override for the English alias', async () => {
    const prepared = await prepareSearchQuery(['stage model']);
    expect(prepared.expandedQuery).toBe('Stage模型开发概述');
    expect(prepared.tokens).toEqual(['Stage模型开发概述', 'Stage模型']);
  });

  it('builds a single-token ftsMatch for a single PascalCase API query', async () => {
    const prepared = await prepareSearchQuery(['Navigation']);
    expect(prepared.rawQuery).toBe('Navigation');
    expect(prepared.expandedQuery).toBe('Navigation');
    expect(prepared.tokens).toEqual(['Navigation']);
    expect(prepared.preferAnd).toBe(false);
    expect(prepared.ftsMatch).toBe('"Navigation"');
  });

  it('builds a single-token ftsMatch for an @ohos module query (功能性引用)', async () => {
    const prepared = await prepareSearchQuery(['@ohos.hilog']);
    expect(prepared.tokens).toEqual(['@ohos.hilog']);
    expect(prepared.ftsMatch).toBe('"@ohos.hilog"');
  });
});
