/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { parseCppLog } from './log.js';
import { CPP_LIMITS, type CppReport } from './types.js';

export const cppCrashSchema = z.strictObject({ log: z.string().min(1).max(4096) });
async function readLog(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('CPPCRASH_INPUT_UNSAFE'); }
    return await readProblemFile(path, CPP_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted(); throw new Error('CPPCRASH_INPUT_UNSAFE');
  }
}
export async function analyzeCppCrash(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log } = cppCrashSchema.parse(input), bytes = await readLog(log, context);
  const parsed = await parseCppLog(bytes, context.abortSignal);
  const report: CppReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'cppcrash', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'oh-cppcrash-native-stack-subset' },
    signal: parsed.signal, thread: parsed.thread, fields: parsed.fields, fieldSources: parsed.fieldSources, frames: parsed.frames,
    summary: { frameCount: parsed.frames.length, declaredFunctionCount: parsed.frames.filter(frame => frame.functionSha256 !== null).length,
      declaredBuildIdCount: parsed.frames.filter(frame => frame.buildId !== null).length,
      unknownLocationCount: parsed.frames.filter(frame => frame.unknownLocation).length },
    candidates: [{ code: 'native-signal-declared', evidenceLevel: 'single-feature',
      alternatives: ['Signal delivery or an access contract needs instruction, mapping and reproduction evidence.',
        'Earlier memory corruption or lifetime failure needs first-site or detector evidence; the final frame is not its owner.'] }],
    checks: { captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      rootCause: 'not-established', symbols: 'not-resolved', applicationOwnership: 'not-established',
      registerAnalysis: 'not-performed', buildIdAssociation: 'not-performed', detectorAnalysis: 'not-performed' },
    coverage: { basis: 'declared-log-fields-only', missingFields: parsed.missingFields, sections: parsed.sections, ignoredLines: parsed.ignoredLines,
      fingerprintMeaning: 'fault-clustering-hash-not-build-id', rawText: 'not-persisted', supplementaryAnalysis: 'presence-only',
      callDirection: 'bottom-to-top', pcMeaning: 'relative-or-absolute-unverified', functionMeaning: 'raw-declared-not-symbol-verified', limits: CPP_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > CPP_LIMITS.reportBytes) { throw new Error('CPPCRASH_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'cppcrash-report', text);
  return { exitCode: 3, data: report, artifacts: [artifact], provenance: { basis: 'log-raw-bytes', captureIdentity: 'unverified' } };
}
