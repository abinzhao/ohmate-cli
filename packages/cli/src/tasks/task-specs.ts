/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { TaskManager } from './task-manager.js';
import { ResourceBusyError } from '../runtime/execution-lock.js';
import type { OHMateRuntime, ToolResult, ToolSpec } from '../runtime/index.js';
import type { TaskRecord } from './types.js';

const idSchema = z.string().uuid();
const query = z.strictObject({ id: idSchema });
const waitOption = { flags: '--wait', description: 'Wait for the final task result', required: false, optional: false, mandatory: false };
const idArgument = { name: 'id', required: true, variadic: false };

function taskResult(task: TaskRecord, wait: boolean): ToolResult {
  return { exitCode: wait ? task.receipt?.exitCode ?? (task.state === 'awaiting-approval' ? 5 : 0) : 0, data: task };
}

export function getTaskSpecs(runtime: OHMateRuntime): ToolSpec[] {
  const make = (verb: string, schema: ToolSpec['inputSchema'], execute: (manager: TaskManager, input: unknown) => Promise<ToolResult>,
    options: ToolSpec['options'] = [], arguments_: ToolSpec['arguments'] = [idArgument]): ToolSpec => ({
    id: `task.${verb}`, command: ['task', verb], description: `Persistent task ${verb}`,
    inputSchema: schema, outputSchema: z.object({ exitCode: z.number(), data: z.unknown() }).passthrough(),
    risk: 'R0', requirements: [], timeoutMs: 0, cancellable: true, idempotency: 'artifact', recovery: 'manual',
    adapter: 'native', evidence: ['events.ndjson', 'receipt'], options, arguments: arguments_,
    execute: async (input, context) => {
      try { return await execute(new TaskManager(runtime, context), input); }
      catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        return { exitCode: error instanceof ResourceBusyError ? 5 : missing ? 2 : 4,
          data: { code: error instanceof ResourceBusyError ? 'RESOURCE_BUSY' : missing ? 'TASK_NOT_FOUND' : 'TASK_REQUEST_INVALID',
            message: error instanceof Error ? error.message : String(error) } };
      }
    },
  });
  return [
    make('list', z.strictObject({}), async (manager) => ({ exitCode: 0, data: await manager.store.list() }), [], []),
    make('show', query, async (manager, input) => ({ exitCode: 0, data: await manager.store.show((input as { id: string }).id) })),
    make('events', query.extend({ after: z.coerce.number().int().min(0).default(0) }), async (manager, input) => {
      const { id, after } = input as { id: string; after: number };
      return { exitCode: 0, data: await manager.store.events(id, after) };
    }, [{ flags: '--after <sequence>', description: 'Read events after this cursor', required: true, optional: false, mandatory: false }]),
    make('submit', z.strictObject({ toolId: z.string(), payload: z.string().optional(), input: z.unknown().default({}), wait: z.boolean().default(false) }),
      async (manager, input) => {
        const request = input as { toolId: string; input: unknown; payload?: string; wait: boolean };
        return taskResult(await manager.submit(request.toolId, request.payload ? JSON.parse(request.payload) : request.input, request.wait), request.wait);
      }, [waitOption, { flags: '--payload <json>', description: 'Tool input as JSON', required: true, optional: false, mandatory: false }],
      [{ name: 'toolId', required: true, variadic: false }]),
    make('approve', query.extend({ planId: z.string(), wait: z.boolean().default(false) }), async (manager, input) => {
      const { id, planId, wait } = input as { id: string; planId: string; wait: boolean };
      return taskResult(await manager.approve(id, planId, wait), wait);
    }, [waitOption], [idArgument, { name: 'planId', required: true, variadic: false }]),
    make('cancel', query.extend({ force: z.boolean().default(false) }), async (manager, input) => {
      const { id, force } = input as { id: string; force: boolean };
      return { exitCode: 0, data: await manager.cancel(id, force) };
    }, [{ flags: '--force', description: 'Force cancellation after recording the request', required: false, optional: false, mandatory: false }]),
    make('resume', query.extend({ wait: z.boolean().default(false) }), async (manager, input) => {
      const { id, wait } = input as { id: string; wait: boolean };
      return taskResult(await manager.resume(id, wait), wait);
    }, [waitOption]),
  ];
}
