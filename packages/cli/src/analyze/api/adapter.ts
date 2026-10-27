/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import { readProblemFile } from '../../problem-package/files.js';
import { digest, privateEvidenceName, saveEvidenceBytes } from '../../quality/evidence.js';
import type { ExecutionContext, ToolResult } from '../../runtime/types.js';
import { ToolProvider } from '../../toolchain/tool-provider.js';
import { parseAPILog } from './log.js';
import { readAPISDK } from './sdk.js';
import { API_LIMITS, type APIReport } from './types.js';

export const apiSchema = z.strictObject({ log: z.string().min(1).max(4096),
  sdkModule: z.string().max(128).regex(/^@ohos\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/)
    .refine(value => !value.endsWith('.d.ts')).optional() });
async function readLog(value: string, context: ExecutionContext): Promise<Buffer> {
  const path = resolve(context.cwd, value);
  try {
    context.abortSignal.throwIfAborted();
    if (!/\.(?:log|txt)$/.test(path) || path.split(sep).some(part => privateEvidenceName.test(part))) { throw new Error('API_INPUT_UNSAFE'); }
    return await readProblemFile(path, API_LIMITS.fileBytes);
  } catch {
    context.abortSignal.throwIfAborted(); throw new Error('API_INPUT_UNSAFE');
  }
}
export async function analyzeAPI(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { log, sdkModule } = apiSchema.parse(input), bytes = await readLog(log, context);
  const parsed = await parseAPILog(bytes, context.abortSignal);
  const byCode: Record<string, number> = {};
  for (const event of parsed.events) { byCode[event.code] = (byCode[event.code] ?? 0) + 1; }
  let sdk: APIReport['sdk'] = null;
  if (sdkModule) {
    try { sdk = await readAPISDK(sdkModule, new Set(parsed.events.map(event => event.code)), await ToolProvider.new(), context.abortSignal); }
    catch (error) {
      context.abortSignal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('API_SDK_')) { throw error; }
      throw new Error('API_SDK_UNAVAILABLE', { cause: error });
    }
  }
  const candidates: APIReport['candidates'] = Object.keys(byCode).map(code => ({ code: Number(code), evidenceLevel: 'single-feature',
    alternatives: ['Validate the exact API, arguments, permission and state against the matching SDK declaration.',
      'Validate service, resource and contemporaneous runtime evidence; an error code alone does not establish an application cause.'] }));
  const report: APIReport = { ...parsed, schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0',
    analyzerVersion: '1.0', generatedAt: new Date().toISOString(), analyzer: 'api', completeness: 'incomplete',
    input: { sha256: digest(bytes), bytes: bytes.length, format: 'hilog-explicit-error-code-subset' }, sdk,
    summary: { eventCount: parsed.events.length, byCode, contextLineCount: parsed.contextLineCount }, candidates,
    checks: { rootCause: 'not-established', captureIdentity: 'unverified', buildIdentity: 'unverified',
      apiAssociation: 'not-established', stateSequence: 'not-analyzed', runtimeVersion: 'unverified', responsibility: 'undetermined' },
    coverage: { rawText: 'not-persisted', sdkMeaning: sdk ? 'declaration-candidates-only' : 'not-requested',
      context: 'line-count-only', domainMeaning: 'not-inferred', limits: API_LIMITS } };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > API_LIMITS.reportBytes) { throw new Error('API_REPORT_LIMIT'); }
  context.abortSignal.throwIfAborted();
  const artifact = await saveEvidenceBytes(context, 'api-report', text);
  return { exitCode: 3, data: report, artifacts: [artifact], provenance: { basis: 'log-raw-bytes', captureIdentity: 'unverified' } };
}
