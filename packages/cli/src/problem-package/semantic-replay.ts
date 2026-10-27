/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { resolve } from 'node:path';
import { ProblemReadSchema, verifiedProblem } from './service.js';
import { readProblemFile } from './files.js';
import { problemHash } from './package.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';

const testId = z.string().regex(/^test[.][a-z0-9][a-z0-9.-]{0,63}$/);
const testRef = z.string().regex(/^test:[a-z0-9][a-z0-9-]{0,63}$/);
export const SemanticStepSchema = z.strictObject({
  kind: z.enum(['action', 'input', 'route', 'wait', 'assert']),
  actionId: testId, dataRef: z.union([testRef, z.literal('')]),
  assertionId: testId, expected: testRef, waitMs: z.number().int().min(1).max(3000),
});
const ManualStepSchema = z.strictObject({
  kind: z.literal('manual'), reason: z.enum(['system-interaction', 'adapter-required']),
});
export const SemanticReplaySchema = z.strictObject({
  version: z.literal('1.0'), buildId: z.string().min(1).max(512),
  steps: z.array(z.union([SemanticStepSchema, ManualStepSchema])).min(1).max(64),
});
export const ReplayPlanSchema = ProblemReadSchema.extend({
  steps: z.string().min(1).max(1024).refine((path) => path.endsWith('.ohmate-replay.json')).optional(),
});

async function readScript(path: string, context: ExecutionContext) {
  const bytes = await readProblemFile(resolve(context.cwd, path), 65536);
  context.abortSignal.throwIfAborted();
  try {
    const parsed = SemanticReplaySchema.safeParse(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
    if (!parsed.success) { throw new Error('REPLAY_SCRIPT_INVALID'); }
    return { script: parsed.data, scriptHash: problemHash(bytes) };
  } catch { throw new Error('REPLAY_SCRIPT_INVALID'); }
}
export async function planReplay(input: z.infer<typeof ReplayPlanSchema>, context: ExecutionContext): Promise<ToolResult> {
  const { result, archiveHash } = await verifiedProblem(input, context, undefined, true);
  if (result.compatibility !== 'compatible' || !result.session) {
    return { exitCode: 3, data: { execution: 'manual-only', replay: 'not-performed', reason: 'manifest-only',
      payloadIntegrity: result.payloadIntegrity, authentication: 'not-restored' } };
  }
  const selected = input.steps ? await readScript(input.steps, context) : undefined;
  if (selected && selected.script.buildId !== result.session.identity.buildId) { throw new Error('REPLAY_BUILD_MISMATCH'); }
  const steps = selected?.script.steps.map((step, index) => ({ ...step, index: index + 1, execution: 'manual',
    reason: step.kind === 'manual' ? step.reason : 'adapter-and-local-build-required' })) ?? [];
  const plan = { archiveHash, scriptHash: selected?.scriptHash ?? null, buildId: result.session.identity.buildId,
    steps, access: 'read-only', authentication: 'not-restored', buildVerification: 'unverified',
    execution: 'manual-only', replay: 'not-performed', reason: selected ? 'adapter-and-local-build-required' : 'semantic-steps-required' };
  context.abortSignal.throwIfAborted();
  return { exitCode: 0, data: { ...plan, planHash: hashContract(plan) } };
}
