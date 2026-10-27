/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ContextService, previewSchema } from './context-service.js';
import { SessionStore } from './sessions.js';
import { agentSpecs, agentTools } from './agent-tools.js';
import { acquireDataLock } from '../runtime/execution-lock.js';
import { redactTaskValue } from '../tasks/task-redaction.js';
import type { ExecutionContext, OHMateRuntime, ToolResult } from '../runtime/index.js';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';

export const agentRunSchema = previewSchema.extend({
  prompt: z.string().min(1).max(32_768), previewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  maxTurns: z.coerce.number().int().min(1).max(20).default(8), maxToolCalls: z.coerce.number().int().min(1).max(50).default(20),
});
export type AgentRunInput = z.infer<typeof agentRunSchema>;
function blocked(code: string, extra: unknown = {}): ToolResult { return { exitCode: 5, data: { code, ...(extra as object) } }; }

function safeValue(value: unknown, credential: string): unknown {
  const text = JSON.stringify(value);
  return redactTaskValue(JSON.parse(credential ? text.split(credential).join('[REDACTED]') : text));
}

export async function runAgent(runtime: OHMateRuntime, request: AgentRunInput, context: ExecutionContext): Promise<ToolResult> {
  const service = new ContextService(context, runtime.registry);
  const input = { prompt: request.prompt, files: request.files, writePaths: request.writePaths, sessionId: request.sessionId,
    modelId: request.modelId, allowedTools: request.allowedTools, maxBytes: request.maxBytes };
  const preview = await service.preview(input);
  if (!preview.model) { return blocked('MODEL_REQUIRED', { configure: 'ohmatecli model add --help' }); }
  if (request.previewHash !== preview.hash) {
    return blocked(request.previewHash ? 'CONTEXT_APPROVAL_STALE' : 'CONTEXT_APPROVAL_REQUIRED',
      { preview, resume: 'Review context preview, then pass --preview-hash <hash>' });
  }
  agentSpecs(runtime, request.allowedTools);
  const credential = preview.model.api === 'trae-cli' ? '' : process.env[preview.model.credentialEnv];
  if (preview.model.api !== 'trae-cli' && !credential) {
    return blocked('MODEL_CREDENTIAL_MISSING', { credentialEnv: preview.model.credentialEnv });
  }
  const sessions = new SessionStore(context.dataDir);
  const session = request.sessionId ? await sessions.show(request.sessionId) : await sessions.create(context.projectRoot);
  const release = await acquireDataLock(context.dataDir, `agent-session:${session.id}`);
  try {
    const latest = await service.preview(input);
    if (latest.hash !== preview.hash) { return blocked('CONTEXT_APPROVAL_STALE'); }
    return await executeAgent(runtime, request, { ...context, sessionId: session.id }, preview, credential ?? '', sessions);
  } finally { await release(); }
}

async function executeAgent(runtime: OHMateRuntime, request: AgentRunInput, context: ExecutionContext,
  preview: Awaited<ReturnType<ContextService['preview']>>, credential: string, sessions: SessionStore): Promise<ToolResult> {
  const { PiAgentAdapter } = await import('./pi-adapter.js');
  const sessionId = context.sessionId!, state = { pending: [] as string[], receipts: [] as import('../runtime/types.js').Receipt[] };
  await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, type: 'agent.session', time: new Date().toISOString(), payload: { sessionId } });
  await sessions.append(sessionId, 'context', { hash: preview.hash, bytes: preview.bytes, materials: preview.materials.map((material) => ({
    path: material.path, source: material.source, sha256: material.sha256, bytes: material.bytes, redacted: material.redacted,
  })),
    modelId: preview.model!.id, allowedTools: request.allowedTools, writeScope: preview.writeScope });
  const onEvent = async (event: AgentEvent) => {
    if (event.type === 'message_end') { await sessions.append(sessionId, 'message', safeValue(event.message, credential)); }
    if (event.type === 'tool_execution_end') { await sessions.append(sessionId, 'tool.receipt', safeValue(event.result, credential)); }
    const payload = event.type === 'message_end' ? safeValue(event.message, credential) : { type: event.type };
    await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, type: `agent.${event.type}`, time: new Date().toISOString(), payload });
  };
  const result = await new PiAgentAdapter().run({
    model: preview.model!, credential, prompt: preview.promptText, history: preview.history as AgentMessage[],
    tools: agentTools(runtime, agentSpecs(runtime, request.allowedTools), context, request.files, state, preview.writeScope),
    signal: context.abortSignal, maxTurns: request.maxTurns, maxToolCalls: request.maxToolCalls,
    shouldStop: () => state.pending.length > 0, onEvent,
  });
  const data = { sessionId, adapter: 'pi-sdk', sdkVersion: '1.4.0', modelId: preview.model!.id,
    text: safeValue(result.text, credential), turns: result.turns, toolCalls: result.toolCalls, pendingTasks: state.pending,
    contextHash: preview.hash, costEstimate: null };
  if (context.abortSignal.aborted) { return { exitCode: 130, data: { ...data, code: 'AGENT_CANCELLED' } }; }
  if (state.pending.length) { return blocked('TOOL_APPROVAL_REQUIRED', data); }
  if (result.budgetExhausted) { return blocked('AGENT_BUDGET_EXHAUSTED', data); }
  return { exitCode: result.error ? 6 : 0, data: { ...data, ...(result.error ? { code: 'MODEL_REQUEST_FAILED' } : {}) } };
}
