/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { gcCandidates, gcSummary, parseGCLog } from './log.js';
import { GC_LIMITS, type GCReport } from './types.js';

export const gcSchema = z.strictObject({ log: z.string().min(1).max(4096) });
async function readLog(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('GC_INPUT_UNSAFE'); }
    return await readProblemFile(path, GC_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted();
    throw new Error('GC_INPUT_UNSAFE');
  }
}
export async function analyzeGC(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log } = gcSchema.parse(input), bytes = await readLog(log, context);
  const { events, ignoredLines } = await parseGCLog(bytes, context.abortSignal);
  const report: GCReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'gc', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'ark-gc-summary-5.0.3-subset' },
    events, summary: gcSummary(events), candidates: gcCandidates(events),
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      rootCause: 'not-established', leakDiagnosis: 'not-established', frequency: 'not-computed',
      allocationRate: 'not-computed', verboseAssociation: 'not-performed' },
    coverage: { basis: 'declared-log-fields-only', ordering: 'file-order-not-capture-time',
      durations: 'total-gc-and-concurrent-mark-separate', numericValues: 'printed-rounded-values',
      ignoredLines, rawText: 'not-persisted', limits: GC_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > GC_LIMITS.reportBytes) { throw new Error('GC_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'gc-report', text);
  const data = Buffer.byteLength(text) <= 1024 * 1024 ? report :
    { ...report, events: undefined, eventsLocation: 'report-artifact', report: artifact };
  return { exitCode: 3, data, artifacts: [artifact], provenance: { basis: 'log-raw-bytes', captureIdentity: 'unverified' } };
}
