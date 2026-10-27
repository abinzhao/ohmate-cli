/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setTimeout } from 'node:timers/promises';
import { acquireDataLock, ResourceBusyError } from '../runtime/execution-lock.js';

const turns = new Map<string, Promise<void>>();

export async function acquireJournalLock(dataDir: string, sessionId: string, streamId: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5000, key = JSON.stringify([dataDir, sessionId, streamId]);
  const previous = turns.get(key) ?? Promise.resolve();
  let complete!: () => void;
  const slot = new Promise<void>((resolve) => { complete = resolve; });
  const turn = previous.then(() => slot);
  turns.set(key, turn);
  const finish = () => {
    complete();
    // A timed-out slot still follows its predecessor until that owner releases.
    void turn.then(() => { if (turns.get(key) === turn) { turns.delete(key); } });
  };
  try {
    await waitTurn(previous, deadline);
    const release = await acquireDiskLock(dataDir, sessionId, streamId, deadline);
    return async () => { try { await release(); } finally { finish(); } };
  } catch (error) { finish(); throw error; }
}
async function waitTurn(previous: Promise<void>, deadline: number): Promise<void> {
  const timer = new AbortController();
  try {
    await Promise.race([previous, setTimeout(Math.max(0, deadline - Date.now()), undefined, { signal: timer.signal }).then(() => {
      throw new ResourceBusyError('Journal lock wait timed out');
    })]);
  } finally { timer.abort(); }
}
async function acquireDiskLock(dataDir: string, sessionId: string, streamId: string, deadline: number): Promise<() => Promise<void>> {
  while (true) {
    if (Date.now() >= deadline) { throw new ResourceBusyError('Journal lock wait timed out'); }
    try { return await acquireDataLock(dataDir, `debug-journal:${sessionId}:${streamId}`); }
    catch (error) {
      if (!(error instanceof ResourceBusyError) || Date.now() >= deadline) { throw error; }
      // Poll only external owners; local readers/writers take turns without racing a held disk lock.
      await setTimeout(Math.min(25, Math.max(0, deadline - Date.now())));
    }
  }
}
