/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ModelStore } from './models.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';

export const traeEndpointSchema = z.strictObject({
  endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/).refine((value) => {
    try { return Number(new URL(value).port) <= 65535; } catch { return false; }
  }),
});
const responseSchema = z.object({ object: z.literal('list'), data: z.array(z.object({
  id: z.string().min(1).max(200), object: z.literal('model'), owned_by: z.string().max(200),
  name: z.string().max(200), context_window: z.number().int().min(1024).max(2_000_000),
})).max(512) }).refine((value) => new Set(value.data.map((model) => model.id)).size === value.data.length);
export async function discoverTraeModels(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { endpoint } = traeEndpointSchema.parse(input);
  const credential = process.env.OHMATE_TRAE_BRIDGE_KEY;
  if (!credential) { return { exitCode: 5, data: { code: 'MODEL_CREDENTIAL_MISSING', credentialEnv: 'OHMATE_TRAE_BRIDGE_KEY' } }; }
  let response: Response;
  try {
    response = await fetch(`${endpoint}/models`, { headers: { authorization: `Bearer ${credential}` }, redirect: 'error',
      signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(10_000)]) });
  } catch { throw new Error('TRAE_BRIDGE_UNREACHABLE'); }
  if (!response.ok || response.headers.get('x-ohmate-model-bridge') !== 'vscode-lm-v1') {
    await response.body?.cancel(); throw new Error(response.status === 401 ? 'TRAE_BRIDGE_AUTH_FAILED' : 'TRAE_BRIDGE_NOT_VERIFIED');
  }
  const reader = response.body?.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  if (!reader) { throw new Error('TRAE_BRIDGE_RESPONSE_INVALID'); }
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { break; }
      bytes += part.value.length;
      if (bytes > 256 * 1024) { throw new Error('TRAE_BRIDGE_RESPONSE_INVALID'); }
      parts.push(part.value);
    }
  } finally { await reader.cancel(); }
  let models: z.infer<typeof responseSchema>['data'];
  try { models = responseSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8'))).data; }
  catch { throw new Error('TRAE_BRIDGE_RESPONSE_INVALID'); }
  if (!models.length) { return { exitCode: 5, data: { code: 'TRAE_MODELS_NOT_EXPOSED', models: [], hostVerified: false } }; }
  const configs = models.map((model) => ({
    id: `trae-${createHash('sha256').update(`${endpoint}\0${model.id}`).digest('hex').slice(0, 24)}`,
    api: 'openai-completions' as const, model: model.id, endpoint, credentialEnv: 'OHMATE_TRAE_BRIDGE_KEY',
    contextWindow: model.context_window, maxTokens: Math.max(64, Math.min(4096, Math.floor(model.context_window / 4))),
  }));
  await new ModelStore(context.dataDir).addDiscovered(configs);
  return { exitCode: 0, data: { models: configs, selectedAutomatically: false,
    source: 'vscode-lm', actualHostModelCall: 'unverified', scope: 'host-exposed-models-only' } };
}
