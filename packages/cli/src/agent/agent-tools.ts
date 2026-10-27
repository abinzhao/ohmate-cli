/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import { TaskManager } from '../tasks/task-manager.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { redactTaskValue } from '../tasks/task-redaction.js';
import { toolContext } from '../runtime/tool-context.js';
import { patchSchema } from '../workspace/patch-types.js';
import { isProblemPackageTool } from '../problem-package/index.js';
import { isInspectorTool } from '../debug/index.js';
import type { ExecutionContext, OHMateRuntime, Receipt, ToolSpec } from '../runtime/index.js';

const administration = /^(?:task|session|agent|model|context|rules|memory|extensions|auth|signature|update|skills|serve|mcp|lsp|ui|debug|devtools|mock)(?:\.|$)/;
export interface AgentToolState { pending: string[]; receipts: Receipt[] }

export function agentSpecs(runtime: OHMateRuntime, ids: string[]): ToolSpec[] {
  return [...new Set(ids)].map((id) => {
    const spec = runtime.registry.get(id);
    if (!spec || spec.protocol || (administration.test(id) && !isProblemPackageTool(id) && !isInspectorTool(id)) ||
      (administration.test(spec.command.join('.')) && !isProblemPackageTool(spec.command.join('.')) && !isInspectorTool(spec.command.join('.'))) ||
      id.startsWith('workspace.recovery.') || spec.hidden) {
      throw new Error('Tool is not allowed for Agent execution');
    }
    return spec;
  });
}

export function agentTools(runtime: OHMateRuntime, specs: ToolSpec[], context: ExecutionContext, files: string[], state: AgentToolState,
  writeScope: Array<{ path: string; oldHash: string | null }> = []): AgentTool[] {
  return specs.map((spec): AgentTool => ({
    name: spec.id.replaceAll('.', '__'), label: spec.description, description: `${spec.description}; risk=${spec.risk}; human approval is enforced by Runtime`,
    parameters: z.toJSONSchema(spec.inputSchema, { io: 'input', unrepresentable: 'any' }) as TSchema,
    replay: spec.idempotency === 'read' ? 'safe' : 'never', executionMode: 'sequential',
    execute: async (_, input, signal) => {
      assertPublicValue(input);
      if (spec.id === 'workspace.read' && !files.includes((input as { path: string }).path)) { throw new Error('File was not included in the approved sending preview'); }
      if (spec.id === 'workspace.patch' && patchSchema.parse(input).changes.some((change) =>
        !writeScope.some((scope) => scope.path === change.path && scope.oldHash === change.oldHash))) {
        throw new Error('Patch target or old hash was not included in the approved write scope');
      }
      const scoped = { ...context, policy: { ...context.policy, approvedPlan: undefined },
        abortSignal: signal ? AbortSignal.any([context.abortSignal, signal]) : context.abortSignal };
      const target = await toolContext(spec, input, scoped);
      if (target.projectRoot !== context.projectRoot || target.cwd !== context.cwd) { throw new Error('Agent tool changed the approved project scope'); }
      const task = await new TaskManager(runtime, scoped).submit(spec.id, input, true);
      if (task.state === 'awaiting-approval') { state.pending.push(task.id); }
      const result = redactTaskValue(task.receipt ?? { exitCode: 5, data: { code: 'APPROVAL_REQUIRED', taskId: task.id, plan: task.plan } });
      if (task.receipt) { state.receipts.push(task.receipt); }
      await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, time: new Date().toISOString(),
        type: 'agent.tool.receipt', payload: { taskId: task.id, toolId: spec.id, result } });
      const text = JSON.stringify(result);
      const oversized = Buffer.byteLength(text) > 64 * 1024;
      return { details: { taskId: task.id }, content: [{ type: 'text', text: oversized ? 'Tool output exceeds the model budget; inspect the local task receipt.' : text }],
        isError: task.receipt ? task.receipt.exitCode !== 0 : true, terminate: oversized || state.pending.length > 0 };
    },
  }));
}
