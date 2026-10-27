/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { assertPublicValue, reduceTask, taskRequestSchema } from './task-state.js';
import type { TaskEvent, TaskRecord, TaskRequest, TaskState } from './types.js';
import type { Receipt } from '../runtime/types.js';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const eventSchema = z.object({
  taskId: z.string(), sequence: z.number().int().positive(), type: z.string(),
  time: z.iso.datetime(), payload: z.unknown(),
});
const MAX_LOG_BYTES = 32 * 1024 * 1024;

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Task directory must not be a symbolic link: ${path}`);
  }
}

async function readEvents(file: string, id: string) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await handle.stat()).size > MAX_LOG_BYTES) { throw new Error('Task log exceeds size limit'); }
    const content = await handle.readFile('utf8');
    const complete = content.slice(0, content.lastIndexOf('\n') + 1);
    const events = complete.split('\n').filter(Boolean).map((line) => eventSchema.parse(JSON.parse(line)));
    for (const [index, event] of events.entries()) {
      if (event.taskId !== id || event.sequence !== index + 1) { throw new Error('Task event identity/sequence mismatch'); }
    }
    return { events, completeBytes: Buffer.byteLength(complete) };
  } finally { await handle.close(); }
}

export class TaskStore {
  readonly root: string;
  constructor(dataDir: string) { this.root = resolve(dataDir, 'tasks'); }

  private directory(id: string): string {
    if (!idPattern.test(id)) { throw new Error('Invalid task id'); }
    return join(this.root, id);
  }

  async create(request: TaskRequest): Promise<TaskRecord> {
    assertPublicValue(request);
    taskRequestSchema.parse(request);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectory(this.root);
    const id = randomUUID(), directory = this.directory(id);
    await mkdir(directory, { mode: 0o700 });
    const event: TaskEvent = { taskId: id, sequence: 1, type: 'task.created', time: new Date().toISOString(), payload: request };
    const handle = await open(join(directory, 'events.ndjson'), 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    return reduceTask([event]);
  }

  async events(id: string, after = 0): Promise<TaskEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) { throw new Error('Invalid event cursor'); }
    const directory = this.directory(id);
    await assertDirectory(this.root);
    await assertDirectory(directory);
    return (await readEvents(join(directory, 'events.ndjson'), id)).events.filter((event) => event.sequence > after);
  }

  async show(id: string): Promise<TaskRecord> { return reduceTask(await this.events(id)); }

  async list(): Promise<TaskRecord[]> {
    try {
      await assertDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
      throw error;
    }
    const names = await readdir(this.root);
    return await Promise.all(names.filter((name) => idPattern.test(name)).map((id) => this.show(id)));
  }

  async transition(id: string, state: TaskState): Promise<TaskRecord> {
    await this.append(id, 'task.state', { state });
    return this.show(id);
  }

  async append(id: string, type: string, payload: unknown): Promise<TaskEvent> {
    assertPublicValue(payload);
    return (await this.commit(id, () => [{ type, payload }]))[0];
  }

  async settle(id: string, receipt: Receipt): Promise<TaskRecord> {
    assertPublicValue(receipt);
    await this.commit(id, (events) => {
      const task = reduceTask(events);
      if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(task.state)) { return []; }
      const entries = [{ type: 'task.receipt', payload: receipt as unknown }];
      if (receipt.exitCode === 130 || receipt.exitCode === 5) {
        entries.push({ type: 'task.state', payload: { state: receipt.exitCode === 130 ? 'cancelled' : 'blocked' } });
      } else {
        if (task.state === 'running') { entries.push({ type: 'task.state', payload: { state: 'verifying' } }); }
        entries.push({ type: 'task.state', payload: { state: receipt.exitCode === 0 ? 'succeeded' : 'failed' } });
      }
      return entries;
    });
    return this.show(id);
  }

  private async commit(id: string, build: (events: TaskEvent[]) => Array<{ type: string; payload: unknown }>): Promise<TaskEvent[]> {
    const directory = this.directory(id);
    await assertDirectory(this.root);
    await assertDirectory(directory);
    const canonical = await realpath(directory);
    const release = await lockfile.lock(canonical, { retries: { retries: 50, factor: 1, minTimeout: 10, maxTimeout: 40 } });
    try {
      const file = join(canonical, 'events.ndjson');
      const { events, completeBytes } = await readEvents(file, id);
      const added = build(events).map((entry, index) => ({
        ...entry, taskId: id, sequence: events.length + index + 1, time: new Date().toISOString(),
      }));
      reduceTask([...events, ...added]);
      await this.writeEvents(file, added, completeBytes);
      return added;
    } finally { await release(); }
  }

  private async writeEvents(file: string, events: TaskEvent[], completeBytes: number): Promise<void> {
    const line = events.map((event) => `${JSON.stringify(event)}\n`).join('');
    if (Buffer.byteLength(line) + completeBytes > MAX_LOG_BYTES) { throw new Error('Task log exceeds size limit'); }
    const handle = await open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.truncate(completeBytes);
      await handle.write(line, completeBytes, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }
}
