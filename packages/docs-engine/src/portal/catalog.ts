/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface CatalogNode {
  nodeId: string;
  nodeName: string;
  relateDocument: string;
  isLeaf: boolean;
  parent: string;
  children: CatalogNode[];
  catalogIndex: number;
}

export interface CatalogTreeResponse {
  code: number;
  message: string;
  value: {
    catalogTreeList: CatalogNode[];
    title: string;
    lang: string;
    catalogName: string;
  };
}

export interface AnchorItem {
  anchorId: string;
  level: string;
  title: string;
  parentId?: string;
}

export interface DocumentContentBody {
  type: string;
  content: string;
}

export interface DocumentContent {
  docId: string;
  title: string;
  lang: string;
  content: string | DocumentContentBody;
  anchorList: AnchorItem[];
  catalogName: string;
  fileName: string;
  version: string;
}

export interface DocumentResponse {
  code: number;
  message: string;
  value: DocumentContent;
}

export interface SearchResult {
  title: string;
  catalog: string;
  documentId: string;
  path: string[];
  nodeId: string;
}

export interface FlatCatalogNode {
  nodeId: string;
  nodeName: string;
  relateDocument: string;
  catalog: string;
  path: string[];
  isLeaf: boolean;
}

export const CATALOG_NAMES = [
  'harmonyos-guides',
  'harmonyos-references',
  'best-practices',
  'harmonyos-faqs',
  'harmonyos-releases',
  'harmonyos-roadmap',
] as const;

export type CatalogName = (typeof CATALOG_NAMES)[number];

export const CATALOG_TITLES: Record<CatalogName, string> = {
  'harmonyos-guides': '开发指南',
  'harmonyos-references': 'API参考',
  'best-practices': '最佳实践',
  'harmonyos-faqs': 'FAQ',
  'harmonyos-releases': '版本说明',
  'harmonyos-roadmap': '变更预告',
};
