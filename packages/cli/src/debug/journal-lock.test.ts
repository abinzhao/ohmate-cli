/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as locks from '../runtime/execution-lock.js';
import { acquireJournalLock } from './journal-lock.js';

let root: string;
const releases: Array<() => Promise<void>> = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-journal-lock-')); });
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(releases.splice(0).map((release) => release()));
  await rm(root, { recursive: true, force: true });
});

it('queues local contenders without polling the held disk lock and preserves request order', async () => {
  const session = randomUUID(), stream = randomUUID(), disk = vi.spyOn(locks, 'acquireDataLock');
  const owner = await acquireJournalLock(root, session, stream); releases.push(owner);
  const order: number[] = [];
  const waiters = [1, 2, 3].map((id) => acquireJournalLock(root, session, stream).then(async (release) => {
    order.push(id);
    try { return id; } finally { await release(); }
  }));
  try {
    await vi.waitFor(() => expect(disk.mock.calls.length, 'waiting local readers must not race the owner on disk').toBe(1));
  } finally { releases.pop(); await owner(); await Promise.allSettled(waiters); }
  expect(await Promise.all(waiters)).toEqual([1, 2, 3]);
  expect(order).toEqual([1, 2, 3]);
});

it('keeps unrelated streams independent and still rejects an external lock owner', async () => {
  const session = randomUUID(), stream = randomUUID();
  const external = await locks.acquireDataLock(root, `debug-journal:${session}:${stream}`); releases.push(external);
  const disk = vi.spyOn(locks, 'acquireDataLock');
  const waiting = acquireJournalLock(root, session, stream);
  await vi.waitFor(() => expect(disk.mock.calls.length).toBeGreaterThan(0));
  const independent = await acquireJournalLock(root, session, randomUUID());
  await independent();
  releases.pop(); await external();
  const reader = await waiting; await reader();
});

it('releases a failed acquisition slot so a later local request can acquire the actual disk lock', async () => {
  const session = randomUUID(), stream = randomUUID();
  vi.spyOn(locks, 'acquireDataLock').mockRejectedValueOnce(new Error('disk acquisition failed'));
  const failed = acquireJournalLock(root, session, stream);
  const waiting = acquireJournalLock(root, session, stream);
  await expect(failed).rejects.toThrow('disk acquisition failed');
  const release = await waiting; await release();
  const again = await acquireJournalLock(root, session, stream); await again();
});

it('includes local queue time in the five-second budget and preserves the owner after a queued timeout', async () => {
  const session = randomUUID(), stream = randomUUID(), disk = vi.spyOn(locks, 'acquireDataLock');
  const owner = await acquireJournalLock(root, session, stream); releases.push(owner);
  // The implementation uses native timers/promises; the outer timeout exceeds the real wait under test.
  await expect(acquireJournalLock(root, session, stream)).rejects.toBeInstanceOf(locks.ResourceBusyError);
  expect(disk.mock.calls.length).toBe(1);
  const later = acquireJournalLock(root, session, stream);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try { expect(disk.mock.calls.length, 'timed-out tail must not remove the still-owned queue').toBe(1); }
  finally { releases.pop(); await owner(); await later.then((release) => release()); }
  expect(disk.mock.calls.length).toBe(2);
}, 10000);
