/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { collectInputs } from '../dependency/project-inputs.js';
import { cmakeCommands, nativeImportedLocations } from '../dependency/native-and-imports.js';
import { evidence, record, string } from '../dependency/types.js';
import { publicPath } from '../workspace/path-guard.js';
import { moduleSchema, profileSchema, type ProjectModel } from './project-reader.js';
import type { DependencyFinding, Evidence, SourceFile } from '../dependency/types.js';
import type { ExecutionContext } from '../runtime/types.js';

export type ProjectFacet = 'ArkTS' | 'Cloud' | 'Native';
export interface ProjectInspection extends ProjectModel {
  kind: ProjectFacet | 'Mixed' | 'unknown';
  facets: ProjectFacet[];
  facetEvidence: Partial<Record<ProjectFacet, Evidence[]>>;
  products: { name: string; compatibleSdkVersion?: string | number; compileSdkVersion?: string | number }[];
  cloud: { path: string; entry: string; basis: 'server-sdk-entry' | 'function-descriptor-entry';
    handler?: string; functionType?: 0 | 1; evidence: Evidence[] }[];
  native: { path: string; target: string; sources: Evidence[]; libraries: Evidence[]; evidence: Evidence[] }[];
  inputs: Evidence[];
  diagnostics: DependencyFinding[];
  completeness: 'complete' | 'incomplete';
  checks: { officialBuild: 'not-run'; cloudRuntime: 'not-run'; nativeAbi: 'not-run' };
}

