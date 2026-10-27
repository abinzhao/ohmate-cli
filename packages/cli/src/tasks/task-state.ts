/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import type { TaskEvent, TaskRecord, TaskState } from './types.js';
import type { Receipt } from '../runtime/index.js';
import type { ApprovalPlan } from '../runtime/approval.js';
import { secretKey, redactTaskValue } from './task-redaction.js';

export const taskRequestSchema = z.strictObject({
  toolId: z.string().min(1), input: z.unknown(), projectRoot: z.string().nullable(),
  cwd: z.string().optional(), locale: z.enum(['zh-CN', 'en-US']).optional(),
  target: z.strictObject({ device: z.string().optional() }).optional(), sessionId: z.string().optional(),
});
const processSchema = z.strictObject({
  pid: z.number().int().positive(), identity: z.string().regex(/^[a-f0-9]{64}$/),
  group: z.boolean(), attempt: z.string().uuid(),
});

const transitions: Record<TaskState, TaskState[]> = {
  queued: ['planning', 'cancelled', 'blocked'],
  planning: ['awaiting-approval', 'running', 'failed', 'cancelled', 'blocked'],
  'awaiting-approval': ['running', 'cancelled', 'blocked'],
  running: ['verifying', 'failed', 'cancelled', 'blocked'],
  verifying: ['succeeded', 'failed', 'cancelled', 'blocked'],
  succeeded: [], failed: [], cancelled: [], blocked: [],
};

export function assertPublicValue(value: unknown): void {
  if (typeof value === 'string' && redactTaskValue(value) !== value) {
    throw new Error('Task input contains a secret; use an environment variable reference');
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (secretKey.test(key)) {
        throw new Error('Task input contains a secret field; use a secure reference');
      }
      assertPublicValue(child);
    }
  }
}

export function reduceTask(events: TaskEvent[]): TaskRecord {
  const first = events[0];
  if (!first || first.type !== 'task.created') {
    throw new Error('Task created event is missing');
  }
  const task: TaskRecord = {
    ...taskRequestSchema.parse(first.payload), id: first.taskId, state: 'queued',
    createdAt: first.time, updatedAt: first.time, sequence: 1, cancelRequested: false, forceRequested: false, processes: [],
  };
  for (const event of events.slice(1)) {
    if (event.type === 'task.state') {
      const next = (event.payload as { state: TaskState }).state;
      if (!transitions[task.state].includes(next)) {
        throw new Error(`Invalid task transition: ${task.state} -> ${next}`);
      }
      task.state = next;
    }
    if (event.type === 'task.created') { throw new Error('Duplicate task creation'); }
    if (event.type === 'task.cancel-requested') { task.cancelRequested = true; }
    if (event.type === 'task.force-requested') { task.forceRequested = true; }
    if (event.type === 'task.receipt') { task.receipt = event.payload as Receipt; }
    if (event.type === 'agent.session') {
      const sessionId = z.strictObject({ sessionId: z.string().uuid() }).parse(event.payload).sessionId;
      if (task.toolId !== 'agent.run' || (task.sessionId && task.sessionId !== sessionId)) { throw new Error('Invalid task session association'); }
      task.sessionId = sessionId;
    }
    if (event.type === 'task.plan') { task.plan = event.payload as ApprovalPlan; }
    if (event.type === 'task.approved') {
      const planId = (event.payload as { planId: string }).planId;
      if (task.state !== 'awaiting-approval' || task.plan?.planId !== planId) { throw new Error('Invalid approval plan'); }
      task.approvedPlan = planId;
    }
    if (event.type === 'process.started') { task.processes.push(processSchema.parse(event.payload)); }
    if (event.type === 'process.closed') {
      const { pid, attempt } = processSchema.parse(event.payload);
      task.processes = task.processes.filter((item) => item.pid !== pid || item.attempt !== attempt);
    }
    if (event.type === 'task.recovery') {
      if (!['queued', 'planning', 'running', 'verifying'].includes(task.state)) { throw new Error('Invalid recovery state'); }
      task.state = 'queued'; task.approvedPlan = undefined; task.receipt = undefined; task.processes = [];
    }
    task.updatedAt = event.time;
    task.sequence = event.sequence;
  }
  return task;
}
