/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { readProject } from '../project-model/index.js';
import { patchPath } from '../workspace/path-guard.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { digest, evidenceFile, inputEvidence, type FileEvidence } from './evidence.js';

export const sourceScopeSchema = z.strictObject({
  modules: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1).max(64).optional(),
  files: z.array(z.string().min(1).max(1024)).min(1).max(128).optional(),
});
const portable = (value: string) => value.split(sep).join('/');
export async function readEvidenceText(root: string, path: string, limit = 8 * 1024 * 1024) {
  const evidence = await evidenceFile(root, path, limit);
  if (evidence.size > limit) { throw new Error('Producer data exceeds the reading budget'); }
  const text = await readFile(path, 'utf8');
  if (digest(text) !== evidence.sha256) { throw new Error('Producer data changed during reading'); }
  return { text, evidence };
}
export async function resolveSourceScope(input: unknown, context: ExecutionContext) {
  const value = sourceScopeSchema.parse(input), project = await readProject(context.projectRoot ?? context.cwd);
  const inputs = await inputEvidence(context), selected = new Set(value.modules ?? (value.files ? [] : project.modules.map((item) => item.name)));
  const owner = (path: string) => project.modules.find((module) => {
    const name = portable(relative(module.path, join(project.root, path)));
    return /^src\/.+\.(?:ets|ts)$/.test(name);
  });
  for (const path of value.files ?? []) {
    await patchPath(project.root, path, context.dataDir);
    const module = owner(path);
    if (!module || !inputs.files.some((file) => file.path === path) || value.modules && !selected.has(module.name)) {
      throw new InputInvalidError('Source file is missing or outside the selected declared modules');
    }
    selected.add(module.name);
  }
  if (!selected.size || [...selected].some((name) => !project.modules.some((module) => module.name === name))) {
    throw new InputInvalidError('Unknown or empty source module scope');
  }
  const sources = inputs.files.filter((file) => {
    const module = owner(file.path);
    return module && selected.has(module.name) && (!value.files || value.files.includes(file.path));
  });
  if (!sources.length || sources.length > 128 || [...selected].some((name) => !sources.some((file) => owner(file.path)?.name === name))) {
    throw new InputInvalidError('Source scope is empty, omits a selected module or exceeds 128 files');
  }
  return { modules: [...selected].sort(), files: sources.map((file) => file.path), sources, inputs, project };
}
export type SourceScope = Awaited<ReturnType<typeof resolveSourceScope>>;
export async function sourceDrift(context: ExecutionContext, before: FileEvidence[]) {
  const after = await inputEvidence(context), current = new Map(after.files.map((file) => [file.path, file.sha256]));
  const prior = new Map(before.map((file) => [file.path, file.sha256]));
  return [...new Set([...prior.keys(), ...current.keys()])].filter((path) => prior.get(path) !== current.get(path)).sort();
}
