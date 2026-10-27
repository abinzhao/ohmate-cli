/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { readProject } from '../project-model/index.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const probeSchema = z.strictObject({
  id: identifier, kind: z.enum(['runtime-aspect', 'aspect-plugin', 'abckitts']),
  module: identifier, ruleHash: z.string().regex(/^[a-f0-9]{64}$/), runtimeGate: z.literal(true),
});
export const runtimeProfileSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), release: z.enum(['none', 'core']),
  debug: z.literal('debug'), test: z.literal('test'), probes: z.array(probeSchema).max(256),
}).refine(value => new Set(value.probes.map(probe => probe.id)).size === value.probes.length);
export const defaultRuntimeProfile = { schemaVersion: '1.0', release: 'none', debug: 'debug', test: 'test', probes: [] } as const;
export const runtimeProfiles = ['release-none', 'release-core', 'debug', 'test'] as const;
export const runtimeProfileManifestSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), profile: z.enum(runtimeProfiles),
  buildMode: z.enum(['release', 'debug', 'test']), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  entry: z.strictObject({ path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  probes: z.array(probeSchema).max(256), buildId: z.string().min(1).max(128).nullable(),
  completeness: z.enum(['complete', 'incomplete']),
});
export const runtimeProfileMissing = [
  'compiler-bound-profile-entry', 'compiled-Aspect-AbcKitTS-and-debug-manifest-purity', 'final-artifact-purity',
] as const;
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

export function parseRuntimeProfile(value: unknown, modules: string[]): RuntimeProfile {
  const parsed = runtimeProfileSchema.safeParse(value);
  if (!parsed.success) { throw new InputInvalidError('RUNTIME_PROFILE_SCHEMA_INVALID'); }
  if (parsed.data.probes.some(probe => !modules.includes(probe.module))) {
    throw new InputInvalidError('RUNTIME_PROBE_MODULE_UNDECLARED');
  }
  return parsed.data;
}

/** Declaration validation never proves compiled probe presence or Release elimination. */
export async function validateRuntimeProfile(value: unknown, context: ExecutionContext) {
  try {
    const project = await readProject(context.projectRoot ?? context.cwd);
    const profile = parseRuntimeProfile(value, project.modules.map(module => module.name));
    return { status: 'incomplete' as const, staticValid: true, profile,
      missing: [...runtimeProfileMissing, ...profile.probes.length ? ['probe-transform-producer-and-dependency-version'] : []],
      findings: [] };
  } catch (error) {
    if (!(error instanceof InputInvalidError)) { throw error; }
    return { status: 'invalid' as const, staticValid: false, missing: [],
      findings: [{ code: error.message, source: 'ohmate' }] };
  }
}
