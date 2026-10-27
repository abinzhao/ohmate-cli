/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { parseFreezeLog } from './log.js';
import { FREEZE_LIMITS, type FreezeParsed, type FreezeReport } from './types.js';

export const freezeSchema = z.strictObject({ log: z.string().min(1).max(4096) });
async function readLog(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('FREEZE_INPUT_UNSAFE'); }
    return await readProblemFile(path, FREEZE_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted(); throw new Error('FREEZE_INPUT_UNSAFE');
  }
}
function summary(parsed: FreezeParsed): FreezeReport['summary'] {
  const targets = parsed.phases.map(phase => phase.targetTid);
  return { phaseCount: parsed.phases.length, threadCount: parsed.phases.reduce((sum, phase) => sum + phase.threads.length, 0),
    frameCount: parsed.phases.reduce((sum, phase) => sum + phase.threads.reduce((count, thread) => count + thread.frames.length, 0), 0),
    targetStackCount: parsed.phases.filter(phase => phase.targetThreadOrdinal !== null).length,
    sameTargetTid: targets.length < 2 || targets.includes(null) ? null : targets.every(tid => tid === targets[0]) };
}
export async function analyzeFreeze(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log } = freezeSchema.parse(input), bytes = await readLog(log, context);
  const parsed = await parseFreezeLog(bytes, context.abortSignal);
  const candidates: FreezeReport['candidates'] = [{ code: 'freeze-event-declared', evidenceLevel: 'single-feature',
    alternatives: ['A stable waiting chain needs same-target complete stacks, timing and dependency evidence.',
      'Active work or delayed collection needs task progress and contemporaneous system-resource evidence.'] }];
  const resourceNote = "Current fault may be caused by the system's low memory or thermal throttling, you may ignore it and analysis other faults.";
  if (parsed.fields.NOTE?.sha256 === digest(resourceNote)) {
    candidates.push({ code: 'system-warning-declared', evidenceLevel: 'single-feature',
      alternatives: ['A printed NOTE is a warning declaration; contemporaneous CPU, memory and thermal records need validation.',
        'Delayed stack collection or application work may coexist; a warning does not establish responsibility.'] });
  }
  const report: FreezeReport = { ...parsed, schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0',
    analyzerVersion: '1.0', generatedAt: new Date().toISOString(), analyzer: 'freeze', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'oh-appfreeze-event-stack-subset' }, summary: summary(parsed), candidates,
    checks: { systemFactors: 'not-evaluated', threadState: 'undetermined', rootCause: 'not-established', responsibility: 'undetermined',
      sampleAssociation: 'not-performed', symbols: 'not-resolved', captureIdentity: 'unverified', buildIdentity: 'unverified',
      runtimeVersion: 'unverified', queueAnalysis: 'not-performed', binderAnalysis: 'not-performed', buildIdAssociation: 'not-performed' },
    coverage: { basis: 'declared-log-fields-only', rawText: 'not-persisted', supplementaryAnalysis: 'presence-only',
      fingerprintMeaning: 'fault-clustering-hash-not-build-id',
      sampleStacks: parsed.phases.some(phase => phase.sections.some(section => section.name === 'sample-stacks')) ? 'present-unassociated' : 'not-captured',
      callDirection: 'bottom-to-top', pcMeaning: 'relative-or-absolute-unverified', limits: FREEZE_LIMITS } };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > FREEZE_LIMITS.reportBytes) { throw new Error('FREEZE_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'freeze-report', text);
  return { exitCode: 3, data: report, artifacts: [artifact], provenance: { basis: 'log-raw-bytes', captureIdentity: 'unverified' } };
}
