/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { executeScan, scanSchema } from './scan-adapter.js';
export function getScanSpecs(): ToolSpec[] {
  return [{ ...serviceSpec('scan', 'Run official Code Linter with explicit scope, original evidence and coverage limits',
    scanSchema, executeScan, [
      valueOption('modules', 'Declared module names', true), valueOption('files', 'Exact source files', true),
      valueOption('domains', 'Requested scan domains; unavailable domains prevent certification', true),
      valueOption('config', 'Project JSON5 Code Linter configuration'),
    ]), risk: 'R1', requirements: ['project', 'toolchain'], timeoutMs: 30 * 60_000,
    evidence: ['official-lint-json', 'input-hashes', 'scan-report', 'scan-sarif', 'scan-html'] }];
}
