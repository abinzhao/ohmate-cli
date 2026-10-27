/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventJournal } from './event-journal.js';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { identity, event } from '../debug-protocol/test-fixtures.js';
import { createExecutionContext, type ExecutionContext } from '../runtime/index.js';
import { processIdentity } from '../runtime/process-tree.js';
import { createDebugSession } from './debug-state.js';
import { initialBridgeStatus } from './bridge-status.js';
import { readDebugEvents, readDebugStreams } from './event-query.js';
import { readInspector } from './inspector.js';

let root: string, context: ExecutionContext, journal: EventJournal;
let receiver: ReturnType<typeof createReadonlyBridge>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-retention-query-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  await mkdir(context.dataDir, { mode: 0o700 });
  const id = randomUUID(), handshake = createHandshake({ ...identity, project: context.workspaceId });
  journal = await EventJournal.create(context.dataDir, id, handshake, {
    maxEvents: 4, segmented: true, retention: 'rolling-v1', resume: { peer: handshake, epoch: 'epoch-1' },
  });
  receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  await createDebugSession(context.dataDir, {
    pid: process.pid, identity: (await processIdentity(process.pid))!, cwd: root, projectRoot: null,
    origin: 'http://127.0.0.1:1234', startedAt: new Date().toISOString(), controlSecret: 'a'.repeat(64), debugSessionId: id,
  }, { ...initialBridgeStatus(identity.fingerprint), state: 'connected', streamId: journal.streamId,
    target: handshake.identity, authentication: 'pairing-proof', reason: null });
  for (let from = 1; from <= 5; from += 2) { await append(from); }
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function append(from: number) {
  await journal.appendBatch([from, from + 1].map((n) => receiver.accept(event(n, { project: context.workspaceId }))));
}
function input() { return { id: journal.sessionId, stream: journal.streamId }; }
it('pages from absolute retained positions and includes exact loss without treating the tail as a count', async () => {
  const page = await readDebugEvents(context.dataDir, { ...input(), after: 0, limit: 2 });
  expect(page).toMatchObject({ through: 6, retainedFrom: 3, retainedCount: 4,
    nextCursor: 4, hasMore: true, gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } });
  expect(page.events.map((record) => record.index)).toEqual([3, 4]);
  const next = await readDebugEvents(context.dataDir, { ...input(), after: 4, limit: 2 });
  expect(next).toMatchObject({ nextCursor: 6, hasMore: false, gap: null });
  expect(next.events.map((record) => record.index)).toEqual([5, 6]);
  expect(await readDebugEvents(context.dataDir, { ...input(), after: 1, limit: 1 })).toMatchObject({
    gap: { missingFrom: 2, missingThrough: 2, reason: 'retention-quota' } });
});
it('summarizes retained count separately from the absolute committed tail', async () => {
  expect(await readDebugStreams(context.dataDir, { id: journal.sessionId, limit: 20 })).toMatchObject({
    streams: [{ through: 6, retainedFrom: 3, retainedCount: 4, retentionGap: { missingFrom: 1, missingThrough: 2 } }],
  });
});
it('copies only the requested page after validating the entire retained journal', async () => {
  const copy = vi.spyOn(globalThis, 'structuredClone');
  const page = await readDebugEvents(context.dataDir, { ...input(), after: 3, limit: 1 });
  expect(page.events.map((record) => record.index)).toEqual([4]);
  expect(page).toMatchObject({ retainedCount: 4, retainedFrom: 3, through: 6, nextCursor: 4, hasMore: true, gap: null });
  const snapshots = copy.mock.calls.map(([value]) => value).filter((value) =>
    typeof value === 'object' && value !== null && 'manifest' in value && 'events' in value) as Array<{ events: unknown[] }>;
  expect(snapshots.map((value) => value.events.length), 'paging must not defensively copy unreturned history').toEqual([1]);
  page.events[0].clock.segment = 999; page.manifest.handshake.identity.buildId = 'caller mutation';
  const again = await readDebugEvents(context.dataDir, { ...input(), after: 3, limit: 1 });
  expect(again.events[0].clock.segment).toBe(1); expect(again.manifest.handshake.identity.buildId).not.toBe('caller mutation');
});
it('rejects corruption beyond a requested warm-cache page before returning any records', async () => {
  await readDebugEvents(context.dataDir, { ...input(), after: 2, limit: 1 });
  await writeFile(join(journal.root, '0000000000000005-0000000000000006.seg'), '{}');
  await expect(readDebugEvents(context.dataDir, { ...input(), after: 2, limit: 1 })).rejects.toThrow('JOURNAL_CORRUPT');
});
it('keeps Inspector positions absolute and invalidates a cut whose retained prefix changes', async () => {
  const page = await readInspector({ ...input(), channel: 'hilog', after: 0, limit: 1 }, context);
  expect(page).toMatchObject({ through: 6, retainedFrom: 3, nextCursor: 3, count: 4,
    gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' } });
  expect(page.events.map((record) => record.index)).toEqual([3]);
  await append(7);
  const moved = await readInspector({ ...input(), channel: 'hilog', through: 6, after: 3, limit: 1 }, context);
  expect(moved.snapshotHash).not.toBe(page.snapshotHash);
  expect(moved).toMatchObject({ through: 6, retainedFrom: 5, count: 2,
    gap: { missingFrom: 4, missingThrough: 4, reason: 'retention-quota' } });
  await expect(readInspector({ ...input(), channel: 'hilog', through: 3, after: 0, limit: 1 }, context))
    .rejects.toThrow('INSPECTOR_CURSOR_EVICTED');
});
