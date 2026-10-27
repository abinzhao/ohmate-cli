/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { fdCandidates, fdSummary, parseFDLog } from './log.js';
import { FD_LIMITS, type FDReport } from './types.js';

export const fdSchema = z.strictObject({ log: z.string().min(1).max(4096) });
async function readLog(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('FD_INPUT_UNSAFE'); }
    return await readProblemFile(path, FD_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted(); throw new Error('FD_INPUT_UNSAFE');
  }
}
export async function analyzeFDLeak(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log } = fdSchema.parse(input), bytes = await readLog(log, context);
  const parsed = await parseFDLog(bytes, context.abortSignal);
  const report: FDReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'fdleak', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'fd-log-skill-1.4-subset' },
    snapshot: parsed.snapshot, fdTop: parsed.fdTop, dirTop: parsed.dirTop,
    allocation: parsed.allocation, fieldSources: parsed.fieldSources, summary: fdSummary(parsed), candidates: fdCandidates(parsed),
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      rootCause: 'not-established', leakDiagnosis: 'not-established', symbols: 'not-resolved', detailAssociation: 'not-performed' },
    coverage: { basis: 'declared-log-fields-only', ignoredLines: parsed.ignoredLines, detailSections: parsed.detailSections,
      allocationMetric: 'ten-minute-all-allocations-including-closed', callDirection: 'right-to-left',
      rawText: 'not-persisted', ordering: 'file-order-not-capture-time', limits: FD_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > FD_LIMITS.reportBytes) { throw new Error('FD_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'fdleak-report', text);
  const data = Buffer.byteLength(text) <= 1024 * 1024 ? report :
    { ...report, allocation: { ...report.allocation, stacks: undefined }, stacksLocation: 'report-artifact', report: artifact };
  return { exitCode: 3, data, artifacts: [artifact], provenance: { basis: 'log-raw-bytes', captureIdentity: 'unverified' } };
}
