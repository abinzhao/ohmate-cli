/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import type { FileEvidence } from '../quality/evidence.js';
import type { DependencyGraph } from '../dependency/index.js';
import type { ProjectModel } from '../project-model/index.js';

export const releaseSchema = z.strictObject({
  product: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  modules: z.array(z.string().regex(/^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/)).min(1).max(64).optional(),
  manifest: z.string().min(1).max(4096).optional(),
  artifacts: z.array(z.string().min(1).max(4096)).max(64).default([]),
  symbols: z.array(z.string().min(1).max(4096)).max(128).default([]),
});
export type ReleaseInput = z.infer<typeof releaseSchema>;
export interface ReleaseFile extends FileEvidence { bytes: Buffer; }
export interface SourceEvidence extends FileEvidence { text: string; }
export const manifestSchema = z.object({
  schemaVersion: z.literal('1.0'), completeness: z.enum(['complete', 'incomplete']),
  product: z.string().optional(), modules: z.array(z.string()).optional(), buildMode: z.string().optional(),
  inputs: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(10_000),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string() })).max(1024),
  sourceDrift: z.array(z.string()).optional(), missing: z.array(z.string()).optional(),
}).passthrough();
export type BuildManifest = z.infer<typeof manifestSchema>;
export interface ArchiveEntry { path: string; size: number; sha256: string | null; bytes: Buffer | null; }
export interface PackageEvidence {
  file: ReleaseFile; entries: ArchiveEntry[]; modules: Record<string, unknown>[];
}
export interface ReleaseSelection {
  value: ReleaseInput; model: ProjectModel; product: string; modules: string[];
  sources: SourceEvidence[]; excluded: string[]; dependencies: DependencyGraph;
  manifest: { file: ReleaseFile; value: BuildManifest } | null;
  packages: PackageEvidence[]; symbols: ReleaseFile[];
}
export interface Finding {
  code: string; message: string; confidence: 'observed' | 'inferred';
  evidence: { path: string; sha256: string; line?: number; entry?: string }[];
}
export interface Gate {
  id: string; number: number; title: string; status: 'passed' | 'failed' | 'incomplete';
  scope: string; findings: Finding[]; missing: string[];
}
export const gateDefinitions = [
  ['release.dependencies', 'Production dependency closure'],
  ['release.entries', 'Abilities, routes and test resources'],
  ['release.build-mode', 'Release build and debuggable metadata'],
  ['release.web-debug', 'ArkWeb debug switches and test APIs'],
  ['release.arkguard', 'ArkGuard rules and consumer options'],
  ['release.package-content', 'Packaged SourceMap, symbols, certificates and host paths'],
  ['release.permissions', 'Permission use and exported components'],
  ['release.sensitive-logs', 'Sensitive log rules'],
  ['release.symbol-correlation', 'SourceMap, nameCache and Native symbol correlation'],
  ['release.build-identity', 'Build inputs, dependencies, cloud outputs and SBOM identity'],
  ['release.native-abi', 'Native ABI coverage and symbol policy'],
  ['release.kit-core', 'Only Kit Core in the production closure'],
  ['release.debug-writes', 'No DOM, Storage, Mock, capture, highlight or Replay entry'],
  ['release.probes', 'No debug probes, debug manifests or system overlay permissions'],
] as const;
