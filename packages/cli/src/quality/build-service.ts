/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { readProject } from '../project-model/index.js';
import { Project } from '../utils/project.js';
import { checkSyncRequired } from '../utils/project-check.js';
import { analyzeDependencies } from '../dependency/dependency-service.js';
import { cycloneDx } from '../dependency/sbom.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';
import type { ProcessOutput } from '../runtime/process-runner.js';
import { InputInvalidError } from '../runtime/types.js';
import { changedInputs, digest, inputEvidence, saveEvidence } from './evidence.js';
import { inspectBuildTools, officialAdapters, observedTasks, OfficialProcessError } from './toolchain.js';
import { collectBuildEvidence, snapshotBuildArtifacts } from './build-artifacts.js';
import { applySigning, failedSigningRecovery, prepareSigning, restoreSigningJournal, SigningApplyError, signingReview } from './build-signing.js';
import { cacheCleanupReview, prepareCacheCleanup, removeBuildCache } from './build-cache.js';
import { collectLoaderInputs, snapshotLoaders } from './loader-inputs.js';
import { compilerIdentityDrift } from './compiler-identity.js';
import { installedInputDrift, snapshotInstalledInputs } from './installed-inputs.js';
import type { CompilerObservation } from './compiler-observations.js';
import { emptyBuildOutputLayout, type BuildOutputLayout } from './build-output-layout.js';

