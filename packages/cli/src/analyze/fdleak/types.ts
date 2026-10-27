/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const FD_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024, topEntries: 10,
  stacks: 10_000, framesPerStack: 32, nameBytes: 1024, reportBytes: 16 * 1024 * 1024,
} as const;
export interface FDSource { line: number; offset: number; bytes: number; sha256: string }
export interface FDCount {
  count: number; kind: string; nameSha256: string; shareOfSnapshot: number | null; source: FDSource;
}
export interface FDStack {
  count: number; frames: { moduleSha256: string; offsetHex: string }[]; source: FDSource;
}
export interface FDParsed {
  snapshot: { count: number; pid: number | null; processSha256: string | null; timeSha256: string | null; source: FDSource };
  fdTop: FDCount[];
  dirTop: FDCount[];
  allocation: { pid: number | null; timeSha256: string | null;
    snapshotPidRelation: 'matches-declared-pid' | 'different-declared-pid' | 'unavailable'; stacks: FDStack[] };
  fieldSources: Record<string, FDSource>;
  ignoredLines: number;
  detailSections: string[];
}
export interface FDCandidate {
  code: 'fd-snapshot-reported' | 'fd-allocation-hotspot'; evidenceLevel: 'single-feature'; interpretation: string;
}
export interface FDReport {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'fdleak'; completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'fd-log-skill-1.4-subset' };
  snapshot: FDParsed['snapshot']; fdTop: FDCount[]; dirTop: FDCount[];
  allocation: FDParsed['allocation']; fieldSources: Record<string, FDSource>;
  summary: { snapshotCount: number; fdTopSum: number; fdTopRemainder: number; stackCount: number; maxAllocationCount: number };
  candidates: FDCandidate[];
  checks: { captureIdentity: 'unverified'; buildIdentity: 'unverified'; runtimeVersion: 'unverified';
    rootCause: 'not-established'; leakDiagnosis: 'not-established'; symbols: 'not-resolved'; detailAssociation: 'not-performed' };
  coverage: { basis: 'declared-log-fields-only'; ignoredLines: number; detailSections: string[];
    allocationMetric: 'ten-minute-all-allocations-including-closed'; callDirection: 'right-to-left';
    rawText: 'not-persisted'; ordering: 'file-order-not-capture-time'; limits: typeof FD_LIMITS };
}
