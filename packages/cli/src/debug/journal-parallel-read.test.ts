/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import * as files from './journal-files.js';
import * as locks from './journal-lock.js';
import * as clocks from '../debug-protocol/clock-segments.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import { EventJournal } from './event-journal.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-journal-parallel-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function start(version = '1.3', maxBytes = 5 * 1024 * 1024) {
  const handshake = createHandshake(identity);
  const store = await EventJournal.create(root, randomUUID(), handshake, {
    ...(version !== '1.1' ? { resume: { peer: handshake, epoch: 'epoch-1' } } : {}),
    segmented: ['1.3', '1.4'].includes(version), maxBytes,
    ...(version === '1.4' ? { retention: 'rolling-v1' as const } : {}),
  });
  const receiver = createReadonlyBridge(handshake); receiver.connect(handshake, 'epoch-1');
  for (let index = 1; index <= 9; index++) { await store.append(receiver.accept(event(index))); }
  const read = () => EventJournal.read(root, store.sessionId, store.streamId);
  const names = (await read()).events.map((record) => {
    const width = version === '1.4' ? 16 : 8, index = String(record.index).padStart(width, '0');
    return ['1.3', '1.4'].includes(version) ? `${index}-${index}.seg` : `${index}.json`;
  });
  return { store, receiver, names, read };
}

