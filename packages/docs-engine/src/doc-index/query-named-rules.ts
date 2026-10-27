/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Eval-tuned named query rules — shared by query-normalizer and catalog-routing.
 */

import type { CatalogName } from '../portal/catalog.js';
import {
  isOhosModuleQuery,
  shouldReferencesFirstForManagerQuery,
} from './api-identifiers.js';
import { CATALOG_NAME_TO_ID } from './constants.js';

export const NAMED_QUERY_RE = {
  pureApiSymbol: /^[A-Z][a-zA-Z0-9]+$/,
  stageModelExact: /^Stage\s*模型$/i,
  /** English alias for Stage 模型 (exact two-word query only). */
  stageModelEnglishExact: /^stage\s+model$/i,
  stageModel: /Stage\s*模型/i,
  stageModelEntryPage: /Stage\s*模型.*EntryAbility.*(页面|新页面)/,
  declarePermissionBoost: /声明.*权限|应用权限.*声明|如何声明应用权限/,
  declarePermissionCatalog: /如何声明应用权限/,
  declarePermissionTokens: /如何声明应用权限|声明应用权限/,
  uiAbilityLifecycleBoost: /UIAbility.*生命周期|生命周期.*UIAbility|UIAblity/i,
  uiAbilityLifecycleCatalog: /UIAblity.*生命周期|UIAbility.*生命周期/i,
  entryAbilityPage: /EntryAbility.*(页面|启动|跳转|新页面)/,
  stateDecoratorBoost: /@State|@Prop|@Link|@Provide|@Consume/,
  stateDecoratorCatalog: /@State\s*装饰器|@Prop\s*装饰器|@Link\s*装饰器/,
  stateManagement: /状态管理原理/,
  routerRoute: /Router\s+路由/,
  dialogPopupExact: /^Dialog\s+弹窗$/,
  dialogPopupBoost: /Dialog\s+弹窗/,
} as const;

export function isPureApiSymbolQuery(rawQuery: string): boolean {
  return NAMED_QUERY_RE.pureApiSymbol.test(rawQuery.trim());
}

function isStageModelExactQuery(rawQuery: string): boolean {
  const trimmed = rawQuery.trim();
  return (
    NAMED_QUERY_RE.stageModelExact.test(trimmed) ||
    NAMED_QUERY_RE.stageModelEnglishExact.test(trimmed)
  );
}

export function extractNamedConceptTokens(text: string): string[] {
  const tokens: string[] = [];
  if (isStageModelExactQuery(text.trim())) {
    tokens.push('Stage模型', 'Stage模型开发概述');
  }
  if (NAMED_QUERY_RE.declarePermissionTokens.test(text)) {
    tokens.push('声明权限');
  }
  if (NAMED_QUERY_RE.stageModelEntryPage.test(text)) {
    tokens.push('页面路由', 'pushUrl');
  }
  if (/UIAblity|UIAbility/.test(text) && /生命周期/.test(text)) {
    tokens.push('UIAbility组件生命周期');
  }
  return tokens;
}

export interface StageModelPreparedOverride {
  expandedQuery: string;
  tokens: string[];
}

export function getStageModelPreparedOverride(
  trimmedRawQuery: string
): StageModelPreparedOverride | null {
  if (!isStageModelExactQuery(trimmedRawQuery)) {
    return null;
  }
  return {
    expandedQuery: 'Stage模型开发概述',
    tokens: ['Stage模型开发概述', 'Stage模型'],
  };
}

type CatalogWeight = { catalog: CatalogName; multiplier: number };

interface NamedConceptBoostRule {
  matches: (rawQuery: string) => boolean;
  weights: CatalogWeight[];
}

