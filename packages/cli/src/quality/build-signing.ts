/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import { LocalState } from '../agent/local-state.js';
import { findSpan, parseSpans } from '../project-config/json5-spans.js';
import type { Project } from '../utils/project.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { digest, evidenceFile, saveEvidence } from './evidence.js';
import { publishBuildFile, replaceBuildFile } from './build-file-transaction.js';

const nameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const heldPathSchema = z.string().regex(/^build-profile\.json5\.ohmate-[a-f0-9-]{36}\.held$/);
const journalSchema = z.strictObject({
  id: z.uuid(), projectRoot: z.string(), planId: hashSchema, product: nameSchema,
  phase: z.enum(['applying', 'applied', 'restored', 'recovery-required']),
  oldHash: hashSchema, newHash: hashSchema, mode: z.number().int().min(0).max(0o777),
  edit: z.strictObject({ start: z.number().int().nonnegative(), before: z.string().max(256), after: z.string().max(256) }),
  oldReference: nameSchema.nullable(), newReference: nameSchema,
  heldPath: heldPathSchema.optional(), heldPaths: z.array(heldPathSchema).max(32).default([]),
});
type Journal = z.infer<typeof journalSchema>;
export const signingRecoverySchema = z.strictObject({ journalId: z.uuid() });
export class SigningApplyError extends Error {
  constructor(readonly journalId: string, cause: unknown) { super('Signing reference application requires recovery audit', { cause }); }
}

