/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { link, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalState } from '../agent/local-state.js';
import { sha256 } from '../agent/context-files.js';
import { InputInvalidError, type ExecutionContext, type ToolResult } from '../runtime/types.js';
import { patchPath } from './path-guard.js';
import { inspectPatch, readSnapshot } from './patch-review.js';
import { journalSchema, type PatchJournal, type Snapshot } from './patch-types.js';

async function atomicWrite(context: ExecutionContext, change: Snapshot, expected: string | null): Promise<void> {
  const file = await patchPath(context.projectRoot ?? context.cwd, change.path, context.dataDir);
  if (change.text === null) {
    if ((await readSnapshot(context, change.path)).oldHash !== expected) { throw new Error(`Patch conflict: ${change.path}`); }
    await unlink(file); return;
  }
  const temporary = join(dirname(file), `.ohmate-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(change.text); await handle.chmod(change.mode); await handle.sync(); }
    finally { await handle.close(); }
    if ((await readSnapshot(context, change.path)).oldHash !== expected) { throw new Error(`Patch conflict: ${change.path}`); }
    if (expected === null) { await link(temporary, file); }
    else { await rename(temporary, file); }
  } finally {
    await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } });
  }
}

function changedSnapshot(journal: PatchJournal, index: number): Snapshot {
  const change = journal.input.changes[index];
  return { ...journal.before[index], text: change.text, oldHash: change.text === null ? null : sha256(change.text) };
}
async function save(context: ExecutionContext, journal: PatchJournal): Promise<void> {
  await new LocalState(context.dataDir).update(`patch-${journal.id}`, journalSchema, journal, () => journal);
}
async function notify(context: ExecutionContext, type: string, payload: unknown): Promise<void> {
  await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, time: new Date().toISOString(), type, payload });
}
async function rollback(context: ExecutionContext, journal: PatchJournal): Promise<string[]> {
  const failures: string[] = [];
  for (const path of [...journal.applied].reverse()) {
    const index = journal.before.findIndex((entry) => entry.path === path);
    try { await atomicWrite(context, journal.before[index], changedSnapshot(journal, index).oldHash); }
    catch { failures.push(path); }
  }
  return failures;
}
async function receipt(context: ExecutionContext, journal: PatchJournal, exitCode: ToolResult['exitCode'], code: string): Promise<ToolResult> {
  const path = join(new LocalState(context.dataDir).root, `patch-evidence-${journal.id}-${journal.phase}.json`);
  const content = JSON.stringify(journalSchema.parse(journal));
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  return { exitCode, data: { code, journalId: journal.id, phase: journal.phase, planId: journal.planId,
    files: journal.input.changes.map((change, index) => ({
      path: change.path, oldHash: change.oldHash, newHash: changedSnapshot(journal, index).oldHash,
    })), failures: journal.failures, recovery: `ohmatecli workspace recovery inspect --journal-id ${journal.id}` },
  artifacts: [{ path, kind: 'patch-journal', sha256: sha256(content) }] };
}

export async function applyPatch(input: unknown, context: ExecutionContext, createModes: Record<string, number> = {}): Promise<ToolResult> {
  const prepared = await inspectPatch(input, context);
  for (const snapshot of prepared.before) {
    if (snapshot.text === null && createModes[snapshot.path] !== undefined) { snapshot.mode = createModes[snapshot.path]; }
  }
  const journal: PatchJournal = { id: randomUUID(), projectRoot: context.projectRoot ?? context.cwd,
    planId: context.policy.approvedPlan!, phase: 'applying', input: prepared.input, before: prepared.before,
    applied: [], failures: [], createdAt: new Date().toISOString() };
  await save(context, journal);
  try {
    for (let index = 0; index < journal.before.length; index++) {
      context.abortSignal.throwIfAborted();
      const change = changedSnapshot(journal, index);
      await atomicWrite(context, change, journal.before[index].oldHash);
      journal.applied.push(change.path);
      if ((await readSnapshot(context, change.path)).oldHash !== change.oldHash) { throw new Error(`Patch verification failed: ${change.path}`); }
      await save(context, journal);
      await notify(context, 'patch.file.applied', { journalId: journal.id, path: change.path, hash: change.oldHash });
    }
    context.abortSignal.throwIfAborted();
    journal.phase = 'applied'; await save(context, journal);
    return await receipt(context, journal, 0, 'PATCH_APPLIED');
  } catch (error) {
    journal.failures = await rollback(context, journal);
    journal.phase = journal.failures.length ? 'recovery-required' : 'rolled-back';
    await save(context, journal);
    return { ...await receipt(context, journal, context.abortSignal.aborted ? 130 : 6,
      journal.failures.length ? 'PATCH_RECOVERY_REQUIRED' : 'PATCH_ROLLED_BACK'),
    warnings: [{ code: 'PATCH_INTERRUPTED', message: error instanceof Error ? error.message : 'Patch cancelled' }] };
  }
}

export async function readJournal(context: ExecutionContext, id: string): Promise<PatchJournal> {
  try {
    const journal = await new LocalState(context.dataDir).read(`patch-${id}`, journalSchema);
    if (journal.id !== id || journal.projectRoot !== (context.projectRoot ?? context.cwd) ||
      journal.before.length !== journal.input.changes.length || journal.before.some((entry, index) =>
        entry.path !== journal.input.changes[index].path || entry.oldHash !== journal.input.changes[index].oldHash ||
        entry.oldHash !== (entry.text === null ? null : sha256(entry.text)))) { throw new Error('Journal integrity or project scope mismatch'); }
    return journal;
  } catch (error) { throw new InputInvalidError(error instanceof Error ? error.message : String(error)); }
}
