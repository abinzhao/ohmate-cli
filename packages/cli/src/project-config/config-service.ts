/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { basename, dirname, resolve } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import { InputInvalidError, type ExecutionContext, type ToolResult } from '../runtime/types.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { readProject } from '../project-model/index.js';
import { applyPatch } from '../workspace/patch-transaction.js';
import { inspectPatch, readSnapshot } from '../workspace/patch-review.js';
import { parseSpans } from './json5-spans.js';
import { editJson5, fieldEditSchema } from './json5-edits.js';
import { editRules, inspectRules, isArkguardPath, ruleEditSchema } from './arkguard-rules.js';
import { validateFaultLogConfig } from './faultlog-config.js';
import { validateRuntimeProfile } from '../integrate/runtime-profile.js';

export const configPathSchema = z.strictObject({ path: z.string().min(1).max(1024) });
export const configEditSchema = configPathSchema.extend({
  edits: z.array(z.union([fieldEditSchema, ruleEditSchema])).min(1).max(20),
});
const configNames = new Set(['app.json5', 'module.json5', 'build-profile.json5', 'oh-package.json5', 'hvigor-config.json5', 'runtime-profile.json5']);

async function snapshot(path: string, context: ExecutionContext) {
  if (!isArkguardPath(path) && !configNames.has(basename(path)) && !/\/resources\/[^/]+\/(?:element|profile)\/[^/]+\.json$/.test(path)) {
    throw new InputInvalidError('Unsupported configuration path');
  }
  const project = await readProject(context.projectRoot ?? context.cwd);
  const module = isArkguardPath(path) ? project.modules.find((m) => m.path === resolve(project.root, dirname(path))) : undefined;
  if (isArkguardPath(path) && !module) { throw new InputInvalidError('ArkGuard rules must belong to a declared module'); }
  const file = await readSnapshot(context, path);
  if (file.text === null) { throw new InputInvalidError('Configuration file does not exist'); }
  return { ...file, text: file.text, module: module ? { name: module.name, type: module.type } : undefined };
}
function parsePublic(text: string): unknown {
  const value: unknown = JSON5.parse(text);
  assertPublicValue(value);
  return value;
}

export async function inspectConfig(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { path } = configPathSchema.parse(input), file = await snapshot(path, context);
  if (isArkguardPath(path)) { return { exitCode: 0, data: ruleReport(path, file) }; }
  return { exitCode: 0, data: { path, inputHash: file.oldHash, value: parsePublic(file.text),
    parser: 'json5', officialValidation: 'not-run' } };
}
function ruleReport(path: string, file: Awaited<ReturnType<typeof snapshot>>) {
  const consumer = basename(path) === 'consumer-rules.txt';
  return { path, inputHash: file.oldHash, module: file.module, role: consumer ? 'consumer' : 'module',
    ...inspectRules(file.text, consumer) };
}
export async function validateConfig(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const { path } = configPathSchema.parse(input), file = await snapshot(path, context);
  if (isArkguardPath(path)) {
    const data = ruleReport(path, file);
    return { exitCode: data.valid === false ? 1 : data.valid === null ? 3 : 0, data };
  }
  let value: unknown;
  try { value = JSON5.parse(file.text); }
  catch {
    return { exitCode: 1, data: { path, inputHash: file.oldHash, valid: false,
      findings: [{ code: 'CONFIG_SYNTAX_INVALID', source: 'json5' }], officialValidation: 'not-run' } };
  }
  assertPublicValue(value);
  const findings: { code: string; source: string }[] = [];
  try { parseSpans(file.text); } catch { findings.push({ code: 'CONFIG_LOSSLESS_EDIT_UNSUPPORTED', source: 'ohmate' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { findings.push({ code: 'CONFIG_OBJECT_REQUIRED', source: 'ohmate' }); }
  const faultLog = basename(path) === 'module.json5' && !findings.length
    ? await validateFaultLogConfig(value, path, context) : undefined;
  const runtimeProfile = basename(path) === 'runtime-profile.json5' && !findings.length
    ? await validateRuntimeProfile(value, context) : undefined;
  const invalid = findings.length > 0 || faultLog?.status === 'invalid' || runtimeProfile?.status === 'invalid';
  const incomplete = faultLog?.status === 'incomplete' || runtimeProfile?.status === 'incomplete';
  return { exitCode: invalid ? 1 : incomplete ? 3 : 0, data: { path, inputHash: file.oldHash,
    valid: invalid ? false : incomplete ? null : true,
    findings: [...findings, ...faultLog?.findings ?? [], ...runtimeProfile?.findings ?? []],
    faultLog, runtimeProfile, officialValidation: 'not-run' } };
}

export async function prepareConfigEdit(input: unknown, context: ExecutionContext) {
  try {
    const parsed = configEditSchema.parse(input), file = await snapshot(parsed.path, context);
    const rules = isArkguardPath(parsed.path);
    const edited = rules
      ? editRules(file.text, z.array(ruleEditSchema).parse(parsed.edits), basename(parsed.path) === 'consumer-rules.txt')
      : editJson5(file.text, z.array(fieldEditSchema).parse(parsed.edits));
    const patch = { changes: [{ path: parsed.path, oldHash: file.oldHash, text: edited.text }] };
    const prepared = await inspectPatch(patch, context);
    const details = 'fields' in edited ? { fields: edited.fields } : { rules: edited.rules, grammar: edited.grammar, effectiveMerge: edited.effectiveMerge };
    return { patch, review: { ...prepared.review,
      ...details, officialValidation: 'not-run' } };
  } catch (error) { throw new InputInvalidError(error instanceof Error ? error.message : String(error)); }
}
export async function editConfig(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  const prepared = await prepareConfigEdit(input, context);
  return applyPatch(prepared.patch, context);
}
