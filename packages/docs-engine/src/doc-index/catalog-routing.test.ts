/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  inferCatalogBoosts,
  inferSearchCatalog,
  isTailCatalogDocumentId,
  isTailSearchCatalogId,
  orderLocalResultsWithTailCatalogsLast,
  orderRowsWithTailCatalogsLast,
} from './catalog-routing.js';
import { CATALOG_NAME_TO_ID } from './constants.js';
import { CATALOG_NAMES } from '../portal/catalog.js';

// Same order as CATALOG_NAMES: guides, references, best-practices, faqs, releases, roadmap.
const [GUIDES, REFERENCES, BEST_PRACTICES, FAQS, RELEASES, ROADMAP] =
  CATALOG_NAMES;

describe('isTailSearchCatalogId', () => {
  it('recognizes release and roadmap catalog ids', () => {
    expect(isTailSearchCatalogId(CATALOG_NAME_TO_ID[RELEASES])).toBe(true);
    expect(isTailSearchCatalogId(CATALOG_NAME_TO_ID[ROADMAP])).toBe(true);
  });

  it('rejects primary catalog ids', () => {
    expect(isTailSearchCatalogId(CATALOG_NAME_TO_ID[GUIDES])).toBe(false);
    expect(isTailSearchCatalogId(CATALOG_NAME_TO_ID[BEST_PRACTICES])).toBe(
      false
    );
  });

  it('rejects unknown ids', () => {
    expect(isTailSearchCatalogId(-1)).toBe(false);
  });
});

describe('isTailCatalogDocumentId', () => {
  it.each([
    ['版本说明/release-notes', true],
    ['变更预告/upcoming-change', true],
    ['开发指南/introduction', false],
    ['API参考/module-list', false],
    ['最佳实践/perf', false],
    ['版本说明', false],
  ])('isTailCatalogDocumentId(%s) → %s', (input, expected) => {
    expect(isTailCatalogDocumentId(input)).toBe(expected);
  });
});

describe('orderRowsWithTailCatalogsLast', () => {
  it('keeps head rows first and moves tail rows to the end in order', () => {
    const rows = [
      { catalog_id: 4, v: 'tail-1' },
      { catalog_id: 0, v: 'head-1' },
      { catalog_id: 5, v: 'tail-2' },
      { catalog_id: 2, v: 'head-2' },
    ];
    expect(orderRowsWithTailCatalogsLast(rows).map((r) => r.v)).toEqual([
      'head-1',
      'head-2',
      'tail-1',
      'tail-2',
    ]);
  });

  it('returns an empty array unchanged', () => {
    expect(orderRowsWithTailCatalogsLast([])).toEqual([]);
  });

  it('preserves order when every row is a tail row', () => {
    const rows = [
      { catalog_id: 5, v: 'a' },
      { catalog_id: 4, v: 'b' },
    ];
    expect(orderRowsWithTailCatalogsLast(rows).map((r) => r.v)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('orderLocalResultsWithTailCatalogsLast', () => {
  it('sorts local results by tail document-id prefix', () => {
    const results = [
      { documentId: '版本说明/notes' },
      { documentId: '开发指南/intro' },
      { documentId: '变更预告/preview' },
    ];
    expect(
      orderLocalResultsWithTailCatalogsLast(results).map((r) => r.documentId)
    ).toEqual(['开发指南/intro', '版本说明/notes', '变更预告/preview']);
  });
});

describe('inferCatalogBoosts', () => {
  it('returns an empty map for blank queries', () => {
    expect(inferCatalogBoosts('   ').size).toBe(0);
  });

  it('boosts references for module-path queries', () => {
    const boosts = inferCatalogBoosts('@ohos.hilog');
    expect(boosts.get(CATALOG_NAME_TO_ID[REFERENCES])).toBeCloseTo(2.325, 10);
  });

  it('boosts guides for how-to Chinese queries', () => {
    const boosts = inferCatalogBoosts('如何开发应用');
    expect(boosts.get(CATALOG_NAME_TO_ID[GUIDES])).toBeCloseTo(1.45, 10);
  });

  it('stacks shape heuristics, named rules and routing rules', () => {
    const boosts = inferCatalogBoosts('UIAbility 生命周期');
    expect(boosts.get(CATALOG_NAME_TO_ID[GUIDES])).toBeCloseTo(
      1.45 * 1.85 * 1.35,
      10
    );
    expect(boosts.get(CATALOG_NAME_TO_ID[REFERENCES])).toBeCloseTo(
      1.35 * 0.65,
      10
    );
    expect(boosts.get(CATALOG_NAME_TO_ID[FAQS])).toBeCloseTo(0.82, 10);
  });

  it('does not touch faqs for queries without error phrasing', () => {
    const boosts = inferCatalogBoosts('如何开发应用');
    expect(boosts.has(CATALOG_NAME_TO_ID[FAQS])).toBe(false);
  });
});

describe('inferSearchCatalog', () => {
  it('delegates to the named-catalog inference', () => {
    expect(inferSearchCatalog('Navigation')).toBe(REFERENCES);
    expect(inferSearchCatalog('普通查询')).toBeUndefined();
  });
});
