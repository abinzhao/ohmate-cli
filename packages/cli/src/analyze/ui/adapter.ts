/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { parseUIEvents, uiSummary } from './parser.js';
import { UI_ANALYSIS_LIMITS, type UIAnalysisReport } from './types.js';

export const uiAnalysisSchema = z.strictObject({ log: z.string().min(1).max(4096) });
async function readInput(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) {
      throw new Error('UI_ANALYSIS_INPUT_UNSAFE');
    }
    return await readProblemFile(path, UI_ANALYSIS_LIMITS.fileBytes);
  } catch { context.abortSignal.throwIfAborted(); throw new Error('UI_ANALYSIS_INPUT_UNSAFE'); }
}
export async function analyzeUI(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const request = uiAnalysisSchema.parse(input), bytes = await readInput(request.log, context);
  const parsed = await parseUIEvents(bytes, context.abortSignal), summary = uiSummary(parsed.events);
  const report: UIAnalysisReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'ui', completeness: 'incomplete', ...parsed, summary,
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'ace-window-lifecycle-5.0.3-subset' },
    candidates: summary.contextRangeEventCount ? [{ code: 'context-id-in-ui-instance-range', evidenceLevel: 'single-feature',
      eventCount: summary.contextRangeEventCount, alternatives: [
        'Validate the UIContext owner and disposal lifetime against the matching application and window evidence.',
        'A scoped instance can still be live; validate intentional scope, process-cache behavior and layout timing before assigning a fault.',
      ] }] : [],
    checks: { rootCause: 'not-established', captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      lifecycleState: 'not-inferred', crossEventAssociation: 'not-performed', responsibility: 'undetermined' },
    coverage: { basis: 'declared-notifications-only', rawText: 'not-persisted', layout: 'not-analyzed', rendering: 'not-analyzed',
      ordering: 'file-order-only', sourceCoordinates: 'declarations-only', limits: UI_ANALYSIS_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > UI_ANALYSIS_LIMITS.reportBytes) { throw new Error('UI_ANALYSIS_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'ui-analysis-report', text);
  return { exitCode: 3, data: report, artifacts: [artifact], provenance: { basis: 'raw-input-bytes', captureIdentity: 'unverified' } };
}