function diagnostic(project: ProjectInspection, file: SourceFile, code: string) {
  project.diagnostics.push({ code, severity: 'info', confidence: 'observed', incomplete: true,
    message: 'Declared project evidence is unsafe, missing, malformed or requires official configuration', evidence: [evidence(file)] });
}
function localPath(directory: string, name: string): string | undefined {
  if (!name || name.startsWith('/') || /[\\:]/.test(name)) { return undefined; }
  const path = posix.normalize(posix.join(directory, name));
  try { publicPath(path); } catch { return undefined; }
  return path.split('/').includes('oh_modules') ? undefined : path;
}
function unique(items: Evidence[]) {
  return [...new Map(items.map((item) => [item.path, item])).values()].sort((a, b) => a.path.localeCompare(b.path));
}
function addFacet(project: ProjectInspection, facet: ProjectFacet, inputs: Evidence[]) {
  if (!inputs.length) { return; }
  project.facets.push(facet); project.facetEvidence[facet] = unique(inputs);
}
function sdkVersion(value: unknown): value is string | number {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : typeof value === 'string' && value.length > 0 && value.length <= 64;
}
function products(file: SourceFile, project: ProjectInspection) {
  const items = record(file.value?.app).products;
  if (!Array.isArray(items)) { return; }
  for (const value of items) {
    const item = record(value), name = string(item.name);
    if (!name || name.length > 256) { continue; }
    project.products.push({ name, ...(sdkVersion(item.compatibleSdkVersion) ? { compatibleSdkVersion: item.compatibleSdkVersion } : {}),
      ...(sdkVersion(item.compileSdkVersion) ? { compileSdkVersion: item.compileSdkVersion } : {}) });
  }
}
function arkts(project: ProjectInspection, files: SourceFile[]) {
  const profile = files.find((file) => file.path === 'build-profile.json5');
  if (!profile) { return; }
  const parsed = profileSchema.safeParse(profile.value);
  if (!parsed.success) { diagnostic(project, profile, 'PROJECT_PROFILE_INVALID'); return; }
  if (parsed.data.modules.length > 2_000) { diagnostic(project, profile, 'PROJECT_MODULE_BUDGET_EXCEEDED'); return; }
  products(profile, project);
  const config = files.find((file) => file.path === 'hvigorfile.ts' &&
    /\bfrom\s*['"]@ohos\/hvigor-ohos-plugin['"]/.test(file.text));
  const configured = config || project.products.some((item) => item.compatibleSdkVersion !== undefined || item.compileSdkVersion !== undefined);
  const proof: Evidence[] = [];
  for (const entry of parsed.data.modules) {
    const directory = localPath('.', entry.srcPath);
    const metadata = directory ? files.find((file) => file.path === `${directory}/src/main/module.json5`) : undefined;
    const module = moduleSchema.safeParse(metadata?.value);
    if (!metadata || !module.success) { diagnostic(project, profile, 'PROJECT_MODULE_UNAVAILABLE'); continue; }
    project.modules.push({ name: entry.name, path: join(project.root, directory!), type: module.data.module.type,
      targets: entry.targets?.map((item) => item.name) ?? [], deviceTypes: module.data.module.deviceTypes ?? [] });
    const source = files.find((file) => file.path.startsWith(`${directory}/src/`) && /\.(?:ets|ts)$/.test(file.path) &&
      !file.path.endsWith('.d.ts') && file.text.trim());
    if (source && configured) { proof.push(evidence(profile), evidence(metadata), evidence(source), ...(config ? [evidence(config)] : [])); }
  }
  addFacet(project, 'ArkTS', proof);
}
function cloudDescriptors(project: ProjectInspection, files: SourceFile[]): Evidence[] {
  const proof: Evidence[] = [];
  for (const file of files) {
    if (posix.basename(file.path) !== 'function-config.json') { continue; }
    const handler = string(file.value?.handler), functionType = file.value?.functionType;
    if (!handler || handler.length > 64 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(handler) ||
      (functionType !== undefined && functionType !== 0 && functionType !== 1)) {
      diagnostic(project, file, 'PROJECT_CLOUD_DESCRIPTOR_UNRESOLVED'); continue;
    }
    const directory = posix.dirname(file.path), name = handler.split('.')[0];
    const candidates = ['ts', 'js'].map((extension) => localPath(directory, `${name}.${extension}`));
    const sources = files.filter((item) => candidates.includes(item.path) && item.text.trim());
    if (sources.length !== 1) {
      diagnostic(project, file, sources.length ? 'PROJECT_CLOUD_ENTRY_AMBIGUOUS' : 'PROJECT_CLOUD_ENTRY_UNAVAILABLE'); continue;
    }
    const inputs = [evidence(file), evidence(sources[0])];
    project.cloud.push({ path: directory, entry: sources[0].path, basis: 'function-descriptor-entry', handler,
      ...(functionType !== undefined ? { functionType } : {}), evidence: inputs });
    proof.push(...inputs);
  }
  return proof;
}
function cloud(project: ProjectInspection, files: SourceFile[]) {
  const proof = cloudDescriptors(project, files);
  for (const file of files.filter((item) => posix.basename(item.path) === 'package.json')) {
    const sdk = record(file.value?.dependencies)['@hw-agconnect/cloud-server'];
    if (typeof sdk !== 'string' || !sdk) { continue; }
    const directory = posix.dirname(file.path), main = string(file.value?.main);
    const path = main && localPath(directory, main);
    const source = path && files.find((item) => item.path === path && /\.(?:ts|js|mjs|cjs)$/.test(item.path) &&
      !item.path.endsWith('.d.ts') && item.text.trim());
    if (!source) { diagnostic(project, file, 'PROJECT_CLOUD_ENTRY_UNAVAILABLE'); continue; }
    const inputs = [evidence(file), evidence(source)];
    project.cloud.push({ path: directory, entry: source.path, basis: 'server-sdk-entry', evidence: inputs });
    proof.push(...inputs);
  }
  addFacet(project, 'Cloud', proof);
}
function native(project: ProjectInspection, files: SourceFile[]) {
  const proof: Evidence[] = [];
  for (const file of files.filter((item) => item.path.endsWith('CMakeLists.txt') || item.path.endsWith('.cmake'))) {
    const commands = cmakeCommands(file), directory = posix.dirname(file.path);
    if (commands.some((item) => ['if', 'foreach', 'while', 'function', 'macro'].includes(item.name))) {
      diagnostic(project, file, 'PROJECT_NATIVE_CONFIG_UNRESOLVED'); continue;
    }
    if (commands.some((item) => item.dynamic || ['include', 'find_package', 'add_subdirectory'].includes(item.name))) {
      diagnostic(project, file, 'PROJECT_NATIVE_CONFIG_UNRESOLVED');
    }
    for (const command of commands.filter((item) => ['add_library', 'add_executable'].includes(item.name) && !item.dynamic)) {
      const target = command.args[0];
      if (!target || target.length > 256) { continue; }
      const names = [...command.args.slice(1), ...(command.args.includes('IMPORTED') ? nativeImportedLocations(commands, target).map((item) => item.path) : [])];
      const inputs = names.map((name) => localPath(directory, name)).filter((path): path is string => !!path)
        .map((path) => files.find((item) => item.path === path)).filter((item): item is SourceFile => !!item);
      const sources = inputs.filter((item) => /\.(?:cpp|cc|c|cxx)$/.test(item.path) && item.text.trim()).map((item) => evidence(item));
      const libraries = inputs.filter((item) => item.binary && item.bytes! > 0).map((item) => evidence(item));
      if (!sources.length && !libraries.length) { diagnostic(project, file, 'PROJECT_NATIVE_INPUT_UNAVAILABLE'); continue; }
      const declaration = evidence(file, command.line), inputsEvidence = unique([declaration, ...sources, ...libraries]);
      project.native.push({ path: file.path, target, sources: unique(sources), libraries: unique(libraries), evidence: inputsEvidence });
      proof.push(...inputsEvidence);
    }
  }
  addFacet(project, 'Native', proof);
}

/** Bounded read-only discovery; it never grants the strict ArkTS build/config preflight. */
export async function inspectProjectInputs(context: ExecutionContext) {
  const root = await realpath(context.projectRoot ?? context.cwd);
  const project: ProjectInspection = { root, modules: [], lockfile: null, kind: 'unknown', facets: [], facetEvidence: {},
    products: [], cloud: [], native: [], inputs: [], diagnostics: [], completeness: 'complete',
    checks: { officialBuild: 'not-run', cloudRuntime: 'not-run', nativeAbi: 'not-run' } };
  const files = await collectInputs({ ...context, projectRoot: root }, { inputs: project.inputs, findings: project.diagnostics }, true);
  context.abortSignal.throwIfAborted();
  project.lockfile = files.some((file) => file.path === 'oh-package-lock.json5') ? join(root, 'oh-package-lock.json5') : null;
  arkts(project, files); cloud(project, files); native(project, files);
  project.kind = project.facets.length > 1 ? 'Mixed' : project.facets[0] ?? 'unknown';
  project.completeness = project.diagnostics.some((item) => item.incomplete) ? 'incomplete' : 'complete';
  return { project, files };
}
export async function inspectProject(context: ExecutionContext): Promise<ProjectInspection> {
  return (await inspectProjectInputs(context)).project;
}
