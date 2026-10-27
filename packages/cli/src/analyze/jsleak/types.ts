/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const SNAPSHOT_LIMITS = {
  fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, nodes: 250_000, edges: 1_000_000,
  strings: 250_000, stringBytes: 16 * 1024 * 1024, groups: 50_000, pathNodes: 16, reportBytes: 64 * 1024 * 1024,
} as const;
export interface SnapshotGraph {
  nodes: number[];
  edges: number[];
  strings: string[];
  edgeStarts: Uint32Array;
}
export interface SnapshotPath {
  nodeIndex: number;
  edgeIndex: number | null;
}
export interface SnapshotGroup {
  type: string;
  nameHash: string;
  count: number;
  selfBytes: number;
  representative: { nodeIndex: number; path: SnapshotPath[]; truncated: boolean };
}
export interface SnapshotSummary {
  sha256: string;
  bytes: number;
  format: 'v8-json-layout-7';
  nodeCount: number;
  edgeCount: number;
  reachableNodes: number;
  excludedEdges: number;
  selfBytes: number;
  reachableSelfBytes: number;
  groups: SnapshotGroup[];
}
export interface SnapshotDelta {
  type: string;
  nameHash: string;
  countDelta: number;
  selfBytesDelta: number;
}
export interface JSLeakReport {
  schemaVersion: '1.0';
  analyzer: 'jsleak';
  completeness: 'incomplete';
  snapshots: SnapshotSummary[];
  comparison: { basis: 'input-order-aggregate-only'; groups: SnapshotDelta[] } | null;
  checks: {
    captureIdentity: 'unverified'; buildIdentity: 'unverified'; retainedSize: 'not-computed';
    leakDiagnosis: 'not-established'; rawheap: 'unavailable'; nativeAssociation: 'unavailable';
  };
  coverage: {
    graph: 'declared-edges-only'; excludedEdgeTypes: ['shortcut', 'weak'];
    names: 'sha256-only'; ordering: 'user-input-not-capture-time'; otherSections: 'not-analyzed';
    limits: typeof SNAPSHOT_LIMITS;
  };
}
