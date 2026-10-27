/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { evidenceFile, privateEvidenceName, type FileEvidence } from './evidence.js';
import { readEvidenceText } from './source-scope.js';
import type { ExecutionContext } from '../runtime/types.js';
import type { CompilerObservation } from './compiler-observations.js';

interface LoaderSelection {
  product: string; modules: string[]; buildMode: string;
  model: { root: string; modules: { name: string; path: string }[] };
}
interface LoaderInput extends FileEvidence { role: string; }
interface InputBudget { declarations: number; bytes: number; }
const paths = z.array(z.string().min(1).max(4096)).max(4096).optional();
const loaderSchema = z.object({
  moduleName: z.string().optional(), compileEntry: paths, otherCompileFiles: paths, workers: paths, 'oh-exports': paths,
  byteCodeHarInfo: z.record(z.string(), z.object({ abcPath: z.string(), sourceMapsPath: z.string().optional() })).optional(),
  dynamicImportLibInfo: z.record(z.string(), z.object({
    entryFilePath: z.string().min(1).max(4096), pkgPath: z.string().max(4096).optional(),
  }).passthrough()).optional(),
}).passthrough();
function selectedLoaders(selection: LoaderSelection) {
  return selection.modules.flatMap((spec) => {
    const [name, target = 'default'] = spec.split('@'), module = selection.model.modules.find((item) => item.name === name)!;
    return ['loader.json', 'widget_loader.json'].map((file) => ({ spec, modulePath: module.path,
      file: join(module.path, 'build', selection.product, 'intermediates/loader', target, file) }));
  });
}
export async function snapshotLoaders(selection: LoaderSelection): Promise<Map<string, FileEvidence | null>> {
  const before = new Map<string, FileEvidence | null>();
  for (const { file } of selectedLoaders(selection)) { before.set(file, await evidenceFile(selection.model.root, file).catch(() => null)); }
  return before;
}
function declarations(loader: z.infer<typeof loaderSchema>) {
  const result = (['compileEntry', 'otherCompileFiles', 'workers', 'oh-exports'] as const).flatMap((key) =>
    (loader[key] ?? []).map((path) => ({ path, role: ({ compileEntry: 'compile-entry', otherCompileFiles: 'other-compile-file',
      workers: 'worker', 'oh-exports': 'oh-exports' })[key] })));
  for (const value of Object.values(loader.byteCodeHarInfo ?? {})) {
    result.push({ path: value.abcPath, role: 'bytecode-har' });
    if (value.sourceMapsPath) { result.push({ path: value.sourceMapsPath, role: 'bytecode-source-map' }); }
  }
  for (const value of Object.values(loader.dynamicImportLibInfo ?? {})) {
    if (value.entryFilePath) { result.push({ path: value.entryFilePath, role: 'runtime-only-entry' }); }
  }
  return result;
}
async function declaredInputs(loader: z.infer<typeof loaderSchema>, context: ExecutionContext, budget: InputBudget) {
  const root = context.projectRoot ?? context.cwd, inputs: LoaderInput[] = [], missing: string[] = [];
  const declared = declarations(loader);
  budget.declarations += declared.length;
  if (budget.declarations > 4096) { return { inputs, missing: ['loader-input-budget'] }; }
  for (const { path, role } of declared) {
    context.abortSignal.throwIfAborted();
    const name = relative(root, resolve(path)).split(sep).join('/');
    if (!isAbsolute(path) || name === '..' || name.startsWith('../')) { missing.push(`${role}:outside-project`); continue; }
    if (name.split('/').some((part) => privateEvidenceName.test(part)) || resolve(path).startsWith(`${context.dataDir}${sep}`)) {
      missing.push(`${role}:sensitive-input`); continue;
    }
    try {
      const remaining = 64 * 1024 * 1024 - budget.bytes;
      if ((await lstat(path)).size > remaining) { missing.push('loader-byte-budget'); break; }
      const file = await evidenceFile(root, path, remaining);
      budget.bytes += file.size;
      inputs.push({ ...file, role });
    } catch { missing.push(`${role}:${name}`); }
  }
  return { inputs, missing };
}
export async function collectLoaderInputs(selection: LoaderSelection, before: Map<string, FileEvidence | null>, context: ExecutionContext,
  observation?: CompilerObservation) {
  const loaders = [];
  const budget: InputBudget = { declarations: 0, bytes: 0 };
  let invalidInputs = false;
  const candidates = selectedLoaders(selection).map((item) => ({ ...item, observed: false }));
  for (const config of observation?.configurations ?? []) {
    const module = selection.model.modules.find((item) => item.path === config.modulePath && item.name === config.entryModuleName);
    const spec = `${module?.name}@${String(config.targetName ?? '').replace(/^\./, '')}`;
    if (!module || !selection.modules.includes(spec) || typeof config.aceBuildJson !== 'string') { continue; }
    const name = relative(selection.model.root, config.aceBuildJson);
    if (!isAbsolute(config.aceBuildJson) || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name) ||
      name.split(sep).some((part) => privateEvidenceName.test(part) || /^(?:local\.properties|\.ohpmrc)$/i.test(part)) ||
      config.aceBuildJson.startsWith(`${context.dataDir}${sep}`)) { invalidInputs = true; continue; }
    const existing = candidates.find((item) => item.file === config.aceBuildJson);
    if (existing) { existing.observed = true; }
    else { candidates.push({ spec, modulePath: module.path, file: config.aceBuildJson, observed: true }); }
  }
  for (const selected of candidates) {
    const previous = before.get(selected.file), path = relative(selection.model.root, selected.file).split(sep).join('/');
    let sha256: string | undefined;
    try {
      const current = await readEvidenceText(selection.model.root, selected.file);
      sha256 = current.evidence.sha256;
      const loader = loaderSchema.parse(JSON.parse(current.text)), evidence = await declaredInputs(loader, context, budget);
      const fresh = !previous || current.evidence.sha256 !== previous.sha256 ||
        current.evidence.mtimeMs !== previous.mtimeMs || current.evidence.ctimeMs !== previous.ctimeMs;
      invalidInputs ||= Boolean(evidence.missing.length);
      loaders.push({ spec: selected.spec, product: selection.product, buildMode: selection.buildMode,
        path, sha256: current.evidence.sha256, status: fresh ? 'fresh' : 'reused-unverified',
        binding: selected.observed ? 'observed-partial' : 'unverified', inputPhase: 'post-build',
        layout: selected.observed ? 'observed-configuration' : 'default-candidate', modulePath: selected.modulePath,
        inputs: evidence.inputs, missing: evidence.missing });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !previous && !selected.observed) { continue; }
      invalidInputs = true;
      loaders.push({ spec: selected.spec, path, sha256, status: 'unreadable', binding: 'unverified', missing: ['loader-unreadable'] });
    }
  }
  return { scope: 'loader-declarations-only', loaders, invalidInputs,
    missing: [...loaders.length ? [] : ['loader-not-observed'],
      'final-compiler-configuration', 'transitive-module-read-closure', 'custom-build-layout', 'arkguard-actual-rule-merge'] };
}
