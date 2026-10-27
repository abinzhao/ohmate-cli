/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { LocalState } from '../agent/local-state.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { readProject, type ProjectModel } from '../project-model/index.js';
import { unifiedDiff } from '../workspace/patch-review.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { digest, evidenceFile, saveEvidence, saveEvidenceBytes } from './evidence.js';
import { publishBuildFile, removeBuildFile, replaceBuildFile } from './build-file-transaction.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cacheSchema = z.strictObject({
  compileConfig: z.record(z.string(), z.string()), patchConfig: z.record(z.string(), z.string()),
});
const journalSchema = z.strictObject({
  id: z.uuid(), projectRoot: z.string(), planId: hash, phase: z.enum(['removing', 'removed', 'restored', 'recovery-required']),
  files: z.array(z.strictObject({ path: z.string(), sha256: hash, mode: z.number().int().min(0).max(0o777),
    heldPath: z.string().optional(), heldPaths: z.array(z.string()).max(32).default([]),
    backup: z.strictObject({ path: z.string(), sha256: hash, kind: z.literal('build-cache-backup') }) })),
});
export const cacheRecoverySchema = z.strictObject({ journalId: z.uuid() });
type Journal = z.infer<typeof journalSchema>;
const cachePaths = (model: ProjectModel) => model.modules.map((item) =>
  relative(model.root, join(item.path, 'build/config/buildConfig.json')).split('\\').join('/'));

async function cacheSnapshot(path: string, context: ExecutionContext) {
  const root = context.projectRoot ?? context.cwd, file = join(root, path);
  const info = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
  });
  if (!info) { return null; }
  const before = await evidenceFile(root, file);
  if (before.size > 128 * 1024) { throw new InputInvalidError('Quickfix cache exceeds 128 KiB'); }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile(), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (digest(bytes) !== before.sha256 || (await evidenceFile(root, file)).sha256 !== before.sha256) {
      throw new InputInvalidError('Quickfix cache changed while reading');
    }
    assertPublicValue(text); cacheSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
    return { path, text, sha256: before.sha256, mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}
