/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createExecutionContext } from './context.js';
import type { ExecutionContext, ToolSpec } from './types.js';

export async function toolContext(spec: ToolSpec, input: unknown, context: ExecutionContext): Promise<ExecutionContext> {
  if (spec.adapter !== 'legacy-child' || !spec.options.some((option) => option.flags.includes('--project '))) { return context; }
  const argv = (input as { argv?: string[] }).argv ?? [];
  let project: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--') { break; }
    if (argv[index] === '--project') { project = argv[++index]; }
    else if (argv[index].startsWith('--project=')) { project = argv[index].slice('--project='.length); }
  }
  if (!project) { return context; }
  const canonical = await createExecutionContext({ cwd: context.cwd, projectRoot: project, dataDir: context.dataDir });
  return { ...context, projectRoot: canonical.projectRoot, workspaceId: canonical.workspaceId };
}
