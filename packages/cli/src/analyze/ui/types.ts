/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const UI_ANALYSIS_LIMITS = {
  fileBytes: 16 * 1024 * 1024, lines: 100_000, lineBytes: 16 * 1024,
  events: 1024, nameBytes: 1024, reportBytes: 1024 * 1024,
} as const;
export type WindowNotice = 'focus' | 'unfocus' | 'foreground' | 'background' | 'destroy';
export type ContextReason = 'scope' | 'active' | 'default' | 'singleton' | 'foreground' | 'undefined';
export interface UIEvent {
  status: WindowNotice; currentId: number; trackedId: number; reason: ContextReason; instanceId: number;
  pid: number; tid: number; bundleSha256: string; moduleSha256: string; timeSha256: string;
  prefix: { kind: 'release' | 'debug'; sourceLine: number | null };
  source: { line: number; offset: number; bytes: number; sha256: string };
}
export interface UIParsed { events: UIEvent[]; contextLineCount: number }
export interface UIAnalysisReport extends UIParsed {
  schemaVersion: '1.0'; analyzerVersion: '1.0'; toolVersion: string; generatedAt: string;
  analyzer: 'ui'; completeness: 'incomplete';
  input: { sha256: string; bytes: number; format: 'ace-window-lifecycle-5.0.3-subset' };
  summary: { eventCount: number; byStatus: Partial<Record<WindowNotice, number>>; contextRangeEventCount: number };
  candidates: { code: 'context-id-in-ui-instance-range'; evidenceLevel: 'single-feature'; eventCount: number; alternatives: string[] }[];
  checks: {
    rootCause: 'not-established'; captureIdentity: 'unverified'; buildIdentity: 'unverified'; runtimeVersion: 'unverified';
    lifecycleState: 'not-inferred'; crossEventAssociation: 'not-performed'; responsibility: 'undetermined';
  };
  coverage: {
    basis: 'declared-notifications-only'; rawText: 'not-persisted'; layout: 'not-analyzed'; rendering: 'not-analyzed';
    ordering: 'file-order-only'; sourceCoordinates: 'declarations-only'; limits: typeof UI_ANALYSIS_LIMITS;
  };
}
