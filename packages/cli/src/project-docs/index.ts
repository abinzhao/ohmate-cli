/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { docsSchema, executeProjectDocs } from './docs-adapter.js';
export function getProjectDocsSpecs(): ToolSpec[] {
  return (['generate', 'check'] as const).map((kind) => ({
    ...serviceSpec(`docs.${kind}`, kind === 'generate' ? 'Generate public API HTML, index and AI JSON from one official model'
      : 'Check documentation or compare a stable public API baseline', docsSchema,
    (input, context) => executeProjectDocs(kind, input, context), [
      valueOption('modules', 'Declared module names', true), valueOption('files', 'Exact project source files', true),
      valueOption('baseline', 'Prior OHMate API model with the same scope'),
    ]), risk: 'R1', requirements: ['project', 'toolchain'], timeoutMs: 30 * 60_000,
    evidence: ['official-arktsdoc-json', 'input-hashes', 'docs-ai-json', 'docs-index', 'docs-html'],
  }));
}