async function profileSnapshot(context: ExecutionContext, name = 'build-profile.json5') {
  const root = context.projectRoot ?? context.cwd, file = join(root, name);
  const before = await evidenceFile(root, file);
  if (before.size > 128 * 1024) { throw new InputInvalidError('Signing profile exceeds 128 KiB'); }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile(), stat = await handle.stat();
    if (digest(bytes) !== before.sha256 || (await evidenceFile(root, file)).sha256 !== before.sha256) {
      throw new InputInvalidError('Signing profile changed during reading');
    }
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      hash: before.sha256, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}
export async function prepareSigning(project: Project, product: string, requested: string | undefined, context: ExecutionContext) {
  const snapshot = await profileSnapshot(context), tree = parseSpans(snapshot.text);
  const index = project.profile.app.products.findIndex((item) => item.name === product);
  if (index < 0) { throw new InputInvalidError('Signing requires a declared product'); }
  const field = ['app', 'products', index, 'signingConfig'];
  const parent = findSpan(tree, field.slice(0, -1)), span = parent.children?.get('signingConfig');
  const old = span ? nameSchema.parse(JSON5.parse(snapshot.text.slice(span.start, span.end))) : null;
  if (requested && !project.profile.app.signingConfigs?.some((item) => item.name === requested)) {
    throw new InputInvalidError('Signing config is not declared in the selected project');
  }
  const reference = requested ?? old;
  const effective = project.profile.app.signingConfigs?.some((item) => item.name === reference) ? reference : null;
  const status = effective ? 'selected' : reference ? 'unresolved' : 'none';
  if (!requested || requested === old) { return { requested: requested ?? null, effective, reference, status, change: null }; }
  const before = span ? snapshot.text.slice(span.start, span.end) : '';
  const last = [...parent.children!.values()].at(-1), start = span?.start ?? parent.closeStart!;
  const after = span ? JSON.stringify(requested) : `${last && !last.comma ? ',' : ''} signingConfig: ${JSON.stringify(requested)}`;
  const text = snapshot.text.slice(0, start) + after + snapshot.text.slice(start + before.length);
  const change = { field, oldHash: snapshot.hash, newHash: digest(text), oldReference: old, newReference: requested,
    diff: `--- a/build-profile.json5\n+++ b/build-profile.json5\n@@ ${product} signingConfig @@\n-${before || '(absent)'}\n+${JSON.stringify(requested)}\n` };
  return { requested, effective, reference, status, change, write: { text, mode: snapshot.mode, edit: { start, before, after } } };
}
export function signingReview(prepared: Awaited<ReturnType<typeof prepareSigning>>) {
  return { requested: prepared.requested, effective: prepared.effective, reference: prepared.reference, status: prepared.status,
    change: prepared.change, mode: prepared.write?.mode ?? null };
}
async function atomicProfile(context: ExecutionContext, text: string, expectedHash: string, mode: number) {
  await replaceBuildFile(context, 'build-profile.json5', text, expectedHash, mode);
}
async function saveJournal(journal: Journal, context: ExecutionContext) {
  await new LocalState(context.dataDir).update(`build-signing-${journal.id}`, journalSchema, journal, () => journal);
}
function trackedContext(journal: Journal, context: ExecutionContext): ExecutionContext {
  return { ...context, eventSink: async (event) => {
    const payload = event.payload as { path: string; heldPath: string };
    if (event.type === 'build.file.before-displace' && payload.path === 'build-profile.json5') {
      journal.heldPath = payload.heldPath;
      journal.heldPaths = [...new Set([...journal.heldPaths, payload.heldPath])]; await saveJournal(journal, context);
    }
    await context.eventSink(event);
  } };
}
export async function applySigning(prepared: Awaited<ReturnType<typeof prepareSigning>>, product: string, context: ExecutionContext) {
  if (!prepared.change || !prepared.write) { return null; }
  const journal: Journal = { id: randomUUID(), projectRoot: context.projectRoot ?? context.cwd,
    planId: context.policy.approvedPlan!, product, phase: 'applying', mode: prepared.write.mode,
    oldHash: prepared.change.oldHash, newHash: prepared.change.newHash, edit: prepared.write.edit,
    oldReference: prepared.change.oldReference, newReference: prepared.change.newReference, heldPaths: [] };
  await saveJournal(journal, context);
  try {
    await atomicProfile(trackedContext(journal, context), prepared.write.text, journal.oldHash, journal.mode);
    journal.phase = 'applied'; await saveJournal(journal, context);
    return journal.id;
  } catch (error) {
    await restoreSigningJournal(journal.id, context).catch(() => undefined);
    throw new SigningApplyError(journal.id, error);
  }
}
async function readSigningJournal(id: string, context: ExecutionContext) {
  const journal = await new LocalState(context.dataDir).read(`build-signing-${id}`, journalSchema);
  if (journal.id !== id || journal.projectRoot !== (context.projectRoot ?? context.cwd)) {
    throw new InputInvalidError('Signing recovery scope mismatch');
  }
  return journal;
}
export async function inspectSigningJournal(id: string, context: ExecutionContext) {
  const journal = await readSigningJournal(id, context), current = await currentProfile(journal, context);
  return { journalId: id, product: journal.product, phase: journal.phase, currentHash: current.hash,
    originalHash: journal.oldHash, appliedHash: journal.newHash, heldPath: journal.heldPath ?? null, heldPaths: journal.heldPaths,
    state: current.hash === journal.oldHash ? current.held ? 'displaced-original' : 'original'
      : current.hash === journal.newHash ? current.held ? 'displaced-applied' : 'applied' : 'conflict' };
}
async function currentProfile(journal: Journal, context: ExecutionContext) {
  try { return { ...await profileSnapshot(context), held: false }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    for (const name of [...new Set([journal.heldPath, ...[...journal.heldPaths].reverse()])]) {
      if (!name) { continue; }
      const held = await profileSnapshot(context, name).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
      });
      if (held) { return { ...held, held: true }; }
    }
    throw error;
  }
}
export async function reviewSigningRestore(id: string, context: ExecutionContext) {
  const result = await inspectSigningJournal(id, context);
  if (!['applied', 'displaced-original', 'displaced-applied'].includes(result.state)) { throw new InputInvalidError('Signing restoration requires exact applied or displaced bytes'); }
  const journal = await readSigningJournal(id, context);
  const current = await currentProfile(journal, context);
  if (current.hash === journal.newHash) { validateReferenceRestoration(journal, current.text); }
  return { ...result, oldReference: journal.newReference, newReference: journal.oldReference,
    mode: journal.mode, journalHash: digest(JSON.stringify(journal)) };
}
function validateReferenceRestoration(journal: Journal, current: string) {
  const { start, before, after } = journal.edit;
  const original = current.slice(0, start) + before + current.slice(start + after.length);
  if (current.slice(start, start + after.length) !== after || digest(original) !== journal.oldHash) {
    throw new InputInvalidError('Signing recovery journal integrity mismatch');
  }
  const products = findSpan(parseSpans(original), ['app', 'products']);
  const matches = [...products.children ?? []].filter(([, value]) => {
    const name = value.children?.get('name');
    return name && JSON5.parse(original.slice(name.start, name.end)) === journal.product;
  });
  if (matches.length !== 1) { throw new InputInvalidError('Ambiguous signing product in recovery'); }
  const parent = matches[0][1], span = parent.children?.get('signingConfig');
  const old = span ? nameSchema.parse(JSON5.parse(original.slice(span.start, span.end))) : null;
  const last = [...parent.children!.values()].at(-1);
  const expected = { start: span?.start ?? parent.closeStart!, before: span ? original.slice(span.start, span.end) : '',
    after: span ? JSON.stringify(journal.newReference) : `${last && !last.comma ? ',' : ''} signingConfig: ${JSON.stringify(journal.newReference)}` };
  if (old !== journal.oldReference || JSON.stringify(expected) !== JSON.stringify(journal.edit)) {
    throw new InputInvalidError('Signing recovery must only change the selected product reference');
  }
  return original;
}
async function restoreProfile(journal: Journal, context: ExecutionContext) {
  const current = await currentProfile(journal, context);
  let state: 'restored' | 'recovery-required' = 'recovery-required';
  if (current.hash === journal.oldHash) {
    if (current.held) { await publishBuildFile(context, 'build-profile.json5', current.text, journal.mode); }
    state = 'restored';
  }
  else if (current.hash === journal.newHash) {
    const text = validateReferenceRestoration(journal, current.text);
    if (current.held) { await publishBuildFile(context, 'build-profile.json5', text, journal.mode); }
    else { await atomicProfile(trackedContext(journal, context), text, current.hash, journal.mode); }
    state = 'restored';
  }
  return state === 'restored' ? cleanupSigningHeld(journal, context) : state;
}
async function cleanupSigningHeld(journal: Journal, context: ExecutionContext) {
  const current = await profileSnapshot(context);
  if (current.hash !== journal.oldHash || current.mode !== journal.mode) { return 'recovery-required' as const; }
  const snapshots = [];
  for (const name of [...new Set([journal.heldPath, ...journal.heldPaths])]) {
    if (!name) { continue; }
    const held = await profileSnapshot(context, name).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
    });
    if (held) { snapshots.push({ name, hash: held.hash }); }
  }
  if (snapshots.some((held) => held.hash !== journal.oldHash && held.hash !== journal.newHash)) { return 'recovery-required' as const; }
  for (const held of snapshots) { await unlink(join(journal.projectRoot, held.name)); }
  return 'restored' as const;
}
export async function restoreSigningJournal(id: string, context: ExecutionContext) {
  const journal = await readSigningJournal(id, context);
  let state: 'restored' | 'recovery-required' = 'recovery-required', issue: string | null = null;
  try { state = await restoreProfile(journal, context); }
  catch { issue = 'SIGNING_PROFILE_RESTORE_UNVERIFIED'; }
  journal.phase = state; await saveJournal(journal, context);
  return { state, journalId: id, artifact: await saveEvidence(context, 'build-signing-journal', journal),
    issue, recovery: `ohmatecli build signing inspect --journal-id ${id}` };
}
export async function failedSigningRecovery(id: string, context: ExecutionContext) {
  const result = { state: 'recovery-required' as const, journalId: id, issue: 'SIGNING_JOURNAL_INVALID',
    recovery: `ohmatecli build signing inspect --journal-id ${id}` };
  return { ...result, artifact: await saveEvidence(context, 'build-signing-recovery', result) };
}
