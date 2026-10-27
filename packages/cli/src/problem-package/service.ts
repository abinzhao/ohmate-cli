/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonicalJson, hashContract } from '../debug-protocol/canonical-hash.js';
import { EventJournal } from '../debug/event-journal.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';
import { buildProblemPackage, verifyProblemArchive, problemHash } from './package.js';
import { readProblemFile, readProblemRange, withProblemFile, writeProblemFile } from './files.js';
import { PROBLEM_LIMITS, readProblemZipAt } from './zip.js';
import { KitPageFields } from './kit-profile.js';
import type { KitPageSelection } from './kit-profile.js';

export const ProblemSelectionSchema = z.strictObject({
  id: z.string().uuid(), stream: z.string().uuid(), through: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const ProblemReadSchema = z.strictObject({
  path: z.string().min(1).max(1024).refine((path) => path.endsWith('.ohmate-problem.zip')),
  buildId: z.string().min(1).max(512).optional(),
});
export const ProblemPageSchema = ProblemReadSchema.extend({
  ...KitPageFields,
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(256).default(100),
}).refine((input) => !input.file || Boolean(input.domain), { path: ['file'], message: 'Kit file selection requires a domain' });
type Selection = z.infer<typeof ProblemSelectionSchema>;
async function selectedPackage(input: Selection, context: ExecutionContext) {
  const selection = ProblemSelectionSchema.parse(input);
  context.abortSignal.throwIfAborted();
  const journal = await EventJournal.read(context.dataDir, selection.id, selection.stream, { retainedHistory: true });
  if (journal.manifest.handshake.identity.project !== context.workspaceId) { throw new Error('PROBLEM_WORKSPACE_MISMATCH'); }
  if (selection.through > (journal.retention?.through ?? journal.events.length)) { throw new Error('PROBLEM_CURSOR_AHEAD'); }
  if (journal.history?.anchor && selection.through < journal.history.from) { throw new Error('PROBLEM_CURSOR_EVICTED'); }
  const records = journal.events.filter((record) => record.index <= selection.through);
  const history = journal.history ? { ...journal.history, retainedCount: records.length } : undefined;
  const result = buildProblemPackage({ debugSessionId: selection.id, streamId: selection.stream,
    identity: journal.manifest.handshake.identity, events: records.map((record) => record.event),
    ...(history ? { history, through: selection.through } : {}),
    ...(history || records.some((record) => record.clock.alignment) ? { clocks: records.map((record) => record.clock) } : {}) });
  const manifestBytes = Buffer.from(canonicalJson(result.manifest));
  const review = {
    selection, snapshotHash: hashContract({ manifestHash: hashContract(journal.manifest), records: records.map((record) => record.hash),
      ...(history ? { history } : {}) }),
    ...(history ? { retainedFrom: history.from, retainedCount: history.retainedCount, gap: history.gap } : {}),
    archiveHash: result.sha256, archiveBytes: result.bytes.length,
    identity: result.session.identity,
    files: [{ path: 'manifest.json', type: 'json', sensitivity: 'redacted-summary', compression: 'store',
      size: manifestBytes.length, sha256: problemHash(manifestBytes) },
      ...result.manifest.files],
    fields: { identity: Object.keys(result.session.identity),
      event: [...new Set(records.flatMap((record) => Object.keys(record.event).filter((key) => key !== 'fingerprint')))].sort(),
      payload: [...new Set(records.flatMap((record) => Object.keys(record.event.payload)))].sort() },
    coverage: result.session.coverage, redaction: result.session.redaction,
    retainedRisks: ['opaque-identifiers', 'domain-summary-metadata', 'sha256-is-not-authentication',
      'peer-asserted-device', 'unverified-build', 'uncalibrated-clocks'],
    attachments: 'none', authentication: 'not-restored',
  };
  return { ...result, review };
}
export async function reviewProblem(input: Selection, context: ExecutionContext) {
  return (await selectedPackage(input, context)).review;
}
export async function exportProblem(input: Selection, context: ExecutionContext): Promise<ToolResult> {
  const result = await selectedPackage(input, context), planId = context.policy.approvedPlan;
  if (!planId || !/^[a-f0-9]{64}$/.test(planId)) { throw new Error('PROBLEM_APPROVAL_REQUIRED'); }
  const plan = JSON.parse((await readProblemFile(join(context.dataDir, 'plans', `${planId}.json`), 1024 * 1024)).toString());
  if (!plan.usedAt || plan.tool !== 'debug.problem.export' || hashContract(plan.review) !== hashContract(result.review)) {
    throw new Error('PROBLEM_SNAPSHOT_CHANGED');
  }
  const path = await writeProblemFile(context, result.manifest.problemId, result.bytes);
  return { exitCode: 0, data: { path, sha256: result.sha256, manifest: result.manifest,
    count: result.session.history?.retainedCount ?? result.session.through,
    ...(result.session.history ? { through: result.session.through, retainedFrom: result.session.history.from, gap: result.session.history.gap } : {}),
    authentication: 'not-restored', buildVerification: 'unverified', deviceProvenance: 'peer-asserted' },
    artifacts: [{ path, sha256: result.sha256, kind: 'ohmate-problem' }] };
}
export async function verifiedProblem(input: z.infer<typeof ProblemReadSchema>, context: ExecutionContext,
  page?: Omit<KitPageSelection, 'domain'> & { domain?: KitPageSelection['domain'] }, withHash = false) {
  context.abortSignal.throwIfAborted();
  const path = resolve(context.cwd, input.path);
  const { result, archiveHash } = await withProblemFile(path, PROBLEM_LIMITS.maxArchiveBytes, async (handle, size) => {
    const files = await readProblemZipAt(size, (offset, length) => readProblemRange(handle, offset, length), context.abortSignal);
    const result = await verifyProblemArchive(files, context.abortSignal, page?.domain ? { ...page, domain: page.domain } : undefined);
    const hash = createHash('sha256');
    if (withHash) {
      for (let offset = 0; offset < size; offset += 65536) {
        context.abortSignal.throwIfAborted();
        hash.update(await readProblemRange(handle, offset, Math.min(65536, size - offset)));
      }
    }
    return { result, archiveHash: withHash ? hash.digest('hex') : undefined };
  });
  if (page?.domain && !result.kitPage) { throw new Error('PROBLEM_KIT_PROFILE_REQUIRED'); }
  if (input.buildId && (result.core?.summary.buildId ?? result.session?.identity.buildId) !== input.buildId) {
    throw new Error('PROBLEM_IDENTITY_MISMATCH');
  }
  context.abortSignal.throwIfAborted();
  return { path, result, archiveHash };
}
export async function importProblem(input: z.infer<typeof ProblemReadSchema>, context: ExecutionContext): Promise<ToolResult> {
  const { path, result } = await verifiedProblem(input, context);
  const { clockEvidence, ...session } = result.session ?? {};
  void clockEvidence;
  return { exitCode: result.compatibility === 'compatible' ? 0 : 3,
    data: { path, importStatus: result.compatibility === 'compatible' ? 'opened' : 'manifest-only', access: 'read-only',
      valid: result.payloadIntegrity === 'verified', compatibility: result.compatibility,
      payloadIntegrity: result.payloadIntegrity, manifest: result.manifest,
      ...(result.session ? { session } : {}),
      fieldCoverage: result.fieldCoverage, ignoredFields: result.ignoredFields,
      ...(result.kit ? { kit: result.kit } : {}),
      ...(result.core ? { core: result.core } : {}),
      count: result.core?.summary.events.length ?? result.events?.length ?? 0, authentication: 'not-restored', replay: 'not-performed',
      buildVerification: 'unverified', deviceProvenance: 'peer-asserted', clockCalibration: 'not-verified' } };
}
export async function readProblem(input: z.infer<typeof ProblemReadSchema>, context: ExecutionContext,
  page?: Omit<KitPageSelection, 'domain'> & { domain?: KitPageSelection['domain'] }): Promise<ToolResult> {
  const { result } = await verifiedProblem(input, context, page);
  const events = result.events ?? [], through = result.session?.through ?? 0, history = result.session?.history;
  if (page && !page.domain && page.after > through) { throw new Error('PROBLEM_CURSOR_INVALID'); }
  const selected = page && !page.domain && result.session ? events.filter((event) => event.sequence > page.after).slice(0, page.limit) : undefined;
  const nextCursor = selected?.at(-1)?.sequence ?? Math.max(page?.after ?? 0, (history?.from ?? 1) - 1);
  const { clockEvidence, ...metadata } = result.session ?? {};
  const eventAfter = page?.domain ? 0 : page?.after ?? 0;
  const pagedClocks = selected && clockEvidence ? {
    clockEvidenceFrom: selected[0]?.sequence ?? nextCursor + 1,
    clockEvidence: selected.map((event) => clockEvidence[event.sequence - (history?.from ?? 1)]),
  } : {};
  return { exitCode: result.compatibility === 'compatible' ? 0 : 3,
    data: { valid: result.payloadIntegrity === 'verified', compatibility: result.compatibility,
      payloadIntegrity: result.payloadIntegrity, manifest: result.manifest,
      session: (selected || page?.domain) && clockEvidence ? metadata : result.session, ...pagedClocks,
      fieldCoverage: result.fieldCoverage, ignoredFields: result.ignoredFields,
      ...(result.kit ? { kit: result.kit } : {}),
      ...(result.kitPage ? { kitPage: result.kitPage } : {}),
      ...(result.core ? { core: result.core } : {}),
      count: result.core?.summary.events.length ?? events.length, authentication: 'not-restored', replay: 'not-performed',
      ...(history ? { through, retainedFrom: history.from, retainedCount: history.retainedCount,
        gap: page && eventAfter >= history.from - 1 ? null : history.gap ? {
          ...history.gap, missingFrom: eventAfter + 1,
        } : null } : {}),
      ...(page && !page.domain && result.session ? { events: selected, through, nextCursor, hasMore: nextCursor < through } : {}) } };
}
