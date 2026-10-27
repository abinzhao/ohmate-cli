/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const AUTO_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024,
  families: 8, markersPerFamily: 32, selectedReportBytes: 16 * 1024 * 1024,
  reportBytes: 17 * 1024 * 1024, receiptDataBytes: 768 * 1024,
} as const;
export type AutoFamily = 'ui' | 'gc' | 'api' | 'jscrash' | 'cppcrash' | 'freeze' | 'fdleak' | 'nativeleak';
export interface AutoCandidate {
  analyzer: AutoFamily; basis: 'raw-log-markers'; markerCount: number;
  markers: { line: number; offset: number; bytes: number; sha256: string }[];
}
export interface AutoReport {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'auto'; completeness: 'incomplete'; input: { sha256: string; bytes: number; format: 'bounded-log-triage-subset' };
  classification: AutoCandidate[]; selection: AutoFamily | null; analysis: unknown | null;
  checks: {
    rootCause: 'not-established'; captureIdentity: 'unverified'; buildIdentity: 'unverified';
    runtimeVersion: 'unverified'; crossAnalyzerAssociation: 'not-performed'; classification: 'markers-not-capture-authentication';
  };
  coverage: {
    selectedParser: 'validated-subset' | 'not-dispatched'; ambiguousInputs: 'manual-domain-selection';
    rawText: 'not-persisted'; snapshots: 'not-supported'; attachments: 'not-discovered'; limits: typeof AUTO_LIMITS;
  };
}
