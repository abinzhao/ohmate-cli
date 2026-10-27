/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { analyzeUI } from '../ui/adapter.js';
import { analyzeGC } from '../gc/adapter.js';
import { analyzeAPI } from '../api/adapter.js';
import { analyzeJSCrash } from '../jscrash/adapter.js';
import { analyzeCppCrash } from '../cppcrash/adapter.js';
import { analyzeFreeze } from '../freeze/adapter.js';
import { analyzeFDLeak } from '../fdleak/adapter.js';
import { analyzeNativeLeak } from '../nativeleak/adapter.js';
import { classifyLog } from './classify.js';
import { AUTO_LIMITS, type AutoFamily, type AutoReport } from './types.js';

export const autoSchema = z.strictObject({ log: z.string().min(1).max(4096) });
const dispatch: Record<AutoFamily, (input: unknown, context: ExecutionContext) => Promise<ToolResult>> = {
  ui: (...args) => analyzeUI(...args), gc: (...args) => analyzeGC(...args), api: (...args) => analyzeAPI(...args),
  jscrash: (...args) => analyzeJSCrash(...args), cppcrash: (...args) => analyzeCppCrash(...args),
  freeze: (...args) => analyzeFreeze(...args), fdleak: (...args) => analyzeFDLeak(...args), nativeleak: (...args) => analyzeNativeLeak(...args),
};
async function readInput(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('AUTO_INPUT_UNSAFE'); }
    return await readProblemFile(path, AUTO_LIMITS.fileBytes);
  } catch { context.abortSignal.throwIfAborted(); throw new Error('AUTO_INPUT_UNSAFE'); }
}
const inputBinding = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() });
const selectedReport = z.object({ analyzer: z.string(), completeness: z.literal('incomplete'),
  input: inputBinding.optional(), inputs: z.array(inputBinding.passthrough()).optional() }).passthrough();
async function validatedAnalysis(family: AutoFamily, log: string, bytes: Buffer, context: ExecutionContext): Promise<unknown> {
  const stage = await mkdtemp(join(tmpdir(), 'ohmate-auto-stage-'));
  try {
    let result: ToolResult;
    try {
      result = await dispatch[family](family === 'nativeleak' ? { sample: log } : { log },
        { ...context, artifactStore: { root: stage } });
    } catch { context.abortSignal.throwIfAborted(); throw new Error('AUTO_ANALYZER_REJECTED'); }
    context.abortSignal.throwIfAborted();
    if (result.exitCode !== 3 || result.artifacts?.length !== 1) { throw new Error('AUTO_ANALYZER_REJECTED'); }
    const artifact = result.artifacts[0];
    if (resolve(artifact.path).slice(0, stage.length + 1) !== stage + sep) { throw new Error('AUTO_ANALYZER_REJECTED'); }
    const raw = await readProblemFile(artifact.path, AUTO_LIMITS.selectedReportBytes);
    if (digest(raw) !== artifact.sha256) { throw new Error('AUTO_DERIVED_CHANGED'); }
    const report = selectedReport.parse(JSON.parse(raw.toString('utf8')));
    const binding = family === 'nativeleak' ? report.inputs?.[0] : report.input;
    if (report.analyzer !== family || binding?.sha256 !== digest(bytes) || binding.bytes !== bytes.length) { throw new Error('AUTO_INPUT_CHANGED'); }
    return report;
  } finally { await rm(stage, { recursive: true }); }
}
export async function analyzeAuto(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log } = autoSchema.parse(input), bytes = await readInput(log, context), classification = await classifyLog(bytes, context.abortSignal);
  const selection = classification.length === 1 ? classification[0].analyzer : null;
  const analysis = selection === null ? null : await validatedAnalysis(selection, log, bytes, context);
  const report: AutoReport = {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0', analyzerVersion: '1.0',
    generatedAt: new Date().toISOString(), analyzer: 'auto', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'bounded-log-triage-subset' }, classification, selection, analysis,
    checks: { rootCause: 'not-established', captureIdentity: 'unverified', buildIdentity: 'unverified', runtimeVersion: 'unverified',
      crossAnalyzerAssociation: 'not-performed', classification: 'markers-not-capture-authentication' },
    coverage: { selectedParser: selection === null ? 'not-dispatched' : 'validated-subset', ambiguousInputs: 'manual-domain-selection',
      rawText: 'not-persisted', snapshots: 'not-supported', attachments: 'not-discovered', limits: AUTO_LIMITS },
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > AUTO_LIMITS.reportBytes) { throw new Error('AUTO_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'auto-report', text);
  const data = Buffer.byteLength(text) <= AUTO_LIMITS.receiptDataBytes ? report :
    { ...report, analysis: { analyzer: selection, completeness: 'incomplete' }, analysisLocation: 'report-artifact', report: artifact };
  return { exitCode: 3, data, artifacts: [artifact], provenance: { basis: 'raw-input-bytes', captureIdentity: 'unverified' } };
}
