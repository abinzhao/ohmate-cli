/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ModelStore, endpointModelSchema, traeExecutableSchema } from './models.js';
import { idArgument, serviceSpec, valueOption } from './service-spec.js';
import type { ExecutionContext, ToolResult, ToolSpec } from '../runtime/types.js';

const traeSchema = z.strictObject({ endpoint: z.string() });
async function checkModel(id: string, context: ExecutionContext): Promise<ToolResult> {
  const model = await new ModelStore(context.dataDir).get(id);
  const credential = model.api === 'trae-cli' ? '' : process.env[model.credentialEnv];
  if (model.api !== 'trae-cli' && !credential) {
    return { exitCode: 5, data: { code: 'MODEL_CREDENTIAL_MISSING', credentialEnv: model.credentialEnv } };
  }
  const { PiAgentAdapter } = await import('./pi-adapter.js');
  let deltas = 0;
  const result = await new PiAgentAdapter().run({
    model: { ...model, maxTokens: 64 }, credential: credential ?? '', prompt: 'Reply with OHMATE_OK. This is an endpoint connectivity check.', history: [],
    tools: [], maxTurns: 1, maxToolCalls: 1, signal: context.abortSignal, shouldStop: () => false,
    onEvent: async (event) => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') { deltas++; } },
  });
  const failed = result.error || !result.text.trim();
  return { exitCode: context.abortSignal.aborted ? 130 : failed ? 6 : 0, data: { modelId: id, api: model.api,
    status: context.abortSignal.aborted ? 'cancelled' : failed ? 'failed' : 'reachable', capabilities: { text: !failed, streaming: deltas > 0,
      toolCalls: 'unverified', multimodal: 'unverified', reasoning: 'unverified' }, costEstimate: null } };
}

export function getModelSpecs(): ToolSpec[] {
  const query = z.strictObject({ id: z.string() });
  return [
    serviceSpec('model.list', 'List configured BYOK endpoints without resolving credentials', z.strictObject({}),
      async (_, context) => ({ exitCode: 0, data: { models: await new ModelStore(context.dataDir).list(), selected: await new ModelStore(context.dataDir).selected() } })),
    serviceSpec('model.trae', 'Discover models exposed by the local TRAE extension without selecting or sending a prompt', traeSchema,
      async (input, context) => (await import('./trae-models.js')).discoverTraeModels(input, context),
      [valueOption('endpoint', 'Local bridge address shown by the TRAE extension')]),
    serviceSpec('model.trae-cli', 'Discover models from the installed TRAE CLI without selecting or sending a prompt',
      z.strictObject({ executable: traeExecutableSchema.default('trae-cli') }),
      async (input, context) => (await import('./trae-cli.js')).discoverTraeCliModels(input, context),
      [{ ...valueOption('executable', 'TRAE CLI executable path (default: trae-cli on PATH)'), required: false }]),
    serviceSpec('model.add', 'Configure an endpoint using an environment variable reference', endpointModelSchema,
      async (input, context) => ({ exitCode: 0, data: await new ModelStore(context.dataDir).add(input) }),
      ['api', 'model', 'endpoint', 'credential-env', 'context-window', 'max-tokens'].map((name) => valueOption(name, name)), idArgument),
    serviceSpec('model.select', 'Explicitly enable a configured BYOK endpoint', query,
      async (input, context) => { await new ModelStore(context.dataDir).select((input as { id: string }).id); return { exitCode: 0, data: { selected: (input as { id: string }).id } }; }, [], idArgument),
    serviceSpec('model.remove', 'Remove an endpoint and disable it if selected', query,
      async (input, context) => { await new ModelStore(context.dataDir).remove((input as { id: string }).id); return { exitCode: 0, data: {} }; }, [], idArgument),
    serviceSpec('model.check', 'Send a small explicit connectivity probe to a configured endpoint', query,
      (input, context) => checkModel((input as { id: string }).id, context), [], idArgument),
  ];
}
