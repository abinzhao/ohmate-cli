/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ResourceBusyError } from '../runtime/execution-lock.js';
import type { ToolSpec } from '../runtime/types.js';

export const idArgument = [{ name: 'id', required: true, variadic: false }];
export function serviceSpec(id: string, description: string, schema: ToolSpec['inputSchema'], execute: ToolSpec['execute'],
  options: ToolSpec['options'] = [], arguments_: ToolSpec['arguments'] = []): ToolSpec {
  return {
    id, command: id.split('.'), description, inputSchema: schema,
    outputSchema: z.object({ exitCode: z.number(), data: z.unknown() }).passthrough(),
    risk: 'R0', requirements: [], timeoutMs: 300_000, cancellable: true,
    idempotency: 'artifact', recovery: 'manual', evidence: ['receipt'], adapter: 'native', options, arguments: arguments_,
    execute: async (input, context) => {
      try { return await execute(input, context); }
      catch (error) {
        if (context.abortSignal.aborted) { return { exitCode: 130, data: { code: 'CANCELLED' } }; }
        return { exitCode: error instanceof ResourceBusyError ? 5 : 4,
          data: { code: error instanceof ResourceBusyError ? 'RESOURCE_BUSY' : 'REQUEST_INVALID',
            message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}
export function valueOption(name: string, description: string, variadic = false): ToolSpec['options'][number] {
  return { flags: `--${name} <value${variadic ? '...' : ''}>`, description, required: true, optional: false, mandatory: false };
}
