/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export type NamingStrategy = (name: string) => string;

export const NamingStrategies = {
  identity: (name: string): string => name,
  camelCase: (name: string): string => name,
  snakeCase: (name: string): string =>
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase(),
} as const;

export interface SerializerConfig {
  namingStrategy?: NamingStrategy;
  fieldNames?: Record<string, string>;
  pretty?: boolean;
}

export class JsonSerializer {
  constructor(private readonly config: SerializerConfig = {}) {}

  serialize(value: unknown): string {
    const transformed = this.transform(value);
    return this.config.pretty
      ? JSON.stringify(transformed, null, 2)
      : JSON.stringify(transformed);
  }

  toObject(value: unknown): unknown {
    return this.transform(value);
  }

  private transform(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.transform(item));
    }
    if (typeof value !== 'object') {
      return value;
    }
    const strategy = this.config.namingStrategy ?? NamingStrategies.identity;
    const overrides = this.config.fieldNames ?? {};
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const wireName = overrides[key] ?? strategy(key);
      result[wireName] = this.transform(val);
    }
    return result;
  }
}

export const eventSerializer = new JsonSerializer({
  namingStrategy: NamingStrategies.snakeCase,
  fieldNames: {},
});

export function serializeEvent(event: unknown): string {
  return eventSerializer.serialize(event);
}
