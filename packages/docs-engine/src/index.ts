/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// Engine contract (primary public API)
export { createDocsEngine, apiVersion } from './engine.js';
export type {
  CreateDocsEngineOptions,
  DocsEngine,
  DocsSearchRequest,
  DocsSearchResult,
  DocsCatalogNode,
} from './engine.js';

// Catalog constants + types (CLI needs for static catalog listing + validation)
export { CATALOG_NAMES, CATALOG_TITLES } from './portal/catalog.js';
export type { CatalogName } from './portal/catalog.js';

// Error helpers (CLI needs for error UX)
export {
  isDocStorageError,
  assertDocStorageSafe,
} from './doc-index/path-safety.js';

// Query limit (CLI needs for input validation)
export { QUERY_MAX_RAW_CHARS } from './doc-index/constants.js';
