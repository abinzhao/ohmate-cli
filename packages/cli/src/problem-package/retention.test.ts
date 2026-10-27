/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { EventJournal } from '../debug/event-journal.js';
import { verifyProblemPackage, problemHash } from './package.js';
import { readProblemZip, storedProblemZip } from './zip.js';
import { TaskManager } from '../tasks/task-manager.js';
import { agentTools, agentSpecs } from '../agent/agent-tools.js';
import type { ProblemSession, ProblemHistory, ProblemEvent } from './schemas.js';
import type { ClockSegment } from '../debug-protocol/clock-segments.js';

let root: string, runtime: Awaited<ReturnType<typeof createRuntime>>, context: Awaited<ReturnType<typeof createExecutionContext>>;
let journal: EventJournal, bridge: ReturnType<typeof createReadonlyBridge>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-problem-retention-'));
  await mkdir(join(root, 'data'), { mode: 0o700 });
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  runtime = await createRuntime();
  const handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, randomUUID(), handshake, {
    maxEvents: 5, segmented: true, retention: 'rolling-v1', resume: { peer: handshake, epoch: 'epoch-1' },
  });
  bridge = createReadonlyBridge(handshake); bridge.connect(handshake, 'epoch-1');
  await append(1); await append(3); await append(5);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function append(from: number) {
  await journal.appendBatch([from, from + 1].map((sequence) => bridge.accept(event(sequence, { project: context.workspaceId }))));
}
const selection = (through = 6) => ({ id: journal.sessionId, stream: journal.streamId, through });
async function exported(through = 6) {
  const plan = await runtime.execute('debug.problem.export', selection(through), context);
  expect(plan.exitCode).toBe(5);
  const approvedPlan = (plan.data as { planId: string }).planId;
  const receipt = await runtime.execute('debug.problem.export', selection(through),
    { ...context, policy: { ...context.policy, approvedPlan } });
  expect(receipt.exitCode).toBe(0);
  return { plan, receipt, path: (receipt.data as { path: string }).path };
}
function mutate(bytes: Buffer, change: (session: ProblemSession & { history: ProblemHistory; clockEvidence: ClockSegment[] },
  events: ProblemEvent[]) => void) {
  const files = new Map([...readProblemZip(bytes)].map(([name, file]) => [name, file.read()]));
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  const session = JSON.parse(files.get('session.json')!.toString());
  const events = files.get('events.jsonl')!.toString().trim().split('\n').map((line) => JSON.parse(line));
  change(session, events);
  files.set('session.json', Buffer.from(JSON.stringify(session)));
  files.set('events.jsonl', Buffer.from(events.map((value) => JSON.stringify(value)).join('\n') + '\n'));
  for (const file of manifest.files) { const value = files.get(file.path)!; file.size = value.length; file.sha256 = problemHash(value); }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return storedProblemZip(files);
}
it('exports original retained positions with a same-read clock anchor and visible loss', async () => {
  const { path, receipt, plan } = await exported();
  const checked = verifyProblemPackage(await readFile(path));
  expect(checked.manifest.schemaVersion).toBe('1.2');
  expect(checked.session).toMatchObject({ through: 6, authentication: 'not-restored',
    history: { retention: 'rolling-v1', from: 3, retainedCount: 4, epochs: ['epoch-1'],
      anchor: { sequence: 2, sessionEpoch: 'epoch-1', clock: { monotonicNs: '2', segment: 1 } },
      gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } } });
  expect(checked.events!.map((value) => value.sequence)).toEqual([3, 4, 5, 6]);
  expect(checked.session!.clockEvidence![0]).toMatchObject({ reason: 'continuous', segment: 1 });
  expect(receipt.data).toMatchObject({ count: 4, through: 6, retainedFrom: 3 });
  expect(plan.data).toMatchObject({ review: { retainedCount: 4, retainedFrom: 3,
    gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } } });
  const text = JSON.stringify(checked);
  expect(text).not.toContain(identity.fingerprint);
  expect(text).not.toContain('sourceDigest'); expect(text).not.toContain('resumeDigest');
});
it('pages offline with absolute exclusive cursors and reports a partial missing interval', async () => {
  const { path } = await exported();
  const first = await runtime.execute('replay.show', { path, after: 1, limit: 2 }, context);
  expect(first).toMatchObject({ exitCode: 0, data: { count: 4, through: 6, retainedFrom: 3, nextCursor: 4, hasMore: true,
    gap: { missingFrom: 2, missingThrough: 2, reason: 'retention-quota' },
    events: [{ sequence: 3 }, { sequence: 4 }] } });
  const next = await runtime.execute('replay.show', { path, after: 4, limit: 2 }, context);
  expect(next).toMatchObject({ exitCode: 0, data: { nextCursor: 6, hasMore: false, gap: null,
    events: [{ sequence: 5 }, { sequence: 6 }] } });
});
it('preserves a fixed cut while newer events arrive without moving its retained prefix', async () => {
  const input = selection(5);
  const plan = await runtime.execute('debug.problem.export', input, context);
  expect(plan.exitCode).toBe(5);
  await journal.append(bridge.accept(event(7, { project: context.workspaceId })));
  const result = await runtime.execute('debug.problem.export', input,
    { ...context, policy: { ...context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(result.exitCode).toBe(0);
  const checked = verifyProblemPackage(await readFile((result.data as { path: string }).path));
  expect(checked.events!.map((value) => value.sequence)).toEqual([3, 4, 5]);
  expect(checked.session).toMatchObject({ through: 5, history: { from: 3, retainedCount: 3 } });
});
it('refuses an approved cut after quota eviction moves its prefix, even with the same absolute tail', async () => {
  const plan = await runtime.execute('debug.problem.export', selection(), context);
  expect(plan.exitCode).toBe(5);
  await append(7);
  const result = await runtime.execute('debug.problem.export', selection(),
    { ...context, policy: { ...context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(result.exitCode).toBe(5);
  expect(result.data).toMatchObject({ code: 'APPROVAL_STALE' });
});
it('rejects an evicted cut and a future cut without renumbering or empty success', async () => {
  const evicted = await runtime.execute('debug.problem.plan', selection(2), context);
  expect(evicted).toMatchObject({ exitCode: 4, data: { message: 'PROBLEM_CURSOR_EVICTED' } });
  expect(await runtime.execute('debug.problem.plan', selection(7), context))
    .toMatchObject({ exitCode: 4, data: { message: 'PROBLEM_CURSOR_AHEAD' } });
});
it.each(['gap', 'count', 'anchor', 'clock', 'epoch', 'duplicate', 'initial'] as const)(
  'rejects forged retained %s after archive hashes have been recomputed', async (change) => {
    const { path } = await exported();
    const bytes = mutate(await readFile(path), (session, events) => {
      if (change === 'gap') { session.history.gap!.missingThrough++; }
      if (change === 'count') { session.history.retainedCount--; }
      if (change === 'anchor') { session.history.anchor!.sequence++; }
      if (change === 'clock') { session.clockEvidence[0].segment++; }
      if (change === 'epoch') { events[0].sessionEpoch = 'unknown'; }
      if (change === 'duplicate') { events[1].messageId = events[0].messageId; }
      if (change === 'initial') { session.history.anchor!.clock.reason = 'initial'; }
    });
    expect(() => verifyProblemPackage(bytes)).toThrow(/PROBLEM_(SEQUENCE|CLOCK|HISTORY)_INVALID/);
  });
it('keeps epochs and clock transitions when a retained stream was explicitly paired again', async () => {
  const handshake = createHandshake({ ...identity, project: context.workspaceId });
  const resumed = await EventJournal.resume(context.dataDir, journal.sessionId, journal.streamId, handshake, handshake, {
    ...handshake.identity, type: 'resume', protocolVersion: '1.1', previousEpoch: 'epoch-1', sessionEpoch: 'epoch-2', resumeFrom: 7,
  }, { segmented: true, retention: 'rolling-v1' });
  journal = resumed.journal; bridge = resumed.bridge;
  await journal.appendBatch([7, 8].map((n) => bridge.accept(event(n, {
    project: context.workspaceId, sessionEpoch: 'epoch-2', bootId: 'second-boot', monotonicNs: String(n),
  }))));
  const { path } = await exported(8);
  const checked = verifyProblemPackage(await readFile(path));
  expect(checked.session).toMatchObject({ history: { from: 5, epochs: ['epoch-1', 'epoch-2'],
    anchor: { sequence: 4, sessionEpoch: 'epoch-1' } } });
  expect(checked.session!.clockEvidence!.map((clock) => clock.segment)).toEqual([1, 1, 2, 2]);
});
it('requires task approval and exposes the same retained offline page to an actual Agent tool', async () => {
  const manager = new TaskManager(runtime, context);
  const task = await manager.submit('debug.problem.export', selection(), true);
  expect(task.state).toBe('awaiting-approval');
  const complete = await manager.approve(task.id, task.plan!.planId, true);
  expect(complete.state).toBe('succeeded');
  const path = (complete.receipt!.data as { path: string }).path;
  const state = { pending: [], receipts: [] };
  const tools = agentTools(runtime, agentSpecs(runtime, ['replay.show']), context, [], state);
  const shown = await tools[0].execute('offline-retained', { path, after: 0, limit: 1 });
  expect(JSON.parse((shown.content[0] as { text: string }).text)).toMatchObject({ exitCode: 0,
    data: { count: 4, through: 6, nextCursor: 3, authentication: 'not-restored', events: [{ sequence: 3 }] } });
});
it('uses one validated source read for records, clock anchor and review', async () => {
  const read = vi.spyOn(EventJournal, 'read');
  expect((await runtime.execute('debug.problem.plan', selection(), context)).exitCode).toBe(0);
  expect(read).toHaveBeenCalledExactlyOnceWith(context.dataDir, journal.sessionId, journal.streamId, { retainedHistory: true });
});
