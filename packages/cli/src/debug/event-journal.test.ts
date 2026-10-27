/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { identity, event } from '../debug-protocol/test-fixtures.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-debug-journal-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function journal(): Promise<typeof import('./event-journal.js')> {
  expect(existsSync(new URL('./event-journal.ts', import.meta.url)), 'durable debug event journal is missing').toBe(true);
  const entry = './event-journal.js';
  return import(entry);
}
async function start(options: Record<string, number> = {}) {
  const { EventJournal } = await journal();
  const handshake = createHandshake(identity);
  const store = await EventJournal.create(root, randomUUID(), handshake, options);
  const receiver = createReadonlyBridge(handshake);
  receiver.connect(handshake, 'epoch-1');
  return { store, receiver };
}

it('persists ordered immutable events and verifies checksums after reopening', async () => {
  const { store, receiver } = await start();
  await store.append(receiver.accept(event(1)));
  await store.append(receiver.accept(event(2)));
  const { EventJournal } = await journal();
  const read = await EventJournal.read(root, store.sessionId, store.streamId);
  expect(read.events.map((item) => item.event.sequence)).toEqual([1, 2]);
  expect(read.events[0].clock.segment).toBe(1);
  expect(read.events[1].clock.segment).toBe(1);
  expect(read.manifest).toMatchObject({ buildVerification: 'unverified', deviceProvenance: 'peer-asserted',
    authentication: 'pairing-proof', handshake: { identity } });
  const original = await readFile(join(store.root, '00000001.json'));
  await expect(store.append(receiver.accept(event(1)))).rejects.toThrow('JOURNAL_SEQUENCE_INVALID');
  expect(await readFile(join(store.root, '00000001.json'))).toEqual(original);
});

it('redacts text secrets and user identifiers again before persisting device summaries', async () => {
  const { store, receiver } = await start();
  const summary = 'token=TEST_TOKEN cookie=SESSION_VALUE password="pass word" https://debug.test/?name=Alice 13800138000 sample@example.test';
  await store.append(receiver.accept(event(1, { payload: { level: 'info', summary } })));
  const disk = await readFile(join(store.root, '00000001.json'), 'utf8');
  for (const field of ['TEST_TOKEN', 'SESSION_VALUE', 'pass word', 'Alice', '13800138000', 'sample@example.test']) {
    expect(disk).not.toContain(field);
  }
  expect(disk).toContain('REDACTED');
});

it.each([
  ['arkweb.console', { level: 'info', summary: 'private page text' }],
  ['arkweb.dom', { targetId: 'page-1', nodeCount: 3, summary: 'private page text' }],
  ['arkweb.storage', { targetId: 'page-1', entryCount: 3, summary: 'private page text' }],
  ['ui', { windowId: 'window-1', nodeCount: 3, summary: 'private page text' }],
])('persists only metadata for memory-only %s content', async (channel, payload) => {
  const { store, receiver } = await start();
  await store.append(receiver.accept(event(1, { channel, capability: `${channel}.read`, payload })));
  const disk = await readFile(join(store.root, '00000001.json'), 'utf8');
  expect(disk).not.toContain('private page text');
  expect(disk).toContain('MEMORY_ONLY');
});

it('fails closed on quota exhaustion without removing prior evidence', async () => {
  const { store, receiver } = await start({ maxEvents: 1, maxBytes: 16384 });
  await store.append(receiver.accept(event(1)));
  await expect(store.append(receiver.accept(event(2)))).rejects.toThrow('JOURNAL_LIMIT');
  const { EventJournal } = await journal();
  expect((await EventJournal.read(root, store.sessionId, store.streamId)).events).toHaveLength(1);
});

it('rejects tampered, truncated, missing and reordered records', async () => {
  const { store, receiver } = await start();
  await store.append(receiver.accept(event(1)));
  await store.append(receiver.accept(event(2)));
  const file = join(store.root, '00000001.json'), bytes = await readFile(file);
  const { EventJournal } = await journal();
  const read = () => EventJournal.read(root, store.sessionId, store.streamId);
  await writeFile(file, '{"index":1');
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
  await writeFile(file, bytes);
  const value = JSON.parse(bytes.toString()); value.event.payload.summary = 'changed';
  await writeFile(file, JSON.stringify(value));
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
  await rm(file);
  await expect(read()).rejects.toThrow('JOURNAL_CORRUPT');
});

it('rejects unsafe directories, symbolic links and multiply linked event files', async () => {
  const { EventJournal } = await journal();
  const target = join(root, 'elsewhere');
  await mkdir(target);
  await symlink(target, join(root, 'debug-events'));
  await expect(EventJournal.create(root, randomUUID(), createHandshake(identity))).rejects.toThrow();
  await rm(join(root, 'debug-events'));
  const { store, receiver } = await start();
  await store.append(receiver.accept(event(1)));
  const file = join(store.root, '00000001.json'), bytes = await readFile(file);
  await writeFile(join(root, 'outside.json'), bytes);
  await rm(file);
  await symlink(join(root, 'outside.json'), file);
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_UNSAFE');
  await rm(file); await link(join(root, 'outside.json'), file);
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_UNSAFE');
});

it('exposes only bounded evidence and refuses a second writer or unknown on-disk entries', async () => {
  const { store, receiver } = await start();
  const first = receiver.accept(event(1));
  const writing = store.append(first);
  await expect(store.append(first)).rejects.toThrow('JOURNAL_SEQUENCE_INVALID');
  await writing;
  const { EventJournal } = await journal();
  expect((await EventJournal.read(root, store.sessionId, store.streamId)).events).toHaveLength(1);
  await writeFile(join(store.root, 'unknown.json'), '{}');
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
  expect(await readdir(store.root)).toContain('00000001.json');
});

it('rejects deletion of the committed tail even when the remaining hash chain is valid', async () => {
  const { store, receiver } = await start();
  await store.append(receiver.accept(event(1)));
  await store.append(receiver.accept(event(2)));
  await rm(join(store.root, '00000002.json'));
  const { EventJournal } = await journal();
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
});

it('rejects journals with a missing commit anchor rather than guessing an acknowledged prefix', async () => {
  const { store, receiver } = await start();
  await store.append(receiver.accept(event(1)));
  await rm(join(store.root, 'checkpoint.json'), { force: true });
  const { EventJournal } = await journal();
  await expect(EventJournal.read(root, store.sessionId, store.streamId)).rejects.toThrow('JOURNAL_CORRUPT');
});
