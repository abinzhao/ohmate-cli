/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolSpec } from './types.js';
import { toJSONSchema } from 'zod';

export class ToolSpecRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.id)) {
      throw new Error(`Duplicate ToolSpec: ${spec.id}`);
    }
    this.tools.set(spec.id, spec);
  }

  get(id: string): ToolSpec | undefined {
    return this.tools.get(id);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  describe(): unknown[] {
    return this.list().filter((spec) => !spec.hidden).map(({ execute, inputSchema, outputSchema, ...spec }) => {
      void execute;
      return {
        ...spec,
        inputSchema: toJSONSchema(inputSchema),
        outputSchema: toJSONSchema(outputSchema),
      };
    });
  }
}
