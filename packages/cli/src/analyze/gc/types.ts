/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const GC_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024, events: 10_000, reportBytes: 16 * 1024 * 1024,
} as const;
export interface GCEvent {
  type: string;
  heap: 'local' | 'shared';
  beforeUsedMiB: number;
  beforeCommittedMiB: number;
  afterUsedMiB: number;
  afterCommittedMiB: number;
  totalGcMs: number;
  concurrentMarkMs: number | null;
  reason: string;
  source: { line: number; offset: number; bytes: number; sha256: string };
}
export interface GCCandidate {
  code: 'allocation-limit-reported' | 'allocation-failure-reported';
  evidenceLevel: 'single-feature';
  eventCount: number;
  interpretation: string;
}
export interface GCReport {
  schemaVersion: '1.0';
  toolVersion: string;
  analyzerVersion: '1.0';
  generatedAt: string;
  analyzer: 'gc';
  completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'ark-gc-summary-5.0.3-subset' };
  events: GCEvent[];
  summary: { eventCount: number; maxTotalGcMs: number; byType: Record<string, number> };
  candidates: GCCandidate[];
  checks: {
    captureIdentity: 'unverified'; buildIdentity: 'unverified'; runtimeVersion: 'unverified';
    rootCause: 'not-established'; leakDiagnosis: 'not-established'; frequency: 'not-computed';
    allocationRate: 'not-computed'; verboseAssociation: 'not-performed';
  };
  coverage: {
    basis: 'declared-log-fields-only'; ordering: 'file-order-not-capture-time';
    durations: 'total-gc-and-concurrent-mark-separate'; numericValues: 'printed-rounded-values';
    ignoredLines: number; rawText: 'not-persisted'; limits: typeof GC_LIMITS;
  };
}
