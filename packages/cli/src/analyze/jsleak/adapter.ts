/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { parse, resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { compareSnapshots, summarizeSnapshot } from './snapshot.js';
import { SNAPSHOT_LIMITS, type JSLeakReport, type SnapshotSummary } from './types.js';

export const jsleakSchema = z.strictObject({ snapshots: z.array(z.string().min(1).max(4096)).min(1).max(2) });
async function inputPath(value: string, context: ExecutionContext): Promise<string> {
  const file = resolve(context.cwd, value);
  if (!file.endsWith('.heapsnapshot') || file.split(sep).some(part => privateEvidenceName.test(part))) {
    throw new Error('HEAPSNAPSHOT_INPUT_UNSAFE');
  }
  let parent = parse(file).root;
  for (const part of file.slice(parent.length).split(sep)) {
    parent = resolve(parent, part);
    if ((await lstat(parent)).isSymbolicLink()) { throw new Error('HEAPSNAPSHOT_INPUT_UNSAFE'); }
  }
  return file;
}
async function readSnapshot(path: string, context: ExecutionContext): Promise<Buffer> {
  try {
    context.abortSignal.throwIfAborted();
    return await readProblemFile(path, SNAPSHOT_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted();
    throw new Error('HEAPSNAPSHOT_INPUT_UNSAFE');
  }
}
async function summaries(values: string[], context: ExecutionContext): Promise<SnapshotSummary[]> {
  const result: SnapshotSummary[] = [], seen = new Set<string>();
  let total = 0;
  for (const value of values) {
    let path: string;
    try { path = await inputPath(value, context); }
    catch { context.abortSignal.throwIfAborted(); throw new Error('HEAPSNAPSHOT_INPUT_UNSAFE'); }
    if (seen.has(path)) { throw new Error('HEAPSNAPSHOT_INPUT_DUPLICATE'); }
    seen.add(path);
    const bytes = await readSnapshot(path, context); total += bytes.length;
    if (total > SNAPSHOT_LIMITS.totalBytes) { throw new Error('HEAPSNAPSHOT_INPUT_LIMIT'); }
    result.push(await summarizeSnapshot(bytes, context.abortSignal));
  }
  return result;
}
export async function analyzeJSLeak(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const values = jsleakSchema.parse(input), snapshots = await summaries(values.snapshots, context);
  context.abortSignal.throwIfAborted();
  const report: JSLeakReport = {
    schemaVersion: '1.0', analyzer: 'jsleak', completeness: 'incomplete', snapshots,
    comparison: snapshots.length === 2 ? { basis: 'input-order-aggregate-only', groups: compareSnapshots(snapshots[0], snapshots[1]) } : null,
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', retainedSize: 'not-computed',
      leakDiagnosis: 'not-established', rawheap: 'unavailable', nativeAssociation: 'unavailable' },
    coverage: { graph: 'declared-edges-only', excludedEdgeTypes: ['shortcut', 'weak'], names: 'sha256-only',
      ordering: 'user-input-not-capture-time', otherSections: 'not-analyzed', limits: SNAPSHOT_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > SNAPSHOT_LIMITS.reportBytes) { throw new Error('HEAPSNAPSHOT_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'jsleak-report', text);
  const data = Buffer.byteLength(text) <= 1024 * 1024 ? report : {
    ...report, groupsLocation: 'report-artifact', report: artifact,
    snapshots: report.snapshots.map(({ groups, ...summary }) => ({ ...summary, groupCount: groups.length })),
    comparison: report.comparison ? { basis: report.comparison.basis, groupCount: report.comparison.groups.length } : null,
  };
  return { exitCode: 3, data, artifacts: [artifact], provenance: { basis: 'snapshot-raw-bytes', captureIdentity: 'unverified' } };
}
