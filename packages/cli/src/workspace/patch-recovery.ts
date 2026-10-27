/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { LocalState } from '../agent/local-state.js';
import { sha256 } from '../agent/context-files.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { applyPatch, readJournal } from './patch-transaction.js';
import { inspectPatch, readSnapshot } from './patch-review.js';
import { journalSchema, type PatchInput } from './patch-types.js';

export async function inspectRecovery(id: string, context: ExecutionContext) {
  const journal = await readJournal(context, id);
  const files = [];
  for (let index = 0; index < journal.before.length; index++) {
    const current = await readSnapshot(context, journal.before[index].path);
    const change = journal.input.changes[index], nextHash = change.text === null ? null : sha256(change.text);
    files.push({ path: current.path, currentHash: current.oldHash, originalHash: change.oldHash, appliedHash: nextHash,
      state: current.oldHash === change.oldHash ? 'original' : current.oldHash === nextHash ? 'applied' : 'conflict' });
  }
  return { journalId: id, phase: journal.phase, projectRoot: journal.projectRoot, files };
}

async function restoreInput(id: string, context: ExecutionContext) {
  try {
    const journal = await readJournal(context, id), inspection = await inspectRecovery(id, context);
    if (inspection.files.some((file) => file.state === 'conflict')) { throw new Error('Recovery conflicts with subsequent edits; review manually'); }
    const changes: PatchInput['changes'] = inspection.files.filter((file) => file.state === 'applied').map((file) => ({
      path: file.path, oldHash: file.currentHash, text: journal.before.find((entry) => entry.path === file.path)!.text,
    }));
    if (!changes.length) { throw new Error('Journal has no outstanding writes to restore'); }
    return { journal, input: { changes }, modes: Object.fromEntries(journal.before.map((entry) => [entry.path, entry.mode])) };
  } catch (error) { throw new InputInvalidError(error instanceof Error ? error.message : String(error)); }
}

export async function reviewRestore(id: string, context: ExecutionContext) {
  const { input, modes } = await restoreInput(id, context);
  return { restoresJournal: id, ...(await inspectPatch(input, context)).review, modes };
}

export async function restorePatch(id: string, context: ExecutionContext) {
  const { journal, input, modes } = await restoreInput(id, context);
  const result = await applyPatch(input, context, modes);
  if (result.exitCode === 0) {
    journal.phase = 'restored';
    await new LocalState(context.dataDir).update(`patch-${id}`, journalSchema, undefined, () => journal);
  }
  return { ...result, data: { ...(result.data as object), restoresJournal: id } };
}
