/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { identity, event } from '../debug-protocol/test-fixtures.js';
import { acquireDataLock } from '../runtime/execution-lock.js';

const gate = vi.hoisted(() => ({ reached: undefined as (() => void) | undefined, wait: undefined as Promise<void> | undefined }));
vi.mock('./journal-files.js', async (actual) => {
  const files = await actual<typeof import('./journal-files.js')>();
  return { ...files, writeJournalCheckpoint: async (...args: Parameters<typeof files.writeJournalCheckpoint>) => {
    if (gate.wait) { gate.reached?.(); await gate.wait; }
    return files.writeJournalCheckpoint(...args);
  } };
});
let root: string;
afterEach(async () => { gate.wait = undefined; gate.reached = undefined; if (root) { await rm(root, { recursive: true, force: true }); } });

it('holds the stream lock until the checkpoint is committed and readable', async () => {
  const { EventJournal } = await import('./event-journal.js');
  root = await mkdtemp(join(tmpdir(), 'ohmate-journal-coordination-'));
  const handshake = createHandshake(identity), journal = await EventJournal.create(root, randomUUID(), handshake);
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  let release!: () => void;
  gate.wait = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { gate.reached = resolve; });
  const writing = journal.append(receiver.accept(event(1)));
  await reached;
  try {
    const competing = await acquireDataLock(root, `debug-journal:${journal.sessionId}:${journal.streamId}`).then(
      async (unlock) => { await unlock(); return 'acquired'; }, () => 'busy');
    expect(competing).toBe('busy');
  } finally { release(); await writing; }
  const reading = await EventJournal.read(root, journal.sessionId, journal.streamId);
  expect(reading.events).toEqual([expect.objectContaining({ index: 1 })]);
});
