/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { SessionStore } from './sessions.js';
import { LocalState } from './local-state.js';
import { readMaterial, sha256 } from './context-files.js';
import { getModelSpecs } from './model-specs.js';
import { getContextSpecs } from './context-specs.js';
import { agentRunSchema, runAgent, type AgentRunInput } from './agent-runner.js';
import { idArgument, serviceSpec, valueOption } from './service-spec.js';
import type { OHMateRuntime, ToolSpec } from '../runtime/index.js';

export function getAgentSpecs(runtime: OHMateRuntime): ToolSpec[] {
  const query = z.strictObject({ id: z.string().uuid() });
  const runOptions = [
    valueOption('files', 'Explicit context files', true), valueOption('allowed-tools', 'Tool IDs approved for this run', true),
    valueOption('write-paths', 'Exact public paths the Agent may propose to change', true),
    ...['session-id', 'model-id', 'preview-hash', 'max-turns', 'max-tool-calls', 'max-bytes'].map((name) => valueOption(name, name)),
  ];
  return [
    ...getModelSpecs(), ...getContextSpecs(runtime),
    serviceSpec('agent.run', 'Execute a bounded BYOK Agent task with preview-bound context', agentRunSchema,
      (input, context) => runAgent(runtime, input as AgentRunInput, context), runOptions,
      [{ name: 'prompt', required: true, variadic: false }]),
    { ...serviceSpec('agent.chat', 'Open the interactive terminal console', z.strictObject({}), async (_, context) =>
      context.console ? context.console() : { exitCode: 5, data: { code: 'CHAT_REQUIRES_TERMINAL' } }), protocol: true, timeoutMs: 0 },
    serviceSpec('session.list', 'List persistent conversations independently of Web', z.strictObject({}),
      async (_, context) => ({ exitCode: 0, data: (await new SessionStore(context.dataDir).list()).map(({ entries, ...session }) => ({ ...session, entries: entries.length })) })),
    ...['show', 'resume'].map((verb) => serviceSpec(`session.${verb}`, 'Inspect conversation history and resume context', query,
      async (input, context) => ({ exitCode: 0, data: { session: await new SessionStore(context.dataDir).show((input as { id: string }).id),
        resume: `ohmatecli agent run <prompt> --session-id ${(input as { id: string }).id}` } }), [], idArgument)),
    serviceSpec('session.export', 'Export a redacted conversation snapshot to local product storage', query, async (input, context) => {
      const exported = await new SessionStore(context.dataDir).export((input as { id: string }).id);
      return { exitCode: 0, data: { sessionId: exported.session.id }, artifacts: [{
        path: `${new LocalState(context.dataDir).root}/${exported.name}`, kind: 'session', sha256: sha256(JSON.stringify(exported.session)),
      }] };
    }, [], idArgument),
    { ...serviceSpec('workspace.read', 'Read a bounded public text file within the project root', z.strictObject({ path: z.string().max(1024) }),
      async (input, context) => ({ exitCode: 0, data: await readMaterial(context.projectRoot ?? context.cwd, (input as { path: string }).path, 'file', context.dataDir) }),
      [], [{ name: 'path', required: true, variadic: false }]), idempotency: 'read', recovery: 'verify-and-retry' },
  ];
}
