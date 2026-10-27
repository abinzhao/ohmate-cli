/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setTimeout } from 'node:timers/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TaskStore } from '../tasks/task-store.js';
import { HttpError } from './http-security.js';
import { processIdentity } from '../runtime/process-tree.js';
import type { TaskRecord } from '../tasks/types.js';

async function finished(task: TaskRecord, cursor: number): Promise<boolean> {
  if (task.state === 'awaiting-approval' && task.approvedPlan) { return false; }
  if (!['succeeded', 'failed', 'cancelled', 'blocked', 'awaiting-approval'].includes(task.state) || cursor < task.sequence) { return false; }
  const alive = await Promise.all(task.processes.map(async (record) => await processIdentity(record.pid) === record.identity));
  return !alive.some(Boolean);
}

async function write(response: ServerResponse, text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { return; }
  if (response.write(text)) { return; }
  await new Promise<void>((resolve) => {
    const finish = () => { response.off('drain', finish); signal.removeEventListener('abort', finish); resolve(); };
    response.once('drain', finish); signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) { finish(); }
  });
}
export async function streamTaskEvents(store: TaskStore, id: string, after: number,
  request: IncomingMessage, response: ServerResponse, serviceSignal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(after) || after < 0) { throw new HttpError(400, 'EVENT_CURSOR_INVALID'); }
  await store.show(id);
  const disconnected = new AbortController(), signal = AbortSignal.any([disconnected.signal, serviceSignal]);
  const close = () => disconnected.abort();
  response.on('close', close);
  const stop = () => response.destroy();
  serviceSignal.addEventListener('abort', stop, { once: true });
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
  response.flushHeaders();
  try {
    let cursor = after, heartbeat = Date.now();
    while (!signal.aborted) {
      const events = await store.events(id, cursor);
      for (const event of events) {
        await write(response, `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`, signal);
        cursor = event.sequence;
      }
      const task = await store.show(id);
      if (await finished(task, cursor)) {
        await write(response, `event: end\ndata: ${JSON.stringify({ state: task.state, sequence: task.sequence })}\n\n`, signal);
        break;
      }
      if (Date.now() - heartbeat >= 15_000) { await write(response, ': heartbeat\n\n', signal); heartbeat = Date.now(); }
      await setTimeout(250, undefined, { signal });
    }
  } catch (error) { if (!signal.aborted) { throw error; } }
  finally { response.off('close', close); serviceSignal.removeEventListener('abort', stop); response.end(); }
}
