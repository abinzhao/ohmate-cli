/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { HashSchema, IdentifierSchema, IdentitySchema } from './domain-schemas.js';

export const MAX_WRITE_COMMANDS = 256;
export const MAX_WRITE_TTL_MS = 600000;
export const WriteScopeSchema = z.enum([
  'network.body.capture', 'network.mock', 'arkweb.resources.override',
  'arkweb.console.execute', 'arkweb.storage.write', 'ui.highlight', 'ui.replay',
]);
const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const WriteCommandSchema = z.strictObject({
  type: z.literal('write-command'), version: z.literal('1'),
  commandId: z.string().uuid(), idempotencyKey: z.string().uuid(),
  identity: IdentitySchema, sessionEpoch: z.string().uuid(), scope: WriteScopeSchema,
  targetId: IdentifierSchema, planHash: HashSchema, payloadHash: HashSchema,
  deadline: time, ttlMs: z.number().int().min(1).max(MAX_WRITE_TTL_MS),
});
export const WriteReceiptSchema = z.strictObject({
  type: z.literal('write-receipt'), version: z.literal('1'), executor: z.literal('application'),
  commandId: z.string().uuid().nullable(), idempotencyKey: z.string().uuid().nullable(),
  identity: IdentitySchema, sessionEpoch: z.string().uuid(), scope: WriteScopeSchema.nullable(),
  targetId: IdentifierSchema.nullable(), impactHash: HashSchema.nullable(),
  status: z.enum(['blocked', 'running', 'applied', 'failed', 'cancelled']),
  revocation: z.enum(['not-needed', 'active', 'revoked', 'cleanup-failed']),
  error: z.string().regex(/^[A-Z][A-Z_]{0,63}$/).nullable(),
});
export const WriteRevokeReasonSchema = z.enum([
  'disconnected', 'background', 'build-changed', 'page-changed', 'locked', 'service-closed', 'expired',
]);
export type WriteCommand = z.infer<typeof WriteCommandSchema>;
export type WriteReceipt = z.infer<typeof WriteReceiptSchema>;
export type WriteScope = z.infer<typeof WriteScopeSchema>;
export type WriteRevokeReason = z.infer<typeof WriteRevokeReasonSchema>;

export function writeRequiresRollback(scope: WriteScope): boolean {
  return scope !== 'arkweb.console.execute';
}