export const buildSchema = z.strictObject({
  product: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  modules: z.array(z.string().regex(/^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/)).min(1).max(64).optional(),
  buildMode: z.string().regex(/^[A-Za-z0-9_-]+$/).default('debug'),
  assembleType: z.enum(['assembleApp', 'assembleHap', 'assembleHsp', 'assembleHar']).optional(),
  signingConfig: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  install: z.boolean().default(false),
});
const taskFor = (type: string) => type === 'shared' ? 'assembleHsp' : type === 'har' ? 'assembleHar' : 'assembleHap';
export async function resolveBuild(input: unknown, context: ExecutionContext, compatibility = false) {
  const value = buildSchema.parse(input), model = await readProject(context.projectRoot ?? context.cwd);
  const project = Project.discover(model.root), product = value.product ?? 'default';
  project.validateProduct(product);
  const modes = new Set(['debug', 'release', ...project.profile.app.buildModeSet?.map((item) => item.name) ?? []]);
  if (!modes.has(value.buildMode)) { throw new InputInvalidError('Unknown build mode'); }
  const isProduct = value.assembleType === 'assembleApp' || Boolean(value.product && !value.modules && !value.assembleType);
  const candidates = model.modules.filter((item) => item.type === 'entry');
  const defaults = model.modules.length === 1 ? [model.modules[0].name] : candidates.length === 1 ? [candidates[0].name] : [];
  const modules = isProduct ? project.resolveModuleSpecsForProduct(product) : value.modules ?? defaults;
  if (!modules.length) { throw new InputInvalidError('Select an unambiguous module or product'); }
  const selected = modules.map((name) => name.includes('@') ? name : `${name}@default`);
  const allowed = new Set(project.resolveModuleSpecsForProduct(product));
  if (selected.some((name) => !allowed.has(name))) { throw new InputInvalidError('Unknown module/target or target excludes the selected product'); }
  const tasks = isProduct ? ['assembleApp'] : [...new Set(selected.map((name) => {
    const type = model.modules.find((item) => item.name === name.split('@')[0])!.type;
    if (!compatibility && value.assembleType && value.assembleType !== taskFor(type)) { throw new InputInvalidError('Assemble task does not match module type'); }
    return value.assembleType ?? taskFor(type);
  }))];
  return { ...value, product, modules: selected, tasks, isProduct, project, model };
}
export async function buildRisk(input: unknown, context: ExecutionContext) {
  const target = await resolveBuild(input, context, true);
  const signing = await prepareSigning(target.project, target.product, target.signingConfig, context);
  return signing.effective ? 'R3' as const : 'R2' as const;
}
export async function reviewBuild(input: unknown, context: ExecutionContext, compatibility = false) {
  const target = await resolveBuild(input, context, compatibility), tools = await inspectBuildTools(), inputs = await inputEvidence(context);
  const installedInputs = await snapshotInstalledInputs(target.model, context);
  const signing = signingReview(await prepareSigning(target.project, target.product, target.signingConfig, context));
  const syncRequired = checkSyncRequired(target.project.rootDir).required || Boolean(signing.change);
  const install = target.install || compatibility && syncRequired;
  const cacheCleanup = cacheCleanupReview(await prepareCacheCleanup(target.model, context));
  return { product: target.product, modules: target.modules, buildMode: target.buildMode, tasks: target.tasks,
    install, syncRequired, dependencyInstall: compatibility ? 'when-sync-required' : target.install ? 'requested' : 'not-requested', signing, cacheCleanup,
    writes: ['project build/cache directories', 'private tool home', 'immutable quality evidence', ...signing.change ? ['temporary product signing reference'] : []],
    network: install ? 'ohpm-install-and-toolchain-bootstrap-requested' : 'toolchain-bootstrap-and-project-scripts-may-download',
    tools: tools.evidence, inputs: inputs.files.map(({ path, sha256 }) => ({ path, sha256 })), excludedInputs: inputs.skipped, installedInputs };
}
export function buildDiagnostics(invocations: ProcessOutput[]) {
  return invocations.flatMap((item) => {
    const original = [item.stdout, item.stderr].filter(Boolean).join('\n');
    const blocking = item.toolExitCode !== 0 || item.truncated ? [{
      priority: 'P0', code: item.truncated ? 'OFFICIAL_OUTPUT_TRUNCATED' : 'OFFICIAL_TOOL_FAILED', original,
      toolExitCode: item.toolExitCode, source: 'official-tool', normalized: 'blocking',
    }] : [];
    const other = original.split(/\r?\n/).flatMap((line) => {
      const warning = /(?:^|\s)(?:WARN(?:ING)?)(?:\s*:|\s+\[)/i.test(line);
      const note = /(?:^|\s)NOTE\s*:/i.test(line);
      return warning || note ? [{ priority: warning ? 'P1' : 'P2', code: warning ? 'OFFICIAL_WARNING' : 'OFFICIAL_NOTE',
        original: line, toolExitCode: item.toolExitCode, source: 'official-tool', normalized: warning ? 'warning' : 'note' }] : [];
    });
    return [...blocking, ...other];
  });
}
async function runBuildTasks(target: Awaited<ReturnType<typeof resolveBuild>>, adapters: Awaited<ReturnType<typeof officialAdapters>>) {
  if (target.isProduct) { await adapters.hvigor.buildProduct(target.product, target.buildMode); return; }
  for (const task of target.tasks) {
    const modules = target.assembleType ? target.modules : target.modules.filter((name) =>
      taskFor(target.model.modules.find((item) => item.name === name.split('@')[0])!.type) === task);
    await adapters.hvigor.buildModules(target.product, target.buildMode, modules, new Set([task]));
  }
}
export async function executeBuild(input: unknown, context: ExecutionContext, compatibility = false): Promise<ToolResult> {
  const target = await resolveBuild(input, context, compatibility), tools = await inspectBuildTools(), inputs = await inputEvidence(context);
  const dependenciesBefore = await analyzeDependencies(context), invocations: ProcessOutput[] = [];
  let before = await snapshotBuildArtifacts(target), outputLayoutBefore = emptyBuildOutputLayout();
  const loadersBefore = await snapshotLoaders(target);
  const signing = await prepareSigning(target.project, target.product, target.signingConfig, context);
  const caches = await prepareCacheCleanup(target.model, context);
  const syncRequired = checkSyncRequired(target.project.rootDir).required || Boolean(signing.change);
  let installedInputs = await snapshotInstalledInputs(target.model, context);
  let installedInputPhase = 'before-tools';
  const adapters = await officialAdapters(context, tools.provider, invocations);
  let cacheCleanup: Awaited<ReturnType<typeof removeBuildCache>> = null;
  let signingId: string | null = null, restoration: Awaited<ReturnType<typeof restoreSigningJournal>> | null = null;
  let failure: unknown, dependencies = dependenciesBefore, compilerInputs = inputs;
  try {
    signingId = await applySigning(signing, target.product, context);
    cacheCleanup = await removeBuildCache(caches, context);
    if (cacheCleanup?.failure) { throw new Error(cacheCleanup.failure); }
    await adapters.initialize();
    if (target.install || compatibility && syncRequired) { await adapters.ohpm.install(); }
    if (syncRequired) { await adapters.hvigor.sync(target.product, target.buildMode); }
    compilerInputs = await inputEvidence(context); dependencies = await analyzeDependencies(context);
    installedInputs = await snapshotInstalledInputs(target.model, context);
    installedInputPhase = 'precompile';
    await adapters.hvigor.tasks(target.product, target.isProduct ? undefined : target.modules, target.buildMode);
    outputLayoutBefore = adapters.outputLayout();
    const snapshot = await snapshotBuildArtifacts(target, outputLayoutBefore);
    before = { ...snapshot, files: new Map([...snapshot.files, ...before.files]),
      directories: new Set([...before.directories, ...snapshot.directories]), missing: [...before.missing, ...snapshot.missing] };
    const available = new Set([...observedTasks(invocations), ...tools.evidence.taskDefinitions.tasks]);
    if (target.tasks.some((task) => !available.has(task))) { throw new Error('Requested task was not observed in the official catalog or installed declarations'); }
    await runBuildTasks(target, adapters);
  } catch (error) {
    failure = error;
    if (error instanceof SigningApplyError) { signingId = error.journalId; }
  }
  finally {
    try { await adapters.close(); } catch (error) { failure ??= error; }
    if (signingId) {
      try { restoration = await restoreSigningJournal(signingId, context); }
      catch (error) { failure = error; restoration = await failedSigningRecovery(signingId, context); }
      if (restoration?.state !== 'restored') { failure ??= new Error('Signing reference requires recovery'); }
    }
  }
  return buildResult({ target, tools, inputs, dependenciesBefore, invocations, before, loadersBefore, signing,
    restoration, cacheCleanup, failure, dependencies, compilerInputs, installedInputs, installedInputPhase,
    compilerObservation: adapters.compilerObservation(), outputLayout: adapters.outputLayout(), outputLayoutBefore }, context);
}
async function buildSourceDrift(context: ExecutionContext, inputs: Awaited<ReturnType<typeof inputEvidence>>,
  compilerInputs: Awaited<ReturnType<typeof inputEvidence>>, restored: boolean) {
  const compiled = restored ? compilerInputs.files.filter((item) => item.path !== 'build-profile.json5') : compilerInputs.files;
  const quiet = { ...context, abortSignal: new AbortController().signal };
  const changed = [...await changedInputs(quiet, inputs.files), ...await changedInputs(quiet, compiled)];
  try {
    const current = await inputEvidence(quiet), known = new Set(compilerInputs.files.map((item) => item.path));
    changed.push(...current.files.filter((item) => !known.has(item.path)).map((item) => item.path));
  } catch { changed.push('INPUT_SET_UNREADABLE'); }
  return [...new Set(changed)].sort();
}
function observedInputInvalid(observation: CompilerObservation) {
  return observation.invalid || observation.drift.length > 0;
}
interface BuildRun {
  target: Awaited<ReturnType<typeof resolveBuild>>; tools: Awaited<ReturnType<typeof inspectBuildTools>>;
  inputs: Awaited<ReturnType<typeof inputEvidence>>; compilerInputs: Awaited<ReturnType<typeof inputEvidence>>;
  dependenciesBefore: Awaited<ReturnType<typeof analyzeDependencies>>; dependencies: Awaited<ReturnType<typeof analyzeDependencies>>;
  invocations: ProcessOutput[]; before: Awaited<ReturnType<typeof snapshotBuildArtifacts>>;
  loadersBefore: Awaited<ReturnType<typeof snapshotLoaders>>;
  compilerObservation: CompilerObservation;
  outputLayout: BuildOutputLayout; outputLayoutBefore: BuildOutputLayout;
  installedInputs: Awaited<ReturnType<typeof snapshotInstalledInputs>>; installedInputPhase: string;
  signing: Awaited<ReturnType<typeof prepareSigning>>; restoration: Awaited<ReturnType<typeof restoreSigningJournal>> | null; failure: unknown;
  cacheCleanup: Awaited<ReturnType<typeof removeBuildCache>>;
}
async function buildResult(run: BuildRun, context: ExecutionContext): Promise<ToolResult> {
  const { target, tools, inputs, compilerInputs, dependenciesBefore, dependencies, invocations, before, loadersBefore, signing, restoration, cacheCleanup, failure } = run;
  const outputs = await collectBuildEvidence(target, before, run.outputLayout), { artifacts } = outputs;
  const sourceDrift = await buildSourceDrift(context, inputs, compilerInputs, restoration?.state === 'restored');
  const loaderInputs = await collectLoaderInputs(target, loadersBefore, context, run.compilerObservation);
  const compilerDrift = await compilerIdentityDrift(tools.evidence.compilerIdentity);
  const installedAfter = await snapshotInstalledInputs(target.model, { ...context, abortSignal: new AbortController().signal });
  const installedDrift = installedInputDrift(run.installedInputs, installedAfter);
  const sbom = await saveEvidence(context, 'build-sbom', cycloneDx(dependencies));
  const provenance = { schemaVersion: '1.0', analyzerVersion: '1.0', completeness: 'incomplete',
    product: target.product, modules: target.modules, buildMode: target.buildMode, buildId: null,
    upstream: 'supplied-deveco-snapshot', tools: tools.evidence.tools, toolchain: tools.evidence,
    inputs: compilerInputs.files.map(({ path, sha256, size }) => ({ path, sha256, size })), reviewedInputs: inputs.files,
    excludedInputs: inputs.skipped, dependenciesBefore, dependencies, invocations, artifacts,
    sbom: { ...sbom, format: 'cyclonedx', scope: 'dependency-inventory' },
    artifactEvidence: outputs.artifactEvidence, missingArtifacts: outputs.missing, sourceDrift, loaderInputs, compilerDrift,
    compilerObservation: run.compilerObservation,
    outputLayout: { ...run.outputLayout, beforeBuild: run.outputLayoutBefore },
    installedInputs: { ...run.installedInputs, inputPhase: run.installedInputPhase },
    installedInputDrift: installedDrift, installedInputMissing: installedAfter.missing, signing: signingReview(signing),
    missing: [...tools.evidence.unavailable, ...loaderInputs.missing, ...run.compilerObservation.missing, ...run.outputLayout.missing,
      'full-compiler-input-closure', 'cache-hermeticity', 'native-abi-validation'] };
  const manifest = await saveEvidence(context, 'build-provenance', provenance);
  const bundle = target.project.getBundleName(), buildRef = `${bundle}@${target.product}@${target.buildMode}@${digest(JSON.stringify(provenance))}`;
  return { exitCode: context.abortSignal.aborted ? 130 : failure ? 6 : !outputs.complete || sourceDrift.length ||
      loaderInputs.invalidInputs || compilerDrift.length || installedDrift.length || run.installedInputs.missing.length || installedAfter.missing.length || observedInputInvalid(run.compilerObservation) ? 3 : 0,
    data: { execution: context.abortSignal.aborted ? 'cancelled' : failure ? 'failed' : 'executed',
      product: target.product, modules: target.modules, buildMode: target.buildMode, buildRef, buildId: null,
      provenance, invocations, diagnostics: buildDiagnostics(invocations), configuration: {
        cacheCleanup: cacheCleanup ? { ...cacheCleanup, artifacts: undefined,
          recovery: `ohmatecli build cache inspect --journal-id ${cacheCleanup.journalId}` } : { state: 'unchanged' },
        signing: restoration ? {
        state: restoration.state, journalId: restoration.journalId, recovery: restoration.recovery,
      } : { state: 'unchanged', effective: signing.effective } },
      failure: failure instanceof OfficialProcessError ? 'OFFICIAL_TOOL_FAILED' : failure instanceof Error ? failure.message : null,
      verification: { build: failure ? 'failed' : 'executed', artifactIdentity: outputs.complete && !sourceDrift.length &&
          !installedDrift.length && !run.installedInputs.missing.length && !installedAfter.missing.length && !observedInputInvalid(run.compilerObservation) && !loaderInputs.invalidInputs ? 'fresh' : 'incomplete',
        test: 'not-run', nativeAbi: 'not-run', symbols: 'not-run' } },
    artifacts: [...artifacts, sbom, manifest, ...restoration ? [restoration.artifact] : [], ...cacheCleanup?.artifacts ?? []],
    warnings: target.assembleType && !target.isProduct && target.modules.some((name) =>
      taskFor(target.model.modules.find((item) => item.name === name.split('@')[0])!.type) !== target.assembleType)
      ? [{ code: 'ASSEMBLE_TYPE_MISMATCH', message: 'The requested official task may be incompatible with the selected module type' }] : [],
    provenance: { completeness: 'incomplete', manifestHash: manifest.sha256, buildRef } };
}
