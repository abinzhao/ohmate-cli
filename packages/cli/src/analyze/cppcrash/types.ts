/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const CPP_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024,
  frames: 256, nameBytes: 1024, fieldBytes: 4096, buildIdBytes: 64, reportBytes: 1024 * 1024,
} as const;
export interface CppSource { line: number; offset: number; bytes: number; sha256: string }
export interface CppFrame {
  ordinal: number; declaredIndex: number; pc: string; locationSha256: string; unknownLocation: boolean;
  functionSha256: string | null; functionOffset: string | null; buildId: string | null; source: CppSource;
}
export interface CppParsed {
  signal: { name: string; code: string; address: string | null; sender: { pid: number; uid: number } | null; hintSha256: string | null };
  thread: { tid: number; nameSha256: string; source: CppSource };
  fields: Record<string, { sha256: string; bytes: number }>; fieldSources: Record<string, CppSource>;
  frames: CppFrame[]; missingFields: string[]; sections: { name: string; source: CppSource }[]; ignoredLines: number;
}
export interface CppReport {
  schemaVersion: '1.0'; toolVersion: string; analyzerVersion: '1.0'; generatedAt: string;
  analyzer: 'cppcrash'; completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'oh-cppcrash-native-stack-subset' };
  signal: CppParsed['signal']; thread: CppParsed['thread']; fields: CppParsed['fields'];
  fieldSources: CppParsed['fieldSources']; frames: CppFrame[];
  summary: { frameCount: number; declaredFunctionCount: number; declaredBuildIdCount: number; unknownLocationCount: number };
  candidates: { code: 'native-signal-declared'; evidenceLevel: 'single-feature'; alternatives: string[] }[];
  checks: { captureIdentity: 'unverified'; buildIdentity: 'unverified'; runtimeVersion: 'unverified';
    rootCause: 'not-established'; symbols: 'not-resolved'; applicationOwnership: 'not-established';
    registerAnalysis: 'not-performed'; buildIdAssociation: 'not-performed'; detectorAnalysis: 'not-performed' };
  coverage: { basis: 'declared-log-fields-only'; missingFields: string[]; sections: CppParsed['sections']; ignoredLines: number;
    fingerprintMeaning: 'fault-clustering-hash-not-build-id'; rawText: 'not-persisted'; supplementaryAnalysis: 'presence-only';
    callDirection: 'bottom-to-top'; pcMeaning: 'relative-or-absolute-unverified'; functionMeaning: 'raw-declared-not-symbol-verified';
    limits: typeof CPP_LIMITS };
}
