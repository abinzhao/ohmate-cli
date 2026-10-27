/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const NATIVELEAK_LIMITS = {
  fileBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, lines: 100_000,
  lineBytes: 16 * 1024, sampleRows: 1024, smapsRows: 1024, nameBytes: 1024, reportBytes: 1024 * 1024,
} as const;
export interface NativeSource { line: number; offset: number; bytes: number; sha256: string }
export interface NativeSampleRow {
  valueKiB: number; metric: 'rss-or-pss-plus-swap-pss-unidentified';
  monotonicSeconds: number; realtimeSha256: string; source: NativeSource;
}
export interface NativeSample {
  pid: number; processNameSha256: string;
  fields: Record<string, { value: number | string; source: NativeSource }>;
  header: NativeSource; rows: NativeSampleRow[];
  trend: {
    metric: 'mixed-memory-series'; startKiB: number; endKiB: number; peakKiB: number;
    deltaKiB: number; deltaPercent: number | null; durationSeconds: number; rowCount: number;
    direction: 'stable' | 'nondecreasing' | 'nonincreasing' | 'mixed';
  };
}
export type NativeCategory = 'native-heap' | 'arkts-heap' | 'ashmem' | 'anon' | 'unclassified';
export interface NativeSmapsRow {
  category: NativeCategory; nameSha256: string; values: number[]; source: NativeSource;
}
export interface NativeSmaps {
  headers: NativeSource[]; rows: NativeSmapsRow[]; summary: { values: number[]; source: NativeSource };
  totals: { pssKiB: number; swapPssKiB: number; combinedKiB: number };
  shares: { category: NativeCategory; numeratorKiB: number; denominatorKiB: number; percent: number | null }[];
}
export interface NativeLeakReport {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'nativeleak'; completeness: 'incomplete';
  inputs: { role: 'sample' | 'smaps'; sha256: string; bytes: number; format: string }[];
  sample: NativeSample; smaps: NativeSmaps | null;
  candidates: { evidenceLevel: 'single-feature'; alternatives: string[] }[];
  checks: {
    rootCause: 'not-established'; leakDiagnosis: 'not-established'; captureIdentity: 'unverified';
    buildIdentity: 'unverified'; runtimeVersion: 'unverified'; crossInputAssociation: 'not-performed';
    allocationLifetime: 'not-analyzed'; responsibility: 'undetermined';
  };
  coverage: {
    rawText: 'not-persisted'; basis: 'declared-fields-only'; sampleMetric: 'rss-and-pss-mixed-unidentified';
    summaryPss: 'includes-swap-pss'; rowUnits: 'KiB-except-counts'; time: 'declared-monotonic-seconds-realtime-hash-only';
    memoryDomain: 'mixed-rss-and-pss-plus-swap-pss'; dma: 'not-captured'; gpu: 'not-captured';
    names: 'classification-candidates-only'; htraceNmdNativeHook: 'not-analyzed'; symbols: 'not-requested';
    limits: typeof NATIVELEAK_LIMITS;
  };
}