export async function prepareCacheCleanup(model: ProjectModel, context: ExecutionContext) {
  const files = [];
  for (const path of cachePaths(model)) {
    const file = await cacheSnapshot(path, context);
    if (file) { files.push(file); }
  }
  return files;
}
export function cacheCleanupReview(files: Awaited<ReturnType<typeof prepareCacheCleanup>>) {
  return { files: files.map(({ path, sha256, text }) => ({ path, oldHash: sha256, newHash: null,
    diff: unifiedDiff(path, text, null) })), recovery: 'explicit hash-checked cache restoration' };
}
async function saveJournal(journal: Journal, context: ExecutionContext) {
  await new LocalState(context.dataDir).update(`build-cache-${journal.id}`, journalSchema, journal, () => journal);
}
function trackedContext(journal: Journal, context: ExecutionContext): ExecutionContext {
  return { ...context, eventSink: async (event) => {
    const payload = event.payload as { path: string; heldPath: string };
    const file = journal.files.find((item) => item.path === payload.path);
    if (file && event.type === 'build.file.before-displace') {
      file.heldPaths = [...new Set([...file.heldPaths, ...file.heldPath ? [file.heldPath] : [], payload.heldPath])];
      file.heldPath = payload.heldPath; await saveJournal(journal, context);
    }
    await context.eventSink(event);
  } };
}
export async function removeBuildCache(files: Awaited<ReturnType<typeof prepareCacheCleanup>>, context: ExecutionContext) {
  if (!files.length) { return null; }
  const journal: Journal = { id: randomUUID(), projectRoot: context.projectRoot ?? context.cwd,
    planId: context.policy.approvedPlan!, phase: 'removing', files: [] };
  for (const file of files) {
    const backup = await saveEvidenceBytes(context, 'build-cache-backup', file.text);
    journal.files.push({ path: file.path, sha256: file.sha256, mode: file.mode, heldPaths: [], backup: { ...backup, kind: 'build-cache-backup' } });
  }
  await saveJournal(journal, context);
  let failure: string | null = null;
  try {
    for (const file of files) {
      context.abortSignal.throwIfAborted();
      if ((await cacheSnapshot(file.path, context))?.sha256 !== file.sha256) { throw new InputInvalidError('Quickfix cache cleanup conflict'); }
      await removeBuildFile(trackedContext(journal, context), file.path, file.sha256);
      await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, time: new Date().toISOString(),
        type: 'build.cache.removed', payload: { journalId: journal.id, path: file.path, originalHash: file.sha256 } });
    }
    journal.phase = 'removed';
  } catch (error) {
    journal.phase = 'recovery-required'; failure = error instanceof Error ? error.message : 'Cache cleanup interrupted';
  }
  await saveJournal(journal, context);
  return { journalId: journal.id, state: journal.phase, files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    failure, artifacts: [...journal.files.map((file) => file.backup), await saveEvidence(context, 'build-cache-journal', journal)] };
}
async function readJournal(id: string, context: ExecutionContext) {
  const journal = await new LocalState(context.dataDir).read(`build-cache-${id}`, journalSchema);
  const model = await readProject(context.projectRoot ?? context.cwd), allowed = new Set(cachePaths(model));
  if (journal.id !== id || journal.projectRoot !== model.root || journal.files.some((item) => !allowed.has(item.path)) ||
    new Set(journal.files.map((file) => file.path)).size !== journal.files.length) { throw new InputInvalidError('Cache recovery scope mismatch'); }
  if (journal.files.some((file) => displacedPaths(file).some((path) => !path.startsWith(`${file.path}.ohmate-`) ||
    !path.endsWith('.held') || !z.uuid().safeParse(path.slice(`${file.path}.ohmate-`.length, -5)).success))) {
    throw new InputInvalidError('Unsafe displaced cache path');
  }
  return journal;
}
function displacedPaths(file: Journal['files'][number]) {
  return [...new Set([...file.heldPath ? [file.heldPath] : [], ...file.heldPaths])];
}
async function heldCaches(file: Journal['files'][number], context: ExecutionContext) {
  const held = [];
  for (const path of displacedPaths(file)) {
    const evidence = await evidenceFile(context.projectRoot ?? context.cwd, join(context.projectRoot ?? context.cwd, path)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
    });
    if (evidence) { held.push(evidence); }
  }
  return held;
}
async function backupText(file: Journal['files'][number], context: ExecutionContext) {
  const evidence = await evidenceFile(context.artifactStore.root, file.backup.path);
  if (evidence.sha256 !== file.sha256 || evidence.sha256 !== file.backup.sha256) { throw new InputInvalidError('Cache backup hash mismatch'); }
  const handle = await open(file.backup.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile();
    if (bytes.length > 128 * 1024 || digest(bytes) !== file.sha256) { throw new InputInvalidError('Invalid cache backup'); }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    assertPublicValue(text); cacheSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
    return text;
  } finally { await handle.close(); }
}
export async function inspectCacheRestore(id: string, context: ExecutionContext) {
  const journal = await readJournal(id, context), files = [];
  for (const file of journal.files) {
    const current = await cacheSnapshot(file.path, context);
    const held = await heldCaches(file, context);
    await backupText(file, context);
    files.push({ path: file.path, originalHash: file.sha256, currentHash: current?.sha256 ?? null, heldHash: held[0]?.sha256 ?? null,
      heldPaths: held.map(({ path, sha256 }) => ({ path, sha256 })),
      currentMode: current?.mode ?? null, originalMode: file.mode,
      state: held.some((entry) => entry.sha256 !== file.sha256) ? 'conflict' : !current ? 'removed' : current.sha256 !== file.sha256 ? 'conflict'
        : current.mode !== file.mode ? 'permissions' : held.length ? 'pending-cleanup' : 'original' });
  }
  return { journalId: id, phase: journal.phase, files };
}
export async function reviewCacheRestore(id: string, context: ExecutionContext) {
  const inspection = await inspectCacheRestore(id, context);
  if (inspection.files.some((file) => file.state === 'conflict') || inspection.files.every((file) => file.state === 'original')) {
    throw new InputInvalidError('Cache restoration conflicts or has no outstanding changes');
  }
  const journal = await readJournal(id, context), files = [];
  for (const file of journal.files) {
    const item = inspection.files.find((item) => item.path === file.path)!;
    if (item.state === 'original') { continue; }
    const text = await backupText(file, context);
    files.push({ path: file.path, oldHash: item.currentHash, newHash: file.sha256, oldMode: item.currentMode, mode: file.mode,
      heldPaths: item.heldPaths,
      state: item.state, diff: item.state === 'permissions' ? `old mode ${item.currentMode!.toString(8)}\nnew mode ${file.mode.toString(8)}\n`
        : item.state === 'removed' ? unifiedDiff(file.path, null, text) : `Remove verified displaced originals ${item.heldPaths.map((entry) => entry.path).join(', ')}\n` });
  }
  return { journalId: id, files };
}
export async function restoreBuildCache(id: string, context: ExecutionContext) {
  const review = await reviewCacheRestore(id, context), journal = await readJournal(id, context);
  for (const { path, state } of review.files) {
    const file = journal.files.find((item) => item.path === path)!, parent = dirname(join(journal.projectRoot, path));
    if (await realpath(parent) !== parent) { throw new InputInvalidError('Unsafe cache restoration parent'); }
    const text = await backupText(file, context);
    if (state === 'removed') { await publishBuildFile(context, path, text, file.mode); }
    else if (state === 'permissions') { await replaceBuildFile(trackedContext(journal, context), path, text, file.sha256, file.mode); }
    await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, time: new Date().toISOString(),
      type: 'build.cache.published', payload: { journalId: id, path, originalHash: file.sha256, mode: file.mode } });
    const current = await cacheSnapshot(path, context);
    if (current?.sha256 !== file.sha256 || current.mode !== file.mode) { throw new Error('Cache restore verification failed'); }
    const held = await heldCaches(file, context);
    if (held.some((entry) => entry.sha256 !== file.sha256)) { throw new InputInvalidError('Displaced cache changed during recovery'); }
    for (const entry of held) { await unlink(join(journal.projectRoot, entry.path)); }
  }
  journal.phase = 'restored'; await saveJournal(journal, context);
  return { exitCode: 0 as const, data: { journalId: id, state: 'restored', files: review.files },
    artifacts: [await saveEvidence(context, 'build-cache-journal', journal)] };
}