const NAMED_CONCEPT_BOOST_RULES: NamedConceptBoostRule[] = [
  {
    matches: (q) => NAMED_QUERY_RE.uiAbilityLifecycleBoost.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.85 },
      { catalog: 'harmonyos-references', multiplier: 0.65 },
      { catalog: 'harmonyos-faqs', multiplier: 0.82 },
    ],
  },
  {
    matches: (q) => isStageModelExactQuery(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.85 },
      { catalog: 'harmonyos-references', multiplier: 0.55 },
      { catalog: 'harmonyos-faqs', multiplier: 0.85 },
    ],
  },
  {
    matches: (q) =>
      !isStageModelExactQuery(q) && NAMED_QUERY_RE.stageModel.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.65 },
      { catalog: 'harmonyos-references', multiplier: 0.65 },
    ],
  },
  {
    matches: (q) => NAMED_QUERY_RE.entryAbilityPage.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.75 },
      { catalog: 'harmonyos-references', multiplier: 0.48 },
    ],
  },
  {
    matches: (q) => NAMED_QUERY_RE.declarePermissionBoost.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.65 },
      { catalog: 'best-practices', multiplier: 0.68 },
    ],
  },
  {
    matches: (q) => NAMED_QUERY_RE.stateDecoratorBoost.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.75 },
      { catalog: 'harmonyos-references', multiplier: 0.42 },
    ],
  },
  {
    matches: (q) => NAMED_QUERY_RE.stateManagement.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.6 },
      { catalog: 'best-practices', multiplier: 0.78 },
    ],
  },
  {
    matches: (q) => NAMED_QUERY_RE.routerRoute.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.65 },
      { catalog: 'harmonyos-references', multiplier: 1.4 },
      { catalog: 'harmonyos-faqs', multiplier: 0.72 },
      { catalog: 'best-practices', multiplier: 0.72 },
    ],
  },
  {
    matches: (q) => NAMED_QUERY_RE.dialogPopupBoost.test(q),
    weights: [
      { catalog: 'harmonyos-guides', multiplier: 1.65 },
      { catalog: 'harmonyos-faqs', multiplier: 0.72 },
      { catalog: 'best-practices', multiplier: 0.72 },
    ],
  },
];

function applyWeights(
  boosts: Map<number, number>,
  weights: CatalogWeight[]
): void {
  for (const { catalog, multiplier } of weights) {
    const catalogId = CATALOG_NAME_TO_ID[catalog];
    boosts.set(catalogId, (boosts.get(catalogId) ?? 1) * multiplier);
  }
}

export function applyNamedConceptBoosts(
  rawQuery: string,
  boosts: Map<number, number>
): void {
  for (const rule of NAMED_CONCEPT_BOOST_RULES) {
    if (rule.matches(rawQuery)) {
      applyWeights(boosts, rule.weights);
    }
  }
}

/** PascalCase API / @ohos module: search references first, then backfill from all catalogs. */
export function shouldMergeReferencesWithGlobalFallback(
  rawQuery: string,
  explicitCatalog?: CatalogName
): boolean {
  if (explicitCatalog !== undefined) {
    return false;
  }
  const trimmed = rawQuery.trim();
  return (
    isOhosModuleQuery(trimmed) ||
    NAMED_QUERY_RE.pureApiSymbol.test(trimmed) ||
    shouldReferencesFirstForManagerQuery(trimmed)
  );
}

export function inferNamedSearchCatalog(
  rawQuery: string
): CatalogName | undefined {
  const trimmed = rawQuery.trim();
  if (
    isOhosModuleQuery(trimmed) ||
    NAMED_QUERY_RE.pureApiSymbol.test(trimmed)
  ) {
    return 'harmonyos-references';
  }
  if (isStageModelExactQuery(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.uiAbilityLifecycleCatalog.test(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.stateDecoratorCatalog.test(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.stateManagement.test(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.declarePermissionCatalog.test(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.stageModelEntryPage.test(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.routerRoute.test(trimmed)) {
    return 'harmonyos-guides';
  }
  if (NAMED_QUERY_RE.dialogPopupExact.test(trimmed)) {
    return 'harmonyos-guides';
  }
  return undefined;
}
