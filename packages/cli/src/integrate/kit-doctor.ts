/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { relative, resolve } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import { sha256 } from '../agent/context-files.js';
import { readProject } from '../project-model/index.js';
import { parseSpans } from '../project-config/json5-spans.js';
import { InputInvalidError, type ExecutionContext, type ToolResult } from '../runtime/types.js';
import { readSnapshot } from '../workspace/patch-review.js';
import { defaultRuntimeProfile, parseRuntimeProfile, runtimeProfileManifestSchema, runtimeProfileMissing } from './runtime-profile.js';
import { runtimeGuardSource } from './runtime-sources.js';

const name = z.string().min(1).max(64);
const sdk = z.union([z.number().int().positive().safe(), z.string().min(1).max(128)]);
const consumerSchema = z.object({
  app: z.object({ products: z.array(z.object({
    name, compatibleSdkVersion: sdk.optional(), targetSdkVersion: sdk.optional(), compileSdkVersion: sdk.optional(),
  })).max(64).optional() }).optional(),
  modules: z.array(z.object({ name, srcPath: z.string().min(1).max(1024) })).max(64),
});
const dependencySchema = z.object({ dependencies: z.record(z.string().max(256), z.string().min(1).max(1024)).optional() });
interface State { missing: string[]; findings: { code: string; source: string; module?: string }[]; }
function parse(text: string): unknown {
  try { parseSpans(text); return JSON5.parse(text); }
  catch { throw new InputInvalidError('RUNTIME_DOCTOR_CONFIG_INVALID'); }
}
function finding(state: State, module: string, code: string) { state.findings.push({ code, module, source: 'ohmate' }); }
async function guardMatches(context: ExecutionContext, directory: string, profile: 'release-none' | 'debug' | 'test',
  profileHash: string, entryHash: string | null, manifestHash: string, dependencyHash: string | null) {
  const root = context.projectRoot ?? context.cwd;
  const inputs = profile === 'release-none' ? [] : [
    { path: relative(resolve(root, directory), resolve(root, 'runtime-profile.json5')), sha256: profileHash },
    { path: 'src/main/ets/OHMateRuntimeEntry.ets', sha256: entryHash ?? '' },
    { path: 'ohmate-profile-manifest.json', sha256: manifestHash },
    { path: 'oh-package.json5', sha256: dependencyHash ?? '' },
  ];
  const guard = await readSnapshot(context, `${directory}/ohmate-runtime-hvigor.ts`);
  return guard.text === runtimeGuardSource(profile, inputs);
}
async function dependency(context: ExecutionContext, directory: string) {
  const file = await readSnapshot(context, `${directory}/oh-package.json5`);
  const value = dependencySchema.safeParse(file.text === null ? {} : parse(file.text));
  if (!value.success) { throw new InputInvalidError('RUNTIME_DOCTOR_DEPENDENCY_INVALID'); }
  const dependencies = value.data.dependencies ?? {};
  return { path: file.path, sha256: file.oldHash, coordinate: '@ohmate/ohmatekit',
    version: dependencies['@ohmate/ohmatekit'] ?? null,
    developmentCoordinates: Object.keys(dependencies).filter(value => /(?:^|[/@_.-])(?:debug|test|mock|hypium)(?:$|[/_.-])/i.test(value)) };
}
async function manifest(context: ExecutionContext, directory: string, module: string, profileHash: string,
  declaredDependency: Awaited<ReturnType<typeof dependency>>, state: State) {
  const file = await readSnapshot(context, `${directory}/ohmate-profile-manifest.json`);
  if (file.text === null) { state.missing.push(`${module}:runtime-profile-manifest`); return null; }
  const parsed = runtimeProfileManifestSchema.safeParse(parse(file.text));
  if (!parsed.success) { finding(state, module, 'RUNTIME_MANIFEST_SCHEMA_INVALID'); return null; }
  const value = parsed.data, required = value.profile.startsWith('release-') ? 'release' : 'debug';
  if (value.buildMode !== required) { finding(state, module, 'RUNTIME_MANIFEST_BUILD_MODE_MISMATCH'); }
  const entryPath = `${directory}/src/main/ets/OHMateRuntimeEntry.ets`;
  const entry = await readSnapshot(context, entryPath);
  const matched = value.entry.path === entryPath && value.entry.sha256 === entry.oldHash && value.inputHash === profileHash;
  if (!matched) { finding(state, module, 'RUNTIME_MANIFEST_SOURCE_DRIFT'); }
  if (value.profile === 'release-core') { state.missing.push(`${module}:release-core-producer`); }
  else if (!await guardMatches(context, directory, value.profile, profileHash, entry.oldHash, file.oldHash!, declaredDependency.sha256)) {
    finding(state, module, 'RUNTIME_GUARD_SOURCE_DRIFT');
  }
  state.missing.push(`${module}:hvigor-plugin-execution-binding`);
  if (value.profile === 'debug' || value.profile === 'test') {
    if (declaredDependency.version === null) { finding(state, module, 'RUNTIME_DEPENDENCY_UNDECLARED'); }
  } else if (declaredDependency.developmentCoordinates.length) {
    finding(state, module, 'RUNTIME_RELEASE_DEVELOPMENT_DEPENDENCY');
  }
  return { module, profile: value.profile, declared: value.buildMode, required,
    sourceBinding: matched ? 'matched' : 'mismatched', manifestHash: file.oldHash, buildId: 'unverified' };
}
async function inspect(context: ExecutionContext): Promise<ToolResult> {
  const root = await readSnapshot(context, 'build-profile.json5');
  const consumer = consumerSchema.safeParse(root.text === null ? {} : parse(root.text));
  if (!consumer.success) { throw new InputInvalidError('RUNTIME_DOCTOR_CONSUMER_INVALID'); }
  const project = await readProject(context.projectRoot ?? context.cwd);
  const config = await readSnapshot(context, 'runtime-profile.json5');
  const profile = parseRuntimeProfile(config.text === null ? defaultRuntimeProfile : parse(config.text), project.modules.map(value => value.name));
  const profileHash = config.oldHash ?? sha256(`${JSON.stringify(defaultRuntimeProfile, null, 2)}\n`);
  const state: State = { missing: [...runtimeProfileMissing, 'minimum-supported-api-matrix',
    'actual-hvigor-build-mode', 'compiler-dependency-closure'], findings: [] };
  if (profile.probes.length) { state.missing.push('probe-transform-producer-and-dependency-version'); }
  const products = (consumer.data.app?.products ?? []).map(value => ({ name: value.name,
    compatibleSdkVersion: value.compatibleSdkVersion ?? null, targetSdkVersion: value.targetSdkVersion ?? null,
    compileSdkVersion: value.compileSdkVersion ?? null }));
  if (!products.length) { state.missing.push('consumer-sdk-products'); }
  for (const product of products) {
    if (product.compatibleSdkVersion === null || product.targetSdkVersion === null) { state.missing.push(`${product.name}:consumer-sdk-values`); }
  }
  const modules = [], manifests = [];
  for (const module of project.modules) {
    const directory = relative(project.root, module.path).split('\\').join('/');
    const declaredDependency = await dependency(context, directory);
    modules.push({ name: module.name, ...declaredDependency });
    const entry = await manifest(context, directory, module.name, profileHash, declaredDependency, state);
    if (entry !== null) { manifests.push(entry); }
  }
  const staticValid = state.findings.length === 0;
  return { exitCode: staticValid ? 3 : 1, data: { status: staticValid ? 'incomplete' : 'invalid', staticValid,
    profile, missing: [...new Set(state.missing)], findings: state.findings, checks: {
      api: { source: 'consumer-build-profile', products, minimumSupportedApi: 'unverified', inputHash: root.oldHash },
      buildMode: { actual: null, source: 'hvigor-context-unavailable', manifests },
      dependencies: { binding: 'declaration-only', modules },
      configuration: { path: config.path, sha256: config.oldHash, defaulted: config.text === null },
    } } };
}
/** Readonly consumer declarations and source bindings never certify compiler or runtime state. */
export async function inspectKitDoctor(input: unknown, context: ExecutionContext): Promise<ToolResult> {
  z.strictObject({}).parse(input);
  try { return await inspect(context); }
  catch (error) {
    if (!(error instanceof InputInvalidError)) { throw error; }
    return { exitCode: 1, data: { status: 'invalid', staticValid: false, missing: [],
      findings: [{ code: error.message, source: 'ohmate' }] } };
  }
}
