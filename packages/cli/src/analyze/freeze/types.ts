/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const FREEZE_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024,
  phases: 2, threadsPerPhase: 64, framesPerThread: 256, totalFrames: 512,
  sectionsPerPhase: 128, nameBytes: 1024, fieldBytes: 4096, buildIdBytes: 64, reportBytes: 1024 * 1024,
} as const;
export interface FreezeSource { line: number; offset: number; bytes: number; sha256: string }
export interface FreezeField { sha256: string; bytes: number; source: FreezeSource }
export interface FreezeFrame {
  ordinal: number; kind: 'native' | 'js'; pc: string | null; buildId: string | null;
  locationSha256: string; functionSha256: string | null; functionOffset: string | null;
  line: number | null; column: number | null; source: FreezeSource;
}
export interface FreezeThread {
  tid: number; nameSha256: string; source: FreezeSource; state: FreezeField | null; frames: FreezeFrame[];
}
export interface FreezePhase {
  event: string; pid: number; uid: number; targetTid: number | null;
  targetBasis: 'main-pid-declared' | 'event-tid-declared' | 'missing-event-tid';
  targetThreadOrdinal: number | null; source: FreezeSource; fields: Record<string, FreezeField>;
  threads: FreezeThread[]; sections: { name: string; source: FreezeSource }[];
}
export interface FreezeParsed {
  reason: string; fields: Record<string, FreezeField>; phases: FreezePhase[]; ignoredLines: number;
}
export interface FreezeReport extends FreezeParsed {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'freeze'; completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'oh-appfreeze-event-stack-subset' };
  summary: { phaseCount: number; threadCount: number; frameCount: number; targetStackCount: number; sameTargetTid: boolean | null };
  candidates: { code: 'freeze-event-declared' | 'system-warning-declared'; evidenceLevel: 'single-feature'; alternatives: string[] }[];
  checks: { systemFactors: 'not-evaluated'; threadState: 'undetermined'; rootCause: 'not-established';
    responsibility: 'undetermined'; sampleAssociation: 'not-performed'; symbols: 'not-resolved';
    captureIdentity: 'unverified'; buildIdentity: 'unverified'; runtimeVersion: 'unverified';
    queueAnalysis: 'not-performed'; binderAnalysis: 'not-performed'; buildIdAssociation: 'not-performed' };
  coverage: { basis: 'declared-log-fields-only'; rawText: 'not-persisted'; supplementaryAnalysis: 'presence-only';
    fingerprintMeaning: 'fault-clustering-hash-not-build-id'; sampleStacks: 'present-unassociated' | 'not-captured';
    callDirection: 'bottom-to-top'; pcMeaning: 'relative-or-absolute-unverified'; limits: typeof FREEZE_LIMITS };
}
