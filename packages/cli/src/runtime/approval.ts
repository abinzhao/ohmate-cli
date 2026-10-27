/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { toJSONSchema, z } from 'zod';
import { workspaceFingerprint } from './workspace-fingerprint.js';
import { InputInvalidError } from './types.js';
import type { ExecutionContext, Risk, ToolSpec } from './types.js';

const planSchema = z.object({
  planId: z.string().regex(/^[a-f0-9]{64}$/), binding: z.string(),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  usedAt: z.iso.datetime().optional(),
  risk: z.enum(['R0', 'R1', 'R2', 'R3']), tool: z.string(),
  input: z.unknown(), project: z.string(), recovery: z.string(),
  review: z.unknown().optional(),
});
export type ApprovalPlan = z.infer<typeof planSchema>;

async function binding(spec: ToolSpec, input: unknown, risk: Risk, context: ExecutionContext, review?: unknown): Promise<string> {
  return createHash('sha256').update(JSON.stringify({
    tool: spec.id, schema: toJSONSchema(spec.inputSchema), input, risk,
    version: process.env.npm_package_version ?? '0.1.0', workspace: context.workspaceId,
    target: context.target, fingerprint: await workspaceFingerprint(context.projectRoot ?? context.cwd, context.dataDir),
    review,
  })).digest('hex');
}

async function directory(context: ExecutionContext): Promise<string> {
  const path = join(context.dataDir, 'plans');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Unsafe approval directory'); }
  return path;
}

export async function createApproval(spec: ToolSpec, input: unknown, risk: Risk, context: ExecutionContext): Promise<ApprovalPlan> {
  const review = await spec.review?.(input, context);
  const digest = await binding(spec, input, risk, context, review), now = Date.now();
  const plan: ApprovalPlan = {
    planId: createHash('sha256').update(`${digest}:${randomUUID()}`).digest('hex'), binding: digest,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(),
    risk, tool: spec.id, input, project: context.projectRoot ?? context.cwd, recovery: spec.recovery,
    ...(review === undefined ? {} : { review }),
  };
  if (Buffer.byteLength(JSON.stringify(plan)) > 1024 * 1024) { throw new InputInvalidError('Approval plan exceeds 1 MiB'); }
  const handle = await open(join(await directory(context), `${plan.planId}.json`), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(plan)); await handle.sync(); }
  finally { await handle.close(); }
  return plan;
}

export async function validApproval(spec: ToolSpec, input: unknown, risk: Risk, context: ExecutionContext): Promise<boolean> {
  const id = context.policy.approvedPlan;
  if (!id || !/^[a-f0-9]{64}$/.test(id)) { return false; }
  try {
    const handle = await open(join(context.dataDir, 'plans', `${id}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let plan: ApprovalPlan;
    try {
      if ((await handle.stat()).size > 1024 * 1024) { return false; }
      plan = planSchema.parse(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
    const review = await spec.review?.(input, context);
    return plan.planId === id && !plan.usedAt && Date.parse(plan.expiresAt) > Date.now() &&
      plan.binding === await binding(spec, input, risk, context, review) &&
      JSON.stringify(plan.review) === JSON.stringify(review);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof z.ZodError || error instanceof InputInvalidError) { return false; }
    throw error;
  }
}

export async function consumeApproval(context: ExecutionContext): Promise<void> {
  const id = context.policy.approvedPlan;
  if (!id || !/^[a-f0-9]{64}$/.test(id)) { throw new Error('Invalid approval plan'); }
  const handle = await open(join(context.dataDir, 'plans', `${id}.json`), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const plan = planSchema.parse(JSON.parse(await handle.readFile('utf8')));
    if (plan.usedAt) { throw new Error('Approval plan has already been used'); }
    const content = JSON.stringify({ ...plan, usedAt: new Date().toISOString() });
    await handle.truncate(0);
    await handle.write(content, 0, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}
