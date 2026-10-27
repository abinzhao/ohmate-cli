/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { CatalogName } from '../portal/catalog.js';
import { CATALOG_TITLES } from '../portal/catalog.js';
import { CATALOG_NAME_TO_ID } from './constants.js';
/** 全库搜索时固定排到结果列表后部（未指定 --catalog 时）。 */
export const TAIL_SEARCH_CATALOGS = [
  'harmonyos-releases',
  'harmonyos-roadmap',
] as const satisfies readonly CatalogName[];

const TAIL_CATALOG_IDS = new Set(
  TAIL_SEARCH_CATALOGS.map((name) => CATALOG_NAME_TO_ID[name])
);

const TAIL_CATALOG_DOCUMENT_PREFIXES = TAIL_SEARCH_CATALOGS.map(
  (name) => `${CATALOG_TITLES[name]}/`
);

export function isTailSearchCatalogId(catalogId: number): boolean {
  return TAIL_CATALOG_IDS.has(catalogId);
}

export function isTailCatalogDocumentId(documentId: string): boolean {
  return TAIL_CATALOG_DOCUMENT_PREFIXES.some((prefix) =>
    documentId.startsWith(prefix)
  );
}

export function orderRowsWithTailCatalogsLast<T extends { catalog_id: number }>(
  rows: T[]
): T[] {
  const head: T[] = [];
  const tail: T[] = [];
  for (const row of rows) {
    if (isTailSearchCatalogId(row.catalog_id)) {
      tail.push(row);
    } else {
      head.push(row);
    }
  }
  return [...head, ...tail];
}

export function orderLocalResultsWithTailCatalogsLast<
  T extends { documentId: string },
>(results: T[]): T[] {
  const head: T[] = [];
  const tail: T[] = [];
  for (const row of results) {
    if (isTailCatalogDocumentId(row.documentId)) {
      tail.push(row);
    } else {
      head.push(row);
    }
  }
  return [...head, ...tail];
}
import {
  applyNamedConceptBoosts,
  inferNamedSearchCatalog,
  isPureApiSymbolQuery,
} from './query-named-rules.js';

export interface CatalogRoutingRule {
  pattern: RegExp;
  catalog: CatalogName;
  multiplier: number;
  skipForPureApiSymbol?: boolean;
}

export const CATALOG_ROUTING_RULES: CatalogRoutingRule[] = [
  { pattern: /@ohos\./i, catalog: 'harmonyos-references', multiplier: 1.5 },
  { pattern: /@[A-Z][a-zA-Z]+/, catalog: 'harmonyos-guides', multiplier: 1.35 },
  {
    pattern: /(如何|怎么|怎样|步骤)/,
    catalog: 'harmonyos-guides',
    multiplier: 1.45,
  },
  {
    pattern: /(生命周期|原理|概述|什么是|模型|介绍)/,
    catalog: 'harmonyos-guides',
    multiplier: 1.35,
  },
  {
    pattern: /(报错|失败|错误|异常|排查)/,
    catalog: 'harmonyos-guides',
    multiplier: 1.25,
  },
  {
    pattern: /(报错|失败|FAQ)/i,
    catalog: 'harmonyos-faqs',
    multiplier: 1.2,
  },
  {
    pattern: /(构建|签名|打包|发布|上架|应用市场|hvigor|ohpm)/i,
    catalog: 'harmonyos-guides',
    multiplier: 1.3,
  },
  {
    pattern: /(行为变更|changelog|升级|适配|版本说明)/i,
    catalog: 'harmonyos-releases',
    multiplier: 1.3,
  },
  {
    pattern: /(路由|弹窗|手势|页面|权限|装饰器)/,
    catalog: 'harmonyos-guides',
    multiplier: 1.25,
    skipForPureApiSymbol: true,
  },
];

function applyCatalogWeight(
  boosts: Map<number, number>,
  catalog: CatalogName,
  multiplier: number
): void {
  const catalogId = CATALOG_NAME_TO_ID[catalog];
  boosts.set(catalogId, (boosts.get(catalogId) ?? 1) * multiplier);
}

function applyQueryShapeHeuristics(
  rawQuery: string,
  boosts: Map<number, number>
): void {
  const trimmed = rawQuery.trim();
  const hasChinese = /[\u4e00-\u9fff]/.test(trimmed);
  const hasPascalApi = /\b[A-Z][a-zA-Z0-9]{2,}\b/.test(trimmed);
  const hasCamelApi = /\b[a-z][a-zA-Z0-9]{3,}\b/.test(trimmed);

  if (hasChinese && (hasPascalApi || hasCamelApi)) {
    applyCatalogWeight(boosts, 'harmonyos-guides', 1.45);
    applyCatalogWeight(boosts, 'harmonyos-references', 1.35);
    return;
  }
  if (hasPascalApi || hasCamelApi) {
    applyCatalogWeight(boosts, 'harmonyos-references', 1.55);
  }
  if (
    /\b[A-Z][a-zA-Z]*(Gesture|Dialog|Sheet|Transition|Recognizer)\b/.test(
      trimmed
    )
  ) {
    applyCatalogWeight(boosts, 'harmonyos-references', 1.75);
  }
}

export function inferCatalogBoosts(rawQuery: string): Map<number, number> {
  const boosts = new Map<number, number>();
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return boosts;
  }

  const pureApiSymbol = isPureApiSymbolQuery(trimmed);

  applyQueryShapeHeuristics(trimmed, boosts);
  applyNamedConceptBoosts(trimmed, boosts);

  for (const rule of CATALOG_ROUTING_RULES) {
    if (!rule.pattern.test(trimmed)) {
      continue;
    }
    if (rule.skipForPureApiSymbol && pureApiSymbol) {
      continue;
    }
    applyCatalogWeight(boosts, rule.catalog, rule.multiplier);
  }

  return boosts;
}

export function inferSearchCatalog(rawQuery: string): CatalogName | undefined {
  return inferNamedSearchCatalog(rawQuery);
}
