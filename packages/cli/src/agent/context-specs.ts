/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ContextService, previewSchema } from './context-service.js';
import { idArgument, serviceSpec, valueOption } from './service-spec.js';
import type { PreviewInput } from './context-service.js';
import type { ToolSpec } from '../runtime/types.js';
import type { OHMateRuntime } from '../runtime/runtime.js';

export function getContextSpecs(runtime: OHMateRuntime): ToolSpec[] {
  const noInput = z.strictObject({});
  const previewOptions = [
    valueOption('prompt', 'User intent included in the sending preview'), valueOption('files', 'Explicit project-relative files', true),
    valueOption('write-paths', 'Exact public paths the Agent may propose to change; parent directories must exist', true),
    valueOption('session-id', 'Conversation to resume'), valueOption('model-id', 'Explicit model endpoint'),
    valueOption('allowed-tools', 'Explicit tool IDs whose results may be sent', true), valueOption('max-bytes', 'Maximum preview size'),
  ];
  return [
    ...['inspect', 'preview'].map((verb) => serviceSpec(`context.${verb}`, 'Preview exact context material, sources, hashes and sending budget',
      previewSchema, async (input, context) => ({ exitCode: 0, data: await new ContextService(context, runtime.registry).preview(input as PreviewInput) }), previewOptions)),
    ...['list', 'check'].map((verb) => serviceSpec(`rules.${verb}`, 'Inspect applicable project rules', z.strictObject({ files: z.array(z.string()).default([]) }),
      async (input, context) => ({ exitCode: 0, data: await new ContextService(context).rules((input as { files: string[] }).files) }),
      [valueOption('files', 'Files used to resolve nested AGENTS scopes', true)])),
    serviceSpec('memory.list', 'List explicitly approved workspace memories', noInput,
      async (_, context) => ({ exitCode: 0, data: await new ContextService(context).memories() })),
    serviceSpec('memory.add', 'Explicitly approve a workspace memory', z.strictObject({ text: z.string().min(1).max(8192) }),
      async (input, context) => ({ exitCode: 0, data: await new ContextService(context).addMemory((input as { text: string }).text) }),
      [], [{ name: 'text', required: true, variadic: false }]),
    serviceSpec('memory.remove', 'Remove an approved workspace memory', z.strictObject({ id: z.string().uuid() }),
      async (input, context) => ({ exitCode: 0, data: await new ContextService(context).removeMemory((input as { id: string }).id) }), [], idArgument),
    serviceSpec('extensions.list', 'List extension verification and enablement state', noInput,
      async (_, context) => ({ exitCode: 0, data: await new ContextService(context).extensions() })),
    ...['enable', 'disable'].map((verb) => serviceSpec(`extensions.${verb}`, 'Control an explicitly named extension; unverified executable extensions are blocked',
      z.strictObject({ id: z.string() }), async (input, context) => {
        if (verb === 'enable') { return { exitCode: 5, data: { code: 'EXTENSION_UNVERIFIED', message: 'Executable extension adapter is not verified' } }; }
        return { exitCode: 0, data: await new ContextService(context).setExtension((input as { id: string }).id, false) };
      }, [], idArgument)),
  ];
}
