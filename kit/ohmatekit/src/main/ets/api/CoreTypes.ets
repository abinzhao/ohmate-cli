/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export type CoreValue = string | number | boolean;
export type CorePriority = 'critical' | 'high' | 'normal' | 'verbose';
export type CoreFault = 'crash' | 'freeze' | 'oom' | 'render-exit' | 'unhandled-error';
export interface CoreClock {
  clockId: string;
  bootId: string;
  monotonicNs: number;
  wallTimeUtc: string;
}
export interface CoreField {
  key: string;
  kind: 'enum' | 'number' | 'boolean';
  values?: string[];
  minimum?: number;
  maximum?: number;
}
export interface CoreSchema {
  name: string;
  fields: CoreField[];
}
export interface CoreEvent {
  sequence: number;
  source: 'application' | 'recorder';
  name: string;
  priority: CorePriority;
  sessionId: string;
  clock: CoreClock;
  fields: Record<string, CoreValue>;
}
export class CoreOptions {
  buildId: string = '';
  sampling: number = 0.2;
  maxRecords: number = 512;
  maxBufferBytes: number = 262144;
  criticalReserveRecords: number = 32;
  criticalReserveBytes: number = 32768;
  maxStorageBytes: number = 5242880;
  maxProblems: number = 20;
  retentionDays: number = 7;
  flushIntervalMs: number = 1000;
  closeTimeoutMs: number = 100;
}
export interface CoreHost {
  now(): CoreClock;
  random(): number;
  sessionId(): string;
  hash(text: string): string;
  hashBytes?(bytes: Uint8Array): string;
  byteLength(text: string): number;
  recover(): Promise<string[]>;
  recoverProblems?(): Promise<string[]>;
  accountedStorageBytes?(): number;
  prune?(): Promise<CorePruneSummary>;
  append(text: string): Promise<'synced' | 'uncertain'>;
  /** Optional rolling extension; the host must accept only an exact stored event prefix. */
  extendSegment?(text: string): Promise<'synced' | 'uncertain'>;
  saveProblem(id: string, text: string): Promise<'synced' | 'uncertain'>;
  deleteProblem(id: string): Promise<boolean>;
}
export class CoreResult {
  code: string;
  problemId: string = '';
  reviewHash: string = '';
  text: string = '';
  constructor(code: string) { this.code = code; }
}
export class CoreArchiveResult extends CoreResult {
  archive: Uint8Array = new Uint8Array(0);
  fileName: string = '';
}
export class CorePruneSummary {
  code: string = 'PRUNE_UNAVAILABLE';
  segmentBytes: number = 0;
  deletedProblems: string[] = [];
}
export class CoreLoss {
  dropped: number = 0;
  criticalDropped: number = 0;
  firstSequence: number = 0;
  lastSequence: number = 0;
  // This enclosing range may include retained events; it is not an exact gap list.
  rangeKind: string = 'envelope';
}
export class CoreHealth {
  state: string = 'created';
  sessionId: string = '';
  buildVerification: string = 'unverified-build';
  durability: string = 'uncertain';
  storage: string = 'memory-only';
  recovery: string = 'none';
  problemRecovery: string = 'unavailable';
  problemBytes: number = 0;
  clockEvidence: string = 'host-asserted';
  recoveredFault: string = 'unknown';
  bufferRecords: number = 0;
  bufferBytes: number = 0;
  pendingRecords: number = 0;
  pendingBytes: number = 0;
  storageBytes: number = 0;
  storageAccountedBytes: number = -1;
  storageAccounting: string = 'unavailable';
  dropped: number = 0;
  criticalDropped: number = 0;
  sampled: number = 0;
  pausedDropped: number = 0;
  rejectedFields: number = 0;
  unknownEvents: number = 0;
  clockValid: boolean = true;
  errors: number = 0;
}
export interface CoreSegment {
  schemaVersion: string;
  sessionId: string;
  buildId: string;
  buildVerification: string;
  firstSequence: number;
  lastSequence: number;
  events: CoreEvent[];
  loss: CoreLoss;
}
export interface CoreEnvelope {
  schemaVersion: string;
  bytes: number;
  sha256: string;
  payload: string;
}
export class CoreTriage {
  confidence: string = 'insufficient-evidence';
  fault: string = 'unknown';
  source: string = 'application-reported';
  missing: string[] = ['system-first-scene', 'authenticated-build', 'symbols'];
}
export class CoreProblem {
  schemaVersion: string = '1.0';
  profile: string = 'ohmate-core-summary';
  problemId: string = '';
  sessionId: string = '';
  buildId: string = '';
  buildVerification: string = 'unverified-build';
  replay: string = 'manual-only';
  events: CoreEvent[] = [];
  attachments: string[] = [];
  loss: CoreLoss = new CoreLoss();
  triage: CoreTriage = new CoreTriage();
}
