/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { patchSchema, recoverySchema } from './patch-types.js';
import { inspectPatch } from './patch-review.js';
import { applyPatch } from './patch-transaction.js';
import { inspectRecovery, restorePatch, reviewRestore } from './patch-recovery.js';

export function getWorkspaceSpecs(): ToolSpec[] {
  return [
    { ...serviceSpec('workspace.patch', 'Review and apply bounded text changes with old hashes and recovery evidence', patchSchema,
      (input, context) => applyPatch(input, context)), risk: 'R2', idempotency: 'none', evidence: ['diff', 'patch-journal'],
    review: async (input, context) => (await inspectPatch(input, context)).review },
    serviceSpec('workspace.recovery.inspect', 'Inspect file hashes from a patch journal without changing files', recoverySchema,
      async (input, context) => ({ exitCode: 0, data: await inspectRecovery((input as { journalId: string }).journalId, context) }),
      [valueOption('journal-id', 'Patch journal identity')]),
    { ...serviceSpec('workspace.recovery.restore', 'Review a restore diff and refuse conflicting subsequent edits', recoverySchema,
      (input, context) => restorePatch((input as { journalId: string }).journalId, context),
      [valueOption('journal-id', 'Patch journal identity')]), risk: 'R2', idempotency: 'none', evidence: ['diff', 'patch-journal'],
    review: (input, context) => reviewRestore((input as { journalId: string }).journalId, context) },
  ];
}
