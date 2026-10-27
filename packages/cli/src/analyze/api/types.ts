/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const API_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024,
  events: 1024, nameBytes: 1024, reportBytes: 1024 * 1024,
  sdkBytes: 4 * 1024 * 1024, metadataBytes: 16 * 1024, sdkMatches: 512,
} as const;
export interface APISource { line: number; offset: number; bytes: number; sha256: string }
export interface APIEvent {
  code: number; pid: number; tid: number; level: 'E' | 'F'; domain: string;
  tagSha256: string; timeSha256: string; messageSha256: string; source: APISource;
}
export interface APISDK {
  status: 'declaration-candidates' | 'code-not-declared'; module: string;
  apiVersion: number; platformVersion: string; packageVersion: string;
  declarations: { sha256: string; bytes: number };
  metadata: { role: 'sdk' | 'ets'; sha256: string; bytes: number }[];
  matches: { code: number; category: string; messageSha256: string; source: APISource }[];
  association: 'module-jsdoc-only-not-callable-binding';
}
export interface APIParsed { events: APIEvent[]; contextLineCount: number }
export interface APIReport extends APIParsed {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'api'; completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'hilog-explicit-error-code-subset' };
  summary: { eventCount: number; byCode: Record<string, number>; contextLineCount: number };
  sdk: APISDK | null;
  candidates: { code: number; evidenceLevel: 'single-feature'; alternatives: string[] }[];
  checks: { rootCause: 'not-established'; captureIdentity: 'unverified'; buildIdentity: 'unverified';
    apiAssociation: 'not-established'; stateSequence: 'not-analyzed'; runtimeVersion: 'unverified'; responsibility: 'undetermined' };
  coverage: { rawText: 'not-persisted'; sdkMeaning: 'not-requested' | 'declaration-candidates-only'; context: 'line-count-only';
    domainMeaning: 'not-inferred'; limits: typeof API_LIMITS };
}
