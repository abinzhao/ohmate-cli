/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { serviceSpec, valueOption } from '../agent/service-spec.js';
import { InputInvalidError, type ExecutionContext, type ToolSpec } from '../runtime/types.js';
import { buildRisk, buildSchema, executeBuild, reviewBuild } from './build-service.js';
import { inspectSigningJournal, restoreSigningJournal, reviewSigningRestore, signingRecoverySchema } from './build-signing.js';
import { cacheRecoverySchema, inspectCacheRestore, restoreBuildCache, reviewCacheRestore } from './build-cache.js';
import { parseLegacyBuildArguments } from '../legacy/catalog.js';
import { testSchema, resolveTests } from './test-scope.js';
import { executeTests, reviewTest } from './test-service.js';
export { sourceTokens, type SourceToken } from './source-tokens.js';
export { resolveRunArtifacts } from './run-artifacts.js';

const flag = (name: string, description: string): ToolSpec['options'][number] => ({
  flags: `--${name}`, description, required: false, optional: false, mandatory: false,
});
async function review(action: () => Promise<unknown>) {
  try { return await action(); }
  catch (error) { throw new InputInvalidError(error instanceof Error ? error.message : String(error)); }
}
const buildOptions = [valueOption('product', 'Declared product'), valueOption('modules', 'module@target selections', true),
  valueOption('build-mode', 'Declared build mode'), valueOption('assemble-type', 'Observed official assemble task'),
  valueOption('signing-config', 'Declared signing reference; requires R3 and is restored after the build'),
  flag('install', 'Approve OHPM dependency installation before sync/build')];
const testOptions = [valueOption('modules', 'Module selections', true), valueOption('files', 'File-scoped tests', true),
  valueOption('scope', 'Suite or Suite#method selections', true), flag('no-coverage', 'Disable coverage generation'),
  flag('asan', 'Instrument Test ASan request'), flag('build-only', 'Build the test package without running tests'),
  valueOption('device', 'Explicit device; execution requires a verified official selector')];
function testSpec(kind: 'local' | 'instrument'): ToolSpec {
  const schema = testSchema.extend({ kind: z.literal(kind).default(kind) });
  return { ...serviceSpec(`test.${kind}`, `Run official ${kind} tests with fresh-result evidence`, schema, executeTests, testOptions),
    risk: 'R2', timeoutMs: 30 * 60_000, requirements: ['project', 'toolchain'],
    review: (input: unknown, context: ExecutionContext) => review(() => reviewTest(input, context)),
    evidence: ['official-task-catalog', 'process-receipt', 'fresh-test-result', 'test-report'] };
}
function buildSpec(compatibility = false): ToolSpec {
  const id = compatibility ? 'deveco.build' : 'build.run';
  const schema = compatibility ? z.union([buildSchema, z.strictObject({ argv: z.array(z.string()) })]).refine((input) => {
    try { normalizeBuild(input); return true; } catch { return false; }
  }) : buildSchema;
  const spec = serviceSpec(id, 'Build through bundled DevEco adapters with approval and immutable provenance', schema,
    (input, context) => executeBuild(normalizeBuild(input), context, compatibility), compatibility ? buildOptions.filter((option) => option.flags !== '--install') : buildOptions);
  return { ...spec, command: compatibility ? ['build'] : spec.command,
    risk: 'R2', resolveRisk: (input, context) => buildRisk(normalizeBuild(input), context), timeoutMs: 30 * 60_000, requirements: ['project', 'toolchain'],
    review: (input, context) => review(() => reviewBuild(normalizeBuild(input), context, compatibility)),
    evidence: ['process-receipt', 'input-hashes', 'artifact-hashes', 'build-provenance', 'signing-reference-recovery'] };
}
function normalizeBuild(input: unknown) {
  return buildSchema.parse(input && typeof input === 'object' && 'argv' in input
    ? parseLegacyBuildArguments((input as { argv: string[] }).argv) : input);
}
function signingSpecs(): ToolSpec[] {
  const options = [valueOption('journal-id', 'Scoped signing-reference recovery journal')];
  return [
    serviceSpec('build.signing.inspect', 'Inspect outstanding signing-reference changes without modifying a profile', signingRecoverySchema,
      async (input, context) => ({ exitCode: 0, data: await inspectSigningJournal(signingRecoverySchema.parse(input).journalId, context) }), options),
    { ...serviceSpec('build.signing.restore', 'Restore the exact profile bytes only when its applied hash still matches', signingRecoverySchema,
      async (input, context) => {
        const result = await restoreSigningJournal(signingRecoverySchema.parse(input).journalId, context);
        return { exitCode: result.state === 'restored' ? 0 : 6, data: result, artifacts: [result.artifact] };
      }, options), risk: 'R3', review: (input, context) => review(() =>
        reviewSigningRestore(signingRecoverySchema.parse(input).journalId, context)) },
  ];
}
function cacheSpecs(): ToolSpec[] {
  const options = [valueOption('journal-id', 'Scoped quickfix-cache recovery journal')];
  return [
    serviceSpec('build.cache.inspect', 'Inspect reviewed quickfix compiler cache removals', cacheRecoverySchema,
      async (input, context) => ({ exitCode: 0, data: await inspectCacheRestore(cacheRecoverySchema.parse(input).journalId, context) }), options),
    { ...serviceSpec('build.cache.restore', 'Restore reviewed quickfix cache bytes without overwriting subsequent files', cacheRecoverySchema,
      (input, context) => restoreBuildCache(cacheRecoverySchema.parse(input).journalId, context), options),
    risk: 'R2', review: (input, context) => review(() => reviewCacheRestore(cacheRecoverySchema.parse(input).journalId, context)) },
  ];
}
export function getQualitySpecs(): ToolSpec[] {
  return [
    buildSpec(true),
    serviceSpec('build.plan', 'Read build targets, inputs and tool fingerprints without executing project scripts', buildSchema,
      async (input, context) => ({ exitCode: 0, data: await reviewBuild(input, context) }), buildOptions),
    buildSpec(), ...signingSpecs(), ...cacheSpecs(),
    serviceSpec('test.plan', 'Infer selected literal suites and methods without broadening file scope', testSchema,
      async (input, context) => {
        const selection = await resolveTests(input, context);
        return { exitCode: 0, data: { ...selection, project: undefined } };
      }, [valueOption('kind', 'local or instrument'), ...testOptions]),
    testSpec('local'), testSpec('instrument'),
  ];
}
