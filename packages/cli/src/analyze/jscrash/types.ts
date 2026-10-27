/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const JS_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024,
  frames: 256, nameBytes: 1024, fieldBytes: 4096, reportBytes: 1024 * 1024,
} as const;
export interface JSSource { line: number; offset: number; bytes: number; sha256: string }
export interface JSFrame {
  ordinal: number; declaredIndex: number | null; functionSha256: string; locationSha256: string;
  line: number; column: number; locationForm: 'path' | 'release-module-path'; source: JSSource;
}
export interface JSParsed {
  error: { type: string; classificationBasis: 'reason-and-error-name' | 'reason' | 'error-name';
    message: { sha256: string; bytes: number }; code: number | null };
  fields: Record<string, { sha256: string; bytes: number }>;
  fieldSources: Record<string, JSSource>;
  frames: JSFrame[];
  missingFields: string[];
  sections: { name: string; source: JSSource }[];
  rawStackDeclared: boolean;
  ignoredLines: number;
}
export interface JSReport {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'jscrash'; completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'oh-jscrash-js-stack-subset' };
  error: JSParsed['error']; fields: JSParsed['fields']; fieldSources: JSParsed['fieldSources']; frames: JSFrame[];
  summary: { frameCount: number; numberedFrameCount: number; releaseFormCount: number };
  candidates: { code: 'js-error-declared'; evidenceLevel: 'single-feature'; alternatives: string[] }[];
  checks: { captureIdentity: 'unverified'; buildIdentity: 'unverified'; runtimeVersion: 'unverified';
    rootCause: 'not-established'; sourceMap: 'not-resolved'; errorCodeMeaning: 'not-mapped';
    applicationOwnership: 'not-established'; snapshotAssociation: 'not-performed' };
  coverage: { basis: 'declared-log-fields-only'; missingFields: string[]; sections: JSParsed['sections'];
    rawStackDeclared: boolean; ignoredLines: number; fingerprintMeaning: 'fault-clustering-hash-not-build-id';
    rawText: 'not-persisted'; supplementaryAnalysis: 'presence-only'; callDirection: 'bottom-to-top';
    coordinates: 'raw-declared-not-source-verified'; limits: typeof JS_LIMITS };
}
