/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { parseJSLog } from './log.js';
import { JS_LIMITS, type JSReport } from './types.js';

export const jsCrashSchema = z.strictObject({ log: z.string().min(1).max(4096) });
async function readLog(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('JSCRASH_INPUT_UNSAFE'); }
    return await readProblemFile(path, JS_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted(); throw new Error('JSCRASH_INPUT_UNSAFE');
  }
}
export async function analyzeJSCrash(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log } = jsCrashSchema.parse(input), bytes = await readLog(log, context);
  const parsed = await parseJSLog(bytes, context.abortSignal);
  const report: JSReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'jscrash', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'oh-jscrash-js-stack-subset' },
    error: parsed.error, fields: parsed.fields, fieldSources: parsed.fieldSources, frames: parsed.frames,
    summary: { frameCount: parsed.frames.length, numberedFrameCount: parsed.frames.filter(frame => frame.declaredIndex !== null).length,
      releaseFormCount: parsed.frames.filter(frame => frame.locationForm === 'release-module-path').length },
    candidates: [{ code: 'js-error-declared', evidenceLevel: 'single-feature',
      alternatives: ['Application input, state or lifetime contract needs source and reproduction evidence.',
        'Framework or SDK exception propagation needs call-contract and matching build evidence.'] }],
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      rootCause: 'not-established', sourceMap: 'not-resolved', errorCodeMeaning: 'not-mapped',
      applicationOwnership: 'not-established', snapshotAssociation: 'not-performed' },
    coverage: { basis: 'declared-log-fields-only', missingFields: parsed.missingFields, sections: parsed.sections,
      rawStackDeclared: parsed.rawStackDeclared, ignoredLines: parsed.ignoredLines,
      fingerprintMeaning: 'fault-clustering-hash-not-build-id', rawText: 'not-persisted',
      supplementaryAnalysis: 'presence-only', callDirection: 'bottom-to-top',
      coordinates: 'raw-declared-not-source-verified', limits: JS_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > JS_LIMITS.reportBytes) { throw new Error('JSCRASH_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'jscrash-report', text);
  return { exitCode: 3, data: report, artifacts: [artifact], provenance: { basis: 'log-raw-bytes', captureIdentity: 'unverified' } };
}
