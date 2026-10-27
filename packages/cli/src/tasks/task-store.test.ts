/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, appendFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-tasks-'));
  roots.push(root);
  return root;
}

describe('durable task event store', () => {
  it('lists an empty store without creating files', async () => {
    const root = await directory();
    const { TaskStore } = await import('./index.js');
    expect(await new TaskStore(join(root, 'data')).list()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('reports a damaged task instead of silently hiding every task', async () => {
    const root = await directory();
    const { TaskStore } = await import('./index.js');
    const store = new TaskStore(root);
    const first = await store.create({ toolId: 'doctor', input: {}, projectRoot: root });
    await store.create({ toolId: 'doctor', input: {}, projectRoot: root });
    await unlink(join(root, 'tasks', first.id, 'events.ndjson'));
    await expect(store.list()).rejects.toThrow();
  });

  it('reopens tasks and sequences events across independent store instances', async () => {
    const root = await directory();
    const { TaskStore } = await import('./index.js');
    const first = new TaskStore(root);
    const task = await first.create({ toolId: 'doctor', input: {}, projectRoot: root });
    await first.transition(task.id, 'planning');
    const second = new TaskStore(root);
    expect((await second.show(task.id)).state).toBe('planning');
    await second.transition(task.id, 'running');
    const events = await first.events(task.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect((await first.events(task.id, 1)).map((event) => event.sequence)).toEqual([2, 3]);
    await expect(first.transition(task.id, 'queued')).rejects.toThrow(/transition/i);
  });

  it('serializes concurrent appenders without duplicate sequence numbers', async () => {
    const root = await directory();
    const { TaskStore } = await import('./index.js');
    const first = new TaskStore(root), second = new TaskStore(root);
    const task = await first.create({ toolId: 'doctor', input: {}, projectRoot: root });
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : second).append(task.id, 'task.note', { index }),
    ));
    expect((await first.events(task.id)).map((event) => event.sequence)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1),
    );
  });

  it('recovers a torn final append but rejects path traversal and secret input', async () => {
    const root = await directory();
    const { TaskStore } = await import('./index.js');
    const store = new TaskStore(root);
    const task = await store.create({ toolId: 'doctor', input: {}, projectRoot: root });
    await appendFile(join(root, 'tasks', task.id, 'events.ndjson'), '{"partial"');
    await store.append(task.id, 'task.note', { recovered: true });
    expect((await store.events(task.id)).map((event) => event.sequence)).toEqual([1, 2]);
    await expect(store.show('../elsewhere')).rejects.toThrow(/task id/i);
    await expect(store.create({ toolId: 'test', input: { apiKey: 'fixture-secret' }, projectRoot: root })).rejects.toThrow(/secret/i);
  });

  it('refuses malformed process records before they can reach cancellation', async () => {
    const root = await directory();
    const { TaskStore } = await import('./index.js');
    const store = new TaskStore(root);
    const task = await store.create({ toolId: 'doctor', input: {}, projectRoot: root });
    await expect(store.append(task.id, 'process.started', { pid: 'not-a-pid', identity: '', group: true })).rejects.toThrow();
    expect(await store.events(task.id)).toHaveLength(1);
  });
});
