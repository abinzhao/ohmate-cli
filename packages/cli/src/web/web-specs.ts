/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import { openWorkbench, stopWorkbench, workbenchStatus } from './web-lifecycle.js';
import type { ToolSpec } from '../runtime/types.js';

export function getWebSpecs(): ToolSpec[] {
  return [
    { ...serviceSpec('ui.open', 'Open the same-runtime local Web workbench without requiring a model or application',
      z.strictObject({ port: z.coerce.number().int().min(0).max(65535).default(0), open: z.boolean().default(true) }),
      (input, context) => openWorkbench(context, input as { port: number; open: boolean }),
      [valueOption('port', 'Bind an explicit loopback port (default: random)'), {
        flags: '--no-open', description: 'Print the one-time browser URL without launching a browser', required: false, optional: false, mandatory: false,
      }]), command: ['ui'], timeoutMs: 30_000 },
    serviceSpec('ui.status', 'Read local workbench status without exposing browser capabilities', z.strictObject({}),
      (_, context) => workbenchStatus(context)),
    serviceSpec('ui.stop', 'Stop the owned workbench HTTP service and event streams while preserving tasks', z.strictObject({}),
      (_, context) => stopWorkbench(context)),
  ];
}
