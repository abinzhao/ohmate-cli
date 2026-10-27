/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { LocalState } from './local-state.js';

const common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  model: z.string().min(1).max(200),
  contextWindow: z.coerce.number().int().min(1024).max(2_000_000).default(32_768),
  maxTokens: z.coerce.number().int().min(64).max(32_768).default(4096),
};
export const endpointModelSchema = z.strictObject({
  ...common,
  api: z.enum(['openai-completions', 'anthropic-messages', 'google-generative-ai']),
  endpoint: z.string().url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  }, 'Endpoint must use HTTPS or local loopback without embedded credentials'),
  credentialEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
});
export const traeExecutableSchema = z.string().min(1).max(4096).refine(value =>
  value === 'trae-cli' || ((value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) && !/[\0\r\n]/.test(value)),
  'Use trae-cli from PATH or an absolute executable path');
export const traeCliModelSchema = z.strictObject({ ...common, api: z.literal('trae-cli'), executable: traeExecutableSchema });
export const modelSchema = z.discriminatedUnion('api', [endpointModelSchema, traeCliModelSchema]);
export type ModelConfig = z.infer<typeof modelSchema>;
const stateSchema = z.strictObject({ selected: z.string().nullable(), models: z.array(modelSchema) });
const empty = { selected: null, models: [] };

export class ModelStore {
  private readonly state: LocalState;
  constructor(dataDir: string) { this.state = new LocalState(dataDir); }
  async list(): Promise<ModelConfig[]> { return (await this.state.read('models', stateSchema, empty)).models; }
  async selected(): Promise<ModelConfig | null> {
    const value = await this.state.read('models', stateSchema, empty);
    return value.models.find((model) => model.id === value.selected) ?? null;
  }
  async get(id: string): Promise<ModelConfig> {
    const model = (await this.list()).find((item) => item.id === id);
    if (!model) { throw new Error('Model is not configured'); }
    return model;
  }
  async add(input: unknown): Promise<ModelConfig> {
    const model = modelSchema.parse(input);
    await this.state.update('models', stateSchema, empty, (value) => {
      if (value.models.some((item) => item.id === model.id)) { throw new Error('Model already exists'); }
      return { ...value, models: [...value.models, model] };
    });
    return model;
  }
  async select(id: string): Promise<void> {
    await this.get(id);
    await this.state.update('models', stateSchema, empty, (value) => ({ ...value, selected: id }));
  }
  async addDiscovered(input: ModelConfig[]): Promise<void> {
    const models = z.array(modelSchema).parse(input);
    await this.state.update('models', stateSchema, empty, (value) => {
      const next = [...value.models];
      for (const model of models) {
        const existing = next.find((item) => item.id === model.id);
        if (existing && Object.keys(model).some((key) =>
          existing[key as keyof ModelConfig] !== model[key as keyof ModelConfig])) { throw new Error('Model configuration collision'); }
        if (!existing) { next.push(model); }
      }
      return { ...value, models: next };
    });
  }
  async remove(id: string): Promise<void> {
    await this.state.update('models', stateSchema, empty, (value) => ({
      selected: value.selected === id ? null : value.selected, models: value.models.filter((item) => item.id !== id),
    }));
  }
}