it.each(['1.1', '1.2', '1.3', '1.4'])('reads %s files four at a time without changing committed order', async (version) => {
  const { names, read } = await start(version);
  const original = files.readJournalFile, activeNames = new Set<string>(), completions: string[] = [];
  let maximum = 0;
  vi.spyOn(files, 'readJournalFile').mockImplementation(async (file, budget) => {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (!names.includes(name)) { return original(file, budget); }
    activeNames.add(name); maximum = Math.max(maximum, activeNames.size);
    try {
      await setImmediate();
      const bytes = await original(file, budget); completions.push(name); return bytes;
    } finally { activeNames.delete(name); }
  });
  expect((await read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect([...completions].sort()).toEqual(names);
  expect(activeNames.size).toBe(0);
  expect(maximum, 'independent safe reads should overlap with at most four pending files').toBe(4);
});

it.each(['1.1', '1.3'])('reserves aggregate %s read budgets within the remaining journal quota', async (version) => {
  const { store, names, read } = await start(version, 400000);
  const initial = (await readFile(join(store.root, 'manifest.json'))).length;
  const original = files.readJournalFile;
  let completedBytes = initial, reserved = 0, maximum = 0, active = 0;
  vi.spyOn(files, 'readJournalFile').mockImplementation(async (file, budget) => {
    if (!names.some((name) => file.endsWith(`/${name}`))) { return original(file, budget); }
    reserved += budget; active++; maximum = Math.max(maximum, active);
    try {
      expect(reserved + completedBytes, 'pending allocations share the original total byte limit').toBeLessThanOrEqual(400000);
      await setImmediate();
      const bytes = await original(file, budget); completedBytes += bytes.length; return bytes;
    } finally { reserved -= budget; active--; }
  });
  expect((await read()).count).toBe(9);
  expect(reserved).toBe(0);
  expect(maximum).toBe(version === '1.1' ? 3 : 1);
});

it('preserves committed order when a read group completes in reverse order', async () => {
  const { names, read } = await start();
  const original = files.readJournalFile, gates = new Map<string, () => void>(), completed: string[] = [];
  let hold = true;
  vi.spyOn(files, 'readJournalFile').mockImplementation(async (file, budget) => {
    const bytes = await original(file, budget), name = file.slice(file.lastIndexOf('/') + 1);
    if (hold && names.slice(0, 4).includes(name)) {
      await new Promise<void>((resolve) => { gates.set(name, resolve); });
      completed.push(name);
    }
    return bytes;
  });
  const operation = read();
  try {
    await vi.waitFor(() => { expect(gates.size).toBe(4); });
    for (const name of names.slice(0, 4).reverse()) { gates.get(name)!(); }
    expect((await operation).events.map((record) => record.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(completed).toEqual(names.slice(0, 4).reverse());
  } finally {
    hold = false;
    for (const release of gates.values()) { release(); }
    await Promise.allSettled([operation]);
  }
});

it('reduces overlap as remaining bytes shrink without rejecting a valid uneven suffix', async () => {
  const { store, names, read } = await start('1.1', 275000);
  const checkpointFile = join(store.root, 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  for (const name of names) {
    const file = join(store.root, name), bytes = await readFile(file), padding = 20000 - bytes.length;
    await writeFile(file, Buffer.concat([bytes, Buffer.alloc(padding, 32)]));
    checkpoint.bytes += padding;
  }
  await writeFile(checkpointFile, JSON.stringify(checkpoint));
  const original = files.readJournalFile, overlap: number[] = [], budgets: number[] = [];
  let active = 0;
  vi.spyOn(files, 'readJournalFile').mockImplementation(async (file, budget) => {
    if (!names.some((name) => file.endsWith(`/${name}`))) { return original(file, budget); }
    overlap.push(++active); budgets.push(budget);
    try { await setImmediate(); return await original(file, budget); }
    finally { active--; }
  });
  expect((await read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(overlap).toEqual([1, 2, 1, 1, 1, 1, 1, 1, 1]);
  expect(budgets.at(-1)).toBeLessThan(131072);
  expect(active).toBe(0);
});

it.each(['permissions', 'symlink', 'hardlink', 'hash'])('rejects a bad file within parallel history: %s', async (change) => {
  const { store, names, read } = await start();
  const file = join(store.root, names[2]), original = await readFile(file);
  if (change === 'permissions') { await chmod(file, 0o644); }
  else if (change === 'hash') { await writeFile(file, '{}'); }
  else {
    const outside = join(root, 'outside');
    await writeFile(outside, original, { mode: 0o600 }); await rm(file);
    if (change === 'symlink') { await symlink(outside, file); } else { await link(outside, file); }
  }
  await expect(read()).rejects.toThrow(change === 'hash' ? 'JOURNAL_CORRUPT' : 'JOURNAL_UNSAFE');
});

it('rejects total byte overflow even when each named file fits its individual limit', async () => {
  const { store, names, read } = await start();
  const manifestFile = join(store.root, 'manifest.json'), checkpointFile = join(store.root, 'checkpoint.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.maxBytes = 16384;
  const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  checkpoint.manifestHash = hashContract(manifest);
  await writeFile(manifestFile, JSON.stringify(manifest)); await writeFile(checkpointFile, JSON.stringify(checkpoint));
  for (const name of names) {
    const file = join(store.root, name);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.alloc(3000, 32)]));
  }
  await expect(read()).rejects.toThrow('JOURNAL_UNSAFE');
});

it('settles every pending safe read before releasing the lock and discards failed cached prefixes', async () => {
  const { store, receiver, names, read } = await start();
  const bad = join(store.root, names[0]);
  const accepted = receiver.accept(event(10));
  const original = files.readJournalFile;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const pending = new Set<string>();
  let failed = false, settled = false, maximum = 0, hold = true;
  const lock = vi.spyOn(locks, 'acquireJournalLock'), clock = vi.spyOn(clocks, 'advanceClock');
  await chmod(bad, 0o644);
  vi.spyOn(files, 'readJournalFile').mockImplementation(async (file, budget) => {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (!names.includes(name)) { return original(file, budget); }
    pending.add(name); maximum = Math.max(maximum, pending.size);
    try {
      if (hold && name !== names[0]) { await released; }
      return await original(file, budget);
    } catch (error) { failed = true; throw error; }
    finally { pending.delete(name); }
  });
  const first = read().then(() => { settled = true; return null; }, (error: Error) => { settled = true; return error; });
  let next: ReturnType<typeof read> | undefined, write: ReturnType<EventJournal['append']> | undefined;
  try {
    await vi.waitFor(() => {
      expect(failed).toBe(true);
      expect(pending.size, 'a sibling read remains outstanding after the first IO rejection').toBe(3);
    });
    next = read();
    void next.catch(() => {});
    // Directory validation precedes the reader's lock request; observe the queued turn before the writer.
    await vi.waitFor(() => { expect(lock.mock.calls.length).toBe(2); });
    write = store.append(accepted);
    void write.catch(() => {});
    await vi.waitFor(() => { expect(lock.mock.calls.length).toBe(3); });
    expect(settled, 'no rejection or lock release may escape while sibling reads are pending').toBe(false);
    expect(maximum).toBe(4);
    await chmod(bad, 0o600);
    hold = false; release();
    expect((await first)?.message).toContain('JOURNAL_UNSAFE');
    expect((await next).count).toBe(9);
    expect(clock.mock.calls.length, 'failed IO must not republish the consumed warm prefix').toBe(9);
    expect((await write).index).toBe(10);
    expect((await read()).events.map((record) => record.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pending.size).toBe(0);
  } finally {
    hold = false; release();
    await Promise.allSettled([first, ...(next ? [next] : []), ...(write ? [write] : [])]);
  }
});
