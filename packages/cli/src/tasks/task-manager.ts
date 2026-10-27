/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { acquireDataLock } from '../runtime/execution-lock.js';
import { processIdentity, stopRecordedProcess } from '../runtime/process-tree.js';
import { toolContext } from '../runtime/tool-context.js';
import { isProblemPackageTool } from '../problem-package/index.js';
import { isInspectorTool } from '../debug/index.js';
import { assertPublicValue } from './task-state.js';
import { executeTask, finishTask, taskContext, controlReceipt } from './task-execution.js';
import { launchTaskWorker } from './task-worker-launcher.js';
import { TaskStore } from './task-store.js';
import type { ExecutionContext, OHMateRuntime, ToolSpec } from '../runtime/index.js';
import type { TaskRecord } from './types.js';

export class TaskManager {
  readonly store: TaskStore;
  constructor(private readonly runtime: OHMateRuntime, private readonly context: ExecutionContext) {
    this.store = new TaskStore(context.dataDir);
  }

  private validate(toolId: string, input: unknown): ToolSpec {
    const spec = this.runtime.registry.get(toolId);
    if (!spec) { throw new Error('Unknown task tool'); }
    if (toolId.startsWith('task.') || (toolId.startsWith('agent.') && toolId !== 'agent.run')) { throw new Error('Nested task execution is forbidden'); }
    if (/^(?:ui|debug|devtools|mock)\./.test(toolId) && !isProblemPackageTool(toolId) && !isInspectorTool(toolId)) { throw new Error('Service lifecycle requires a dedicated control entry'); }
    if (spec.protocol) { throw new Error('Protocol tools require a dedicated terminal'); }
    if (!spec.inputSchema.safeParse(input).success) { throw new Error('Invalid task input'); }
    assertPublicValue(input);
    return spec;
  }

  async submit(toolId: string, input: unknown, wait = false): Promise<TaskRecord> {
    const spec = this.validate(toolId, input);
    const context = await toolContext(spec, input, this.context);
    const task = await this.store.create({
      toolId, input: spec.inputSchema.parse(input), projectRoot: context.projectRoot,
      cwd: context.cwd, locale: context.locale, target: context.target,
      sessionId: context.sessionId ?? (toolId === 'agent.run' ? (input as { sessionId?: string }).sessionId : undefined),
    });
    return this.dispatch(task.id, wait);
  }

  private async dispatch(id: string, wait: boolean): Promise<TaskRecord> {
    if (wait) { return this.run(id); }
    await launchTaskWorker(id, this.context.dataDir);
    return this.store.show(id);
  }

  private async exclusive(id: string, operation: (task: TaskRecord) => Promise<TaskRecord>): Promise<TaskRecord> {
    await this.store.show(id);
    const release = await acquireDataLock(this.context.dataDir, `task:${id}`);
    try { return await operation(await this.store.show(id)); }
    finally { await release(); }
  }

  async run(id: string): Promise<TaskRecord> {
    return this.exclusive(id, async (task) => {
      this.validate(task.toolId, task.input);
      if (task.state !== 'queued' && !(task.state === 'awaiting-approval' && task.approvedPlan)) { return task; }
      return executeTask(this.runtime, this.store, task, this.context);
    });
  }

  async approve(id: string, planId: string, wait = false): Promise<TaskRecord> {
    const task = await this.exclusive(id, async (task) => {
      if (task.state !== 'awaiting-approval' || task.plan?.planId !== planId) { throw new Error('Approval plan does not match the task'); }
      const spec = this.validate(task.toolId, task.input), context = await taskContext(task, this.context);
      const policy = await this.runtime.checkPolicy(spec, task.input, { ...context, policy: { ...context.policy, approvedPlan: planId } });
      if (policy) { throw new Error('Approval is stale: project, input, schema or expiry changed'); }
      await this.store.append(id, 'task.approved', { planId });
      return this.store.show(id);
    });
    return this.dispatch(task.id, wait);
  }

  async cancel(id: string, force = false): Promise<TaskRecord> {
    let task = await this.store.show(id);
    if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(task.state)) { return task; }
    await this.store.append(id, 'task.cancel-requested', {});
    if (force) { await this.store.append(id, 'task.force-requested', {}); }
    const processes = [...task.processes].reverse();
    for (const record of processes) {
      await stopRecordedProcess(record, force && record.group);
      if (force && !record.group) { await stopRecordedProcess(record, false); }
    }
    if (force) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && (await this.store.show(id)).processes.some((record) => record.pid !== process.pid)) {
        const alive = await Promise.all(processes.filter((record) => record.pid !== process.pid).map((record) => processIdentity(record.pid)));
        if (!alive.some(Boolean)) { break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    task = await this.store.show(id);
    if (!processes.length) {
      return finishTask(this.store, id, controlReceipt(task, this.context, 'TASK_CANCELLED', 130));
    }
    if (force && !(await Promise.all(processes.map((record) => processIdentity(record.pid)))).some(Boolean)) {
      return finishTask(this.store, id, controlReceipt(task, this.context, 'TASK_CANCELLED', 130));
    }
    return task;
  }

  async resume(id: string, wait = false): Promise<TaskRecord> {
    const task = await this.exclusive(id, async (task) => {
      if (['succeeded', 'failed', 'cancelled', 'blocked', 'awaiting-approval'].includes(task.state)) { return task; }
      const checks = await Promise.all(task.processes.map(async (record) =>
        ({ pid: record.pid, alive: await processIdentity(record.pid) === record.identity }),
      ));
      await this.store.append(id, 'task.recovery-audit', { processes: checks, previousState: task.state });
      if (checks.some((record) => record.alive)) { return task; }
      const spec = this.validate(task.toolId, task.input);
      const risk = await this.runtime.risk(spec, task.input);
      if (task.state !== 'queued' && (risk !== 'R0' || spec.recovery !== 'verify-and-retry')) {
        return finishTask(this.store, id, controlReceipt(task, this.context, 'RECOVERY_REQUIRES_REVIEW', 5));
      }
      if (task.cancelRequested) { return finishTask(this.store, id, controlReceipt(task, this.context, 'TASK_CANCELLED', 130)); }
      await this.store.append(id, 'task.recovery', { previousState: task.state, verified: true });
      return this.store.show(id);
    });
    return task.state === 'queued' ? this.dispatch(id, wait) : task;
  }
}
