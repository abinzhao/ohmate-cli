/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import { readProject } from '../project-model/index.js';
import { inspectPatch, readSnapshot } from '../workspace/patch-review.js';
import { applyPatch } from '../workspace/patch-transaction.js';
import { InputInvalidError, type ExecutionContext, type ToolSpec } from '../runtime/types.js';
import type { OHMateRuntime } from '../runtime/runtime.js';
import type { TaskRecord } from '../tasks/index.js';
import { attachPlugin, hvigorTasks, pluginSource, type HvigorTaskName } from './hvigor-plugin.js';
import { runtimeIntegrationSpec } from './runtime-integration.js';

async function prepare(context: ExecutionContext) {
  await readProject(context.projectRoot ?? context.cwd);
  const root = await readSnapshot(context, 'hvigorfile.ts'), plugin = await readSnapshot(context, 'ohmate-hvigor.ts');
  if (root.text === null) { throw new InputInvalidError('Root hvigorfile.ts is required'); }
  if (plugin.text !== null) { throw new InputInvalidError('ohmate-hvigor.ts already exists; preserve its contents'); }
  const patch = { changes: [
    { path: root.path, oldHash: root.oldHash, text: attachPlugin(root.text) },
    { path: plugin.path, oldHash: null, text: pluginSource() },
  ] };
  const { review } = await inspectPatch(patch, context);
  return { patch, review: { ...review, tasks: hvigorTasks,
    verification: { officialTaskApi: 'requires-runtime-verification', scan: 'official-producer', docs: 'official-producer', test: 'approval-bound-task' } } };
}

async function submitTest(runtime: OHMateRuntime, input: unknown, context: ExecutionContext) {
  const result = await runtime.execute('task.submit', { toolId: 'test.local', input, wait: true }, context);
  const record = result.data as TaskRecord, planned = record.state === 'awaiting-approval' && record.plan;
  return { exitCode: result.exitCode, data: { task: 'ohmatecliTest', toolId: 'test.local',
    execution: record.state ?? 'failed', taskId: record.id ?? null, planId: record.plan?.planId ?? null, result,
    resume: planned ? `ohmatecli task approve ${record.id} ${record.plan!.planId} --wait` : null },
    artifacts: result.artifacts, warnings: result.warnings, provenance: result.provenance };
}
async function dispatch(runtime: OHMateRuntime, task: HvigorTaskName, submit: boolean, input: unknown, context: ExecutionContext) {
  if (submit) {
    if (task !== 'ohmatecliTest') { throw new InputInvalidError('Submission is supported only for ohmatecliTest'); }
    return submitTest(runtime, input, context);
  }
  const toolId = hvigorTasks[task], spec = runtime.registry.get(toolId);
  if (!spec) { return { exitCode: 3 as const, data: { code: 'CAPABILITY_UNAVAILABLE', task, toolId, execution: 'not-run' } }; }
  const result = await runtime.execute(toolId, input, context);
  return { exitCode: result.exitCode, data: { task, toolId, execution: task === 'ohmatecliTest' ? 'not-run' : 'delegated', result },
    artifacts: result.artifacts, warnings: result.warnings, provenance: result.provenance };
}

export function getIntegrationSpecs(runtime: OHMateRuntime): ToolSpec[] {
  return [
    runtimeIntegrationSpec(),
    { ...serviceSpec('integrate.hvigor', 'Review thin Hvigor tasks calling the shared registry without copying rules',
      z.strictObject({}), async (_, context) => applyPatch((await prepare(context)).patch, context)),
      risk: 'R2', idempotency: 'none', requirements: ['project'], evidence: ['diff', 'patch-journal'],
      review: async (_, context) => (await prepare(context)).review },
    { ...serviceSpec('integrate.hvigor-task', 'Dispatch an installed thin Hvigor task to its registered capability',
      z.strictObject({ task: z.enum(Object.keys(hvigorTasks) as [HvigorTaskName, ...HvigorTaskName[]]), submit: z.boolean().default(false),
        input: z.record(z.string(), z.unknown()).default({}) }),
      (input, context) => {
        const value = input as { task: HvigorTaskName; submit: boolean; input: unknown };
        return dispatch(runtime, value.task, value.submit, value.input, context);
      }, [valueOption('task', 'Fixed OHMate Hvigor task name'),
        { flags: '--submit', description: 'Submit a persistent Local Test task requiring approval', required: false, optional: false, mandatory: false }]),
      hidden: true },
  ];
}
