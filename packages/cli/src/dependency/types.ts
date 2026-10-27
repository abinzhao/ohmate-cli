/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ProjectInspection } from '../project-model/project-inspector.js';

export type Ecosystem = 'ohpm' | 'npm' | 'native';
export type Scope = 'production' | 'development' | 'optional' | 'peer' | 'dynamic' | 'unknown';
export interface Evidence { path: string; sha256: string; line?: number }
export interface NativeBinary {
  byteLength: number; format: 'elf' | 'ar-header' | 'ar-thin' | 'unrecognized';
  elf?: { machine: number; type: number; bits: number; byteOrder: string; abiHint: string | null; buildId: string | null; stripped: boolean };
  archive?: { status: 'complete' | 'incomplete'; gaps: string[]; members: NativeArchiveMember[] };
}
export interface NativeArchiveMember {
  index: number; headerOffset: number; offset: number; byteLength: number; sha256: string;
  name?: string; role: 'object' | 'symbol-table' | 'name-table'; format: 'elf' | 'unrecognized';
  elf?: NativeBinary['elf'];
}
export interface DependencyComponent {
  id: string; name: string; version: string | null; ecosystem: Ecosystem;
  kind: 'module' | 'package' | 'target' | 'library'; origin: 'manifest' | 'lock' | 'declaration' | 'cmake' | 'binary';
  path: string; locator?: string; license?: string; integrity?: string; evidence: Evidence[];
  declaredVersion?: string | null; versionSource?: 'manifest' | 'lock';
  binary?: NativeBinary;
}
export interface Relationship {
  from: string; to: string; kind: 'depends-on' | 'imports' | 'native-bridge' | 'links';
  scope: Scope; declared?: string; evidence: Evidence[];
}
export interface DependencyFinding {
  code: string; severity: 'warning' | 'info'; confidence: 'observed' | 'inferred';
  incomplete?: boolean; message: string; evidence: Evidence[]; components?: string[];
}
export interface DependencyGraph {
  schemaVersion: '1.0'; analyzerVersion: '1.0'; root: string; completeness: 'complete' | 'incomplete';
  project?: ProjectInspection;
  components: DependencyComponent[]; relationships: Relationship[]; findings: DependencyFinding[]; inputs: Evidence[];
  usage: { unused: 'not-evaluated'; basis: string[] };
  checks: { vulnerabilities: 'not-run'; licenseValidation: 'not-run'; nativeAbi: 'not-run'; installedPackages: 'not-read' };
}
export interface SourceFile extends Evidence {
  text: string; value?: Record<string, unknown>; bytes?: number; binary?: boolean; nativeBinary?: NativeBinary;
}
export interface PackageManifest {
  file: SourceFile; ecosystem: 'ohpm' | 'npm'; node: DependencyComponent; value: Record<string, unknown>;
  directory: string; lock?: SourceFile;
}
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export function evidence(file: SourceFile, line?: number): Evidence {
  return { path: file.path, sha256: file.sha256, ...(line ? { line } : {}) };
}
export function finding(graph: DependencyGraph, file: SourceFile, code: string, message: string, incomplete = false, severity: DependencyFinding['severity'] = 'warning') {
  graph.findings.push({ code, severity, confidence: 'observed', message, evidence: [evidence(file)], ...(incomplete ? { incomplete } : {}) });
}
