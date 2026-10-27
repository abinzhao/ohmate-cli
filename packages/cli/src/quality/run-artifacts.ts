/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createExecutionContext } from '../runtime/context.js';
import type { ProcessOutput } from '../runtime/process-runner.js';
import type { ToolProvider } from '../toolchain/index.js';
import { Project } from '../utils/project.js';
import { withBuildLock } from '../utils/build-lock.js';
import { officialAdapters } from './toolchain.js';
import { evidenceFile, saveEvidence } from './evidence.js';

interface RunArtifactOptions {
  project: Project;
  modules: { moduleName: string; targetName: string }[];
  isEmulator: boolean;
  product: string;
  buildMode: string;
  provider: ToolProvider;
  dataDir: string;
}
function moduleSpecs(options: RunArtifactOptions): string[] {
  return [...new Set(options.modules.flatMap(({ moduleName, targetName }) =>
    options.project.collectNonHarDependentModuleList(moduleName).map((name) => `${name}@${targetName}`)))];
}
function collectArtifacts(project: Project, specs: string[], options: RunArtifactOptions): string[] {
  const artifacts = new Set<string>();
  for (const spec of specs) {
    const [name, target] = spec.split('@');
    artifacts.add(project.findArtifactPath(name, target, options.isEmulator, options.product));
    for (const file of project.findRemoteHspPaths(name, target, options.product)) { artifacts.add(file); }
  }
  return [...artifacts];
}
async function resolvePaths(options: RunArtifactOptions) {
  const context = await createExecutionContext({ cwd: options.project.rootDir,
    projectRoot: options.project.rootDir, dataDir: options.dataDir });
  const invocations: ProcessOutput[] = [], specs = moduleSpecs(options);
  const adapters = await officialAdapters(context, options.provider, invocations);
  let artifacts: string[] = [];
  const artifactEvidence: Awaited<ReturnType<typeof evidenceFile>>[] = [];
  let failure: string | null = null;
  try {
    await adapters.initialize();
    await adapters.hvigor.tasks(options.product, specs, options.buildMode);
    const project = Project.discover(options.project.rootDir, adapters.outputLayout());
    artifacts = collectArtifacts(project, specs, options);
    for (const file of artifacts) { artifactEvidence.push(await evidenceFile(project.rootDir, file)); }
    return artifacts;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await saveEvidence(context, 'run-artifact-paths', { product: options.product, modules: specs,
        outputLayout: adapters.outputLayout(), invocations, artifacts, artifactEvidence, failure, buildIdentity: 'unverified' });
    } finally { await adapters.close(); }
  }
}
export function resolveRunArtifacts(options: RunArtifactOptions): Promise<string[]> {
  return withBuildLock(options.project.rootDir, () => resolvePaths(options));
}
