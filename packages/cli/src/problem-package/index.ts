/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export { buildProblemPackage, verifyProblemPackage, problemHash } from './package.js';
export { problemSchemas } from './schemas.js';
export { isProblemPackageTool } from './tool-ids.js';
export type { ProblemManifest, ProblemSession, ProblemEvent } from './schemas.js';

import { serviceSpec, idArgument, valueOption } from '../agent/service-spec.js';
import type { ToolSpec } from '../runtime/types.js';
import { ProblemSelectionSchema, ProblemReadSchema, ProblemPageSchema, reviewProblem, exportProblem, importProblem, readProblem } from './service.js';
import { ReplayPlanSchema, planReplay } from './semantic-replay.js';

export function getProblemPackageSpecs(): ToolSpec[] {
  const selectionOptions = [valueOption('stream', 'Saved event stream UUID'),
    valueOption('through', 'Fixed inclusive committed sequence (safe integer); retained count stays bounded')];
  const readOptions = [valueOption('path', 'Standalone .ohmate-problem.zip file'),
    valueOption('build-id', 'Optional exact build assertion; does not authenticate the build')];
  return [
    serviceSpec('debug.problem.plan', 'Preview the exact redacted fields, files, bytes and risks of a fixed event cut',
      ProblemSelectionSchema, async (input, context) => ({
        exitCode: 0, data: await reviewProblem(ProblemSelectionSchema.parse(input), context),
      }), selectionOptions, idArgument),
    { ...serviceSpec('debug.problem.export', 'Export an approved fixed redacted snapshot into private immutable artifacts',
      ProblemSelectionSchema, (input, context) => exportProblem(ProblemSelectionSchema.parse(input), context),
      selectionOptions, idArgument), risk: 'R2',
      review: (input, context) => reviewProblem(ProblemSelectionSchema.parse(input), context),
      evidence: ['problem-manifest', 'snapshot-hash', 'receipt'] },
    { ...serviceSpec('replay.import', 'Validate and open an offline problem package as a read-only path reference',
      ProblemReadSchema, (input, context) => importProblem(ProblemReadSchema.parse(input), context), readOptions),
      idempotency: 'read', recovery: 'verify-and-retry' },
    serviceSpec('replay.verify', 'Verify an offline problem package without extraction, execution or authentication recovery',
      ProblemReadSchema, (input, context) => readProblem(ProblemReadSchema.parse(input), context), readOptions),
    serviceSpec('replay.plan', 'Plan bounded semantic test steps offline; missing local Adapter/build evidence requires manual actions',
      ReplayPlanSchema, (input, context) => planReplay(ReplayPlanSchema.parse(input), context),
      [...readOptions, valueOption('steps', 'Optional bounded .ohmate-replay.json semantic test references; no raw input')]),
    serviceSpec('replay.show', 'Read a verified offline event or Kit domain page; no replay actions are performed',
      ProblemPageSchema, (input, context) => {
        const { after, limit, domain, file, ...selection } = ProblemPageSchema.parse(input);
        return readProblem(selection, context, { after, limit, domain, file });
      }, [...readOptions, valueOption('domain', 'Optional Kit domain; records are limited to 48 KiB per page'),
        valueOption('file', 'Optional listed Kit file within the selected domain; attachments expose metadata only'),
        valueOption('after', 'Exclusive event sequence or Kit record ordinal'), valueOption('limit', 'Page size (1–256)')]),
  ];
}
