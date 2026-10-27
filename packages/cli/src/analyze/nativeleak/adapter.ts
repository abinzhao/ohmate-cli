/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { parseNativeSample } from './sample.js';
import { parseNativeSmaps } from './smaps.js';
import { NATIVELEAK_LIMITS, type NativeLeakReport } from './types.js';

export const nativeLeakSchema = z.strictObject({
  sample: z.string().min(1).max(4096), smaps: z.string().min(1).max(4096).optional(),
});
async function readInput(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) {
      throw new Error('NATIVELEAK_INPUT_UNSAFE');
    }
    return await readProblemFile(path, NATIVELEAK_LIMITS.fileBytes);
  } catch { context.abortSignal.throwIfAborted(); throw new Error('NATIVELEAK_INPUT_UNSAFE'); }
}
export async function analyzeNativeLeak(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const request = nativeLeakSchema.parse(input), bytes = await readInput(request.sample, context);
  const sample = await parseNativeSample(bytes, context.abortSignal);
  let smaps: NativeLeakReport['smaps'] = null;
  const inputs: NativeLeakReport['inputs'] = [{ role: 'sample', sha256: digest(bytes), bytes: bytes.length,
    format: 'hiview-native-sample-5.0.3-subset' }];
  if (request.smaps) {
    const mapsBytes = await readInput(request.smaps, context);
    if (bytes.length + mapsBytes.length > NATIVELEAK_LIMITS.totalBytes) { throw new Error('NATIVELEAK_INPUT_LIMIT'); }
    smaps = await parseNativeSmaps(mapsBytes, context.abortSignal);
    inputs.push({ role: 'smaps', sha256: digest(mapsBytes), bytes: mapsBytes.length, format: 'hidumper-smaps-table-5.0.3-subset' });
  }
  const report: NativeLeakReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'nativeleak', completeness: 'incomplete', inputs, sample, smaps,
    candidates: [{ evidenceLevel: 'single-feature', alternatives: [
      'Validate allocation and release lifetimes in a matching native hook or profiler capture; memory growth alone does not establish a leak.',
      'Validate workload, cache policy, baseline and sampling effects before assigning responsibility.',
    ] }],
    checks: { rootCause: 'not-established', leakDiagnosis: 'not-established', captureIdentity: 'unverified',
      buildIdentity: 'unverified', runtimeVersion: 'unverified', crossInputAssociation: 'not-performed',
      allocationLifetime: 'not-analyzed', responsibility: 'undetermined' },
    coverage: { rawText: 'not-persisted', basis: 'declared-fields-only', sampleMetric: 'rss-and-pss-mixed-unidentified',
      summaryPss: 'includes-swap-pss', rowUnits: 'KiB-except-counts', time: 'declared-monotonic-seconds-realtime-hash-only',
      memoryDomain: 'mixed-rss-and-pss-plus-swap-pss', dma: 'not-captured', gpu: 'not-captured',
      names: 'classification-candidates-only', htraceNmdNativeHook: 'not-analyzed', symbols: 'not-requested', limits: NATIVELEAK_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > NATIVELEAK_LIMITS.reportBytes) { throw new Error('NATIVELEAK_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'nativeleak-report', text);
  return { exitCode: 3, data: report, artifacts: [artifact], provenance: { basis: 'raw-input-bytes', captureIdentity: 'unverified' } };
}
