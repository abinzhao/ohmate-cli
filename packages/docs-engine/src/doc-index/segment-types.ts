/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface DocumentIndexSource {
  documentId: string;
  catalogId: number;
  docTitle: string;
  /** Empty for whole-document rows; set when indexed as a heading section. */
  sectionTitle: string;
  titleTokens: string;
  headingsText: string;
  apiSymbols: string[];
  bodySample: string;
  leadText: string;
  /** True when lead_text was truncated or this row is a document section slice. */
  excerptTruncated: boolean;
}

export interface BuildMeta {
  indexVersion: string;
  docsZipSha256: string;
  termsHash: string;
  synonymsHash: string;
  segmentCount: number;
  builtAt: number;
  builtBy: 'postinstall' | 'doc-init' | 'update';
}

export type BuildState =
  | 'idle'
  | 'installing'
  | 'indexing'
  | 'persisting'
  | 'done'
  | 'error';

export interface BuildStatus {
  state: BuildState;
  phase: number;
  phaseLabel: string;
  current: number;
  total: number;
  message: string;
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

export type RebuildReason =
  | 'no-index'
  | 'docs-changed'
  | 'engine-upgraded'
  | 'terms-changed'
  | 'synonyms-changed';
