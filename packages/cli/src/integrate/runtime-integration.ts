/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { relative, resolve } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import { sha256 } from '../agent/context-files.js';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import { readProject } from '../project-model/index.js';
import { InputInvalidError, type ExecutionContext, type ToolSpec } from '../runtime/types.js';
import { inspectPatch, readSnapshot } from '../workspace/patch-review.js';
import { applyPatch } from '../workspace/patch-transaction.js';
import { parseSpans } from '../project-config/json5-spans.js';
import { attachPlugin } from './hvigor-plugin.js';
import { defaultRuntimeProfile, parseRuntimeProfile, runtimeProfileManifestSchema, runtimeProfileMissing, runtimeProfiles } from './runtime-profile.js';
import { contextEntrySource, noneEntrySource, runtimeGuardSource } from './runtime-sources.js';

export const runtimeIntegrationSchema = z.strictObject({
  module: z.string().min(1).max(64), profile: z.enum(runtimeProfiles).default('release-none'),
  write: z.boolean().default(false),
});
type Input = z.infer<typeof runtimeIntegrationSchema>;
const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function newFile(context: ExecutionContext, path: string, text: string) {
  const file = await readSnapshot(context, path);
  if (file.text !== null) { throw new InputInvalidError(`Integration target already exists: ${path}`); }
  return { path, oldHash: null, text };
}
async function runtimeDependency(context: ExecutionContext, directory: string) {
  const file = await readSnapshot(context, `${directory}/oh-package.json5`);
  if (file.text === null) { throw new InputInvalidError('RUNTIME_DEPENDENCY_UNDECLARED'); }
  parseSpans(file.text);
  const value = z.object({ dependencies: z.record(z.string(), z.string()) }).safeParse(JSON5.parse(file.text));
  const version = value.success ? value.data.dependencies['@ohmate/ohmatekit'] : undefined;
  if (!version || version.length > 1024 || /[\r\n\0]/.test(version)) {
    throw new InputInvalidError('RUNTIME_DEPENDENCY_UNDECLARED');
  }
  return { path: file.path, sha256: file.oldHash, coordinate: '@ohmate/ohmatekit', version };
}
export async function prepareRuntimeIntegration(input: Input, context: ExecutionContext) {
  const project = await readProject(context.projectRoot ?? context.cwd);
  const module = project.modules.find(module => module.name === input.module);
  if (!module || module.type !== 'entry') { throw new InputInvalidError('Declared entry module is required'); }
  const directory = relative(project.root, module.path).split('\\').join('/');
  const config = await readSnapshot(context, 'runtime-profile.json5');
  if (config.text !== null) { parseSpans(config.text); }
  const profile = parseRuntimeProfile(config.text === null ? defaultRuntimeProfile : JSON5.parse(config.text),
    project.modules.map(module => module.name));
  if (input.profile === 'release-core') { throw new InputInvalidError('RUNTIME_ENTRY_UNAVAILABLE'); }
  if (input.profile === 'release-none' && profile.release !== 'none') { throw new InputInvalidError('RUNTIME_PROFILE_SELECTION_MISMATCH'); }
  if (profile.probes.length) { throw new InputInvalidError('RUNTIME_PROBE_PRODUCER_UNAVAILABLE'); }
  const dependency = input.profile === 'release-none' ? null : await runtimeDependency(context, directory);
  const entryPath = `${directory}/src/main/ets/OHMateRuntimeEntry.ets`;
  const entry = input.profile === 'release-none' ? noneEntrySource() : contextEntrySource(input.profile);
  const hvigor = await readSnapshot(context, `${directory}/hvigorfile.ts`);
  if (hvigor.text === null) { throw new InputInvalidError('Module hvigorfile.ts is required'); }
  const profileHash = config.oldHash ?? sha256(serialize(defaultRuntimeProfile));
  const buildMode = input.profile === 'release-none' ? 'release' : 'debug';
  const manifest = runtimeProfileManifestSchema.parse({ schemaVersion: '1.0', profile: input.profile, buildMode, inputHash: profileHash,
    entry: { path: entryPath, sha256: sha256(entry) }, probes: [], buildId: null, completeness: 'incomplete' });
  const bindings = [{ path: relative(module.path, resolve(project.root, config.path)), sha256: profileHash },
    { path: 'src/main/ets/OHMateRuntimeEntry.ets', sha256: sha256(entry) },
    { path: 'ohmate-profile-manifest.json', sha256: sha256(serialize(manifest)) },
    ...dependency === null ? [] : [{ path: 'oh-package.json5', sha256: dependency.sha256! }]];
  const changes = [
    ...config.text === null ? [{ path: config.path, oldHash: null, text: serialize(defaultRuntimeProfile) }] : [],
    { path: hvigor.path, oldHash: hvigor.oldHash, text: attachPlugin(hvigor.text, 'ohmateRuntimePlugin', './ohmate-runtime-hvigor') },
    await newFile(context, entryPath, entry),
    await newFile(context, `${directory}/ohmate-runtime-hvigor.ts`, runtimeGuardSource(input.profile, bindings)),
    await newFile(context, `${directory}/ohmate-profile-manifest.json`, serialize(manifest)),
  ];
  const patch = { changes }, { review } = await inspectPatch(patch, context);
  return { patch, review: { ...review, inputHash: profileHash, profile: input.profile,
    releaseBuild: 'blocked', missing: runtimeProfileMissing, configBinding: 'reviewed-only',
    buildMode, runtimeBinding: dependency === null ? 'disabled' : 'declared-only', dependency },
    profile: input.profile, buildId: null, completeness: 'incomplete', missing: runtimeProfileMissing };
}
export const unavailableRuntimeIntegration = (input: Input) => ({ exitCode: 3 as const, data: {
  code: 'RUNTIME_ENTRY_UNAVAILABLE', profile: input.profile, write: false,
  missing: ['published-ohmatekit-public-entry', 'profile-specific-runtime-implementation', ...runtimeProfileMissing],
} });

export function runtimeIntegrationSpec(): ToolSpec {
  return {
    ...serviceSpec('integrate.runtime', 'Preview a Runtime Profile entry; explicit writes require reviewed approval',
      runtimeIntegrationSchema, async (value, context) => {
        const input = value as Input;
        if (input.profile === 'release-core') { return unavailableRuntimeIntegration(input); }
        const prepared = await prepareRuntimeIntegration(input, context);
        return input.write ? applyPatch(prepared.patch, context) : { exitCode: 0, data: { ...prepared, write: false } };
      }, [valueOption('module', 'Declared entry module'), valueOption('profile', 'release-none, release-core, debug or test'),
        { flags: '--write', description: 'Apply the reviewed integration Diff', required: false, optional: false, mandatory: false }]),
    requirements: ['project'], evidence: ['diff', 'profile-manifest'], idempotency: 'none',
    resolveRisk: async value => {
      const input = runtimeIntegrationSchema.parse(value);
      return input.write && input.profile !== 'release-core' ? 'R2' : 'R0';
    },
    review: async (value, context) => (await prepareRuntimeIntegration(runtimeIntegrationSchema.parse(value), context)).review,
  };
}
