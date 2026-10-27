/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { setCacheDir } from './data-dir.js';
import { awaitDocReady } from './init/doc-initializer.js';
import {
  localDocService,
} from './service/local-doc-service.js';
import { resetSqliteBackendCache } from './doc-index/sqlite-backend-cache.js';
import { resetSearchDbCache } from './doc-index/sqlite-index.js';
import { resetDocsZipReaderCache } from './doc-index/docs-zip-reader.js';
import {
  CATALOG_NAMES,
  CATALOG_TITLES,
  type CatalogName,
} from './portal/catalog.js';

export const apiVersion = 1 as const;

export interface CreateDocsEngineOptions {
  cacheDir: string;
}

export interface DocsSearchRequest {
  keywords: string[];
  catalog?: string;
  limit?: number;
}

export interface DocsSearchResult {
  title: string;
  documentId: string;
  snippet: string;
  sectionTitle?: string;
}

export interface DocsCatalogNode {
  nodeId: string;
  nodeName: string;
  relateDocument: string;
  isLeaf: boolean;
  parent: string;
  children: DocsCatalogNode[];
  catalogIndex: number;
}

export interface DocsEngine {
  search(request: DocsSearchRequest): Promise<DocsSearchResult[]>;
  read(request: { relativePath: string }): Promise<string>;
  catalog(): Promise<DocsCatalogNode[]>;
  close(): Promise<void>;
}

export async function createDocsEngine(
  options: CreateDocsEngineOptions
): Promise<DocsEngine> {
  setCacheDir(options.cacheDir);

  return {
    async search(request: DocsSearchRequest): Promise<DocsSearchResult[]> {
      await awaitDocReady();
      const catalog = request.catalog
        ? (request.catalog as CatalogName | undefined)
        : undefined;
      return localDocService.search(
        request.keywords,
        catalog,
        request.limit ?? 10
      );
    },

    async read(request: { relativePath: string }): Promise<string> {
      return localDocService.readDocument(request.relativePath);
    },

    async catalog(): Promise<DocsCatalogNode[]> {
      return CATALOG_NAMES.map((name, index) => ({
        nodeId: name,
        nodeName: CATALOG_TITLES[name],
        relateDocument: '',
        isLeaf: true,
        parent: '',
        children: [],
        catalogIndex: index,
      }));
    },

    async close(): Promise<void> {
      resetSqliteBackendCache();
      resetSearchDbCache();
      resetDocsZipReaderCache();
    },
  };
}
