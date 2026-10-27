/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';

export const contentHash = z.string().regex(/^[a-f0-9]{64}$/);
export const patchSchema = z.strictObject({
  changes: z.array(z.strictObject({
    path: z.string().min(1).max(1024), oldHash: contentHash.nullable(), text: z.string().max(128 * 1024).nullable(),
  })).min(1).max(20),
});
export type PatchInput = z.infer<typeof patchSchema>;
export const snapshotSchema = z.strictObject({
  path: z.string(), oldHash: contentHash.nullable(), text: z.string().nullable(), mode: z.number().int(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const journalSchema = z.strictObject({
  id: z.string().uuid(), projectRoot: z.string(), planId: contentHash,
  phase: z.enum(['applying', 'applied', 'rolled-back', 'recovery-required', 'restored']),
  before: z.array(snapshotSchema), input: patchSchema,
  applied: z.array(z.string()), failures: z.array(z.string()), createdAt: z.iso.datetime(),
});
export type PatchJournal = z.infer<typeof journalSchema>;
export const recoverySchema = z.strictObject({ journalId: z.string().uuid() });
