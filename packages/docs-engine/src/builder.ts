/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Build-time exports for docs-index-builder.
 * Runtime consumers should import from the main entry (index.ts) instead.
 */

export { buildSearchIndex } from './doc-index/index-builder.js';
export { sha256File } from './doc-index/hash-utils.js';
export { INDEX_DB_MAX_BYTES } from './doc-index/constants.js';
export { getSynonymsHash, getTermsHash } from './doc-index/query-rewriter.js';
export { INDEX_LEXICON_FILES } from './doc-index/lexicon.js';
