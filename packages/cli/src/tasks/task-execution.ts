/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { createExecutionContext } from '../runtime/context.js';
import { processIdentity } from '../runtime/process-tree.js';
import { redactTaskValue } from './task-redaction.js';
import { TaskStore } from './task-store.js';
import { InputInvalidError } from '../runtime/types.js';
import type { ExecutionContext, OHMateRuntime, Receipt, ToolSpec } from '../runtime/index.js';
import type { ApprovalPlan } from '../runtime/approval.js';
import type { TaskRecord } from './types.js';

export async function taskContext(task: TaskRecord, base: ExecutionContext): Promise<ExecutionContext> {
  return createExecutionContext({
    cwd: task.cwd ?? task.projectRoot ?? base.cwd, projectRoot: task.projectRoot ?? undefined,
    dataDir: base.dataDir, locale: task.locale ?? base.locale, target: task.target,
    approvedPlan: task.approvedPlan, taskId: task.id, sessionId: task.sessionId,
    abortSignal: base.abortSignal, forceSignal: base.forceSignal,
  });
}

export function controlReceipt(task: TaskRecord, context: ExecutionContext, code: string, exitCode: 5 | 130): Receipt {
  return {
    schemaVersion: '1.0', toolVersion: process.env.npm_package_version ?? '0.1.0',
    command: task.toolId, status: exitCode === 130 ? 'cancelled' : 'blocked', exitCode,
    locale: context.locale, startedAt: new Date().toISOString(), durationMs: 0,
    project: { root: task.projectRoot, workspaceId: context.workspaceId },
    capabilities: {}, data: { code, partial: task.receipt?.data ?? null },
    taskId: task.id, warnings: [], artifacts: [], provenance: { adapter: 'task-manager' },
  };
}

export async function executeTask(runtime: OHMateRuntime, store: TaskStore, task: TaskRecord, base: ExecutionContext): Promise<TaskRecord> {
  const context = await taskContext(task, base), spec = runtime.registry.get(task.toolId)!;
  if (task.cancelRequested) { return finishTask(store, task.id, controlReceipt(task, context, 'CANCELLED_BEFORE_EXECUTION', 130)); }
  if (task.state === 'queued') { await store.transition(task.id, 'planning'); }
  let policy;
  try { policy = await runtime.checkPolicy(spec, task.input, context); }
  catch (error) {
    const invalid = error instanceof InputInvalidError;
    return finishTask(store, task.id, {
      ...controlReceipt(task, context, 'PLAN_FAILED', 5), exitCode: invalid ? 4 : 6, status: invalid ? 'invalid' : 'failed',
      data: { code: invalid ? 'INPUT_INVALID' : 'PLAN_FAILED', message: error instanceof Error ? error.message : String(error) },
    });
  }
  if (policy) {
    await store.append(task.id, 'task.plan', policy.data as ApprovalPlan);
    if (task.state !== 'awaiting-approval') { await store.transition(task.id, 'awaiting-approval'); }
    return store.show(task.id);
  }
  await store.transition(task.id, 'running');
  return runTool(runtime, store, task, spec, { ...context, stdout: base.stdout, stderr: base.stderr });
}

async function runTool(runtime: OHMateRuntime, store: TaskStore, task: TaskRecord, spec: ToolSpec, context: ExecutionContext): Promise<TaskRecord> {
  const cancel = new AbortController(), force = new AbortController(), attempt = randomUUID();
  const identity = await processIdentity(process.pid);
  if (!identity) { return finishTask(store, task.id, controlReceipt(task, context, 'PROCESS_IDENTITY_UNAVAILABLE', 5)); }
  const record = identity ? { pid: process.pid, identity, group: false, attempt } : null;
  if (record) { await store.append(task.id, 'process.started', record); }
  let pending: Promise<unknown> = Promise.resolve();
  const append = (type: string, payload: unknown) => {
    pending = pending.then(() => store.append(task.id, type, redactTaskValue(payload)));
    return pending.then(() => undefined);
  };
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const current = await store.show(task.id);
      if (current.cancelRequested) { cancel.abort(); }
      if (current.forceRequested) { force.abort(); }
    }).catch(() => { cancel.abort(); });
  }, 150);
  const current = {
    ...context, abortSignal: AbortSignal.any([context.abortSignal, cancel.signal]),
    forceSignal: context.forceSignal ? AbortSignal.any([context.forceSignal, force.signal]) : force.signal,
    eventSink: (event: { type: string; payload: unknown }) => append(event.type, event.payload),
    stdout: (text: string) => { context.stdout?.(text); void append('tool.stdout', { text }); },
    stderr: (text: string) => { context.stderr?.(text); void append('tool.stderr', { text }); },
  };
  try {
    const receipt = await runtime.execute(spec.id, task.input, current);
    await pending;
    const latest = await store.show(task.id);
    const final = latest.cancelRequested && receipt.exitCode !== 0
      ? { ...receipt, exitCode: 130 as const, status: 'cancelled' as const } : receipt;
    await finishTask(store, task.id, redactTaskValue(final) as Receipt);
  } finally {
    clearInterval(timer);
    await pending;
    if (record) { await store.append(task.id, 'process.closed', record); }
  }
  return store.show(task.id);
}

export async function finishTask(store: TaskStore, id: string, receipt: Receipt): Promise<TaskRecord> {
  return store.settle(id, receipt);
}
