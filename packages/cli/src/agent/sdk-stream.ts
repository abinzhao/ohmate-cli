/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model, Api, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { ModelConfig } from './models.js';

export function sdkModel(config: ModelConfig): Model<Api> {
  return {
    id: config.model, name: config.model, api: config.api === 'trae-cli' ? 'openai-completions' : config.api,
    provider: config.api === 'trae-cli' ? 'ohmate-trae-cli' : 'ohmate-custom',
    baseUrl: config.api === 'trae-cli' ? '' : config.endpoint,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow, maxTokens: config.maxTokens,
    ...(config.api === 'openai-completions' ? { compat: {
      supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      supportsUsageInStreaming: true, maxTokensField: 'max_tokens' as const, supportsStrictMode: false,
    } } : {}),
  };
}

async function dispatch(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) {
  if (model.api === 'openai-completions') {
    const api = await import('@earendil-works/pi-ai/api/openai-completions');
    return api.streamSimple(model as Model<'openai-completions'>, context, options);
  }
  if (model.api === 'anthropic-messages') {
    const api = await import('@earendil-works/pi-ai/api/anthropic-messages');
    return api.streamSimple(model as Model<'anthropic-messages'>, context, options);
  }
  const api = await import('@earendil-works/pi-ai/api/google-generative-ai');
  return api.streamSimple(model as Model<'google-generative-ai'>, context, options);
}

export function sdkStream(config: ModelConfig, credential: string): StreamFn {
  return async (model, context, options) => {
    if (config.api === 'trae-cli') {
      return (await import('./trae-cli-stream.js')).streamTraeCli(config, model, context, options?.signal);
    }
    return dispatch(model, context, {
    ...options, apiKey: credential, maxTokens: config.maxTokens,
    cacheRetention: 'none', timeoutMs: 60_000, maxRetries: 0, maxRetryDelayMs: 1,
    identity: { attribution: null },
    });
  };
}

export async function budgetExceeded(model: Model<Api>): Promise<AssistantMessageEventStream> {
  const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream');
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'error', reason: 'error', error: {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
    stopReason: 'error', errorMessage: 'AGENT_CONTEXT_BUDGET', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } });
  return stream;
}
