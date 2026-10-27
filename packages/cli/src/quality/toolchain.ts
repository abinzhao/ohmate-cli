/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, delimiter, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { ToolProvider } from '../toolchain/index.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { OhpmAdapter } from '../utils/ohpm-adapter.js';
import { executeToolProcess, type ProcessOutput } from '../runtime/process-runner.js';
import type { ExecutionContext } from '../runtime/types.js';
import { evidenceFile } from './evidence.js';
import { installedTaskDefinitions } from './task-definitions.js';
import { installedCompilerIdentity } from './compiler-identity.js';
import { compilerObserverSource } from './compiler-observer-source.js';
import { collectCompilerObservations, emptyCompilerObservation } from './compiler-observations.js';
import { buildOutputObserverSource } from './build-output-observer-source.js';
import { collectBuildOutputLayout, emptyBuildOutputLayout } from './build-output-layout.js';

export class OfficialProcessError extends Error {
  constructor(readonly result: ProcessOutput) { super('Official tool failed; consult the original invocation evidence'); }
}
export async function inspectBuildTools() {
  const provider = await ToolProvider.new();
  provider.assertJava();
  const tools: Record<string, { path: string; sha256: string }> = {};
  for (const [name, path] of Object.entries({
    node: provider.nodePath, hvigor: provider.hvigorJsPath, ohpm: provider.ohpmJsPath, java: provider.javaPath,
  })) {
    const file = await realpath(path);
    tools[name] = { path: file, sha256: (await evidenceFile(dirname(file), file)).sha256 };
  }
  const metadata = join(provider.sdkPath, 'default/sdk-pkg.json');
  const sdk = await evidenceFile(provider.sdkPath, metadata).catch(() => null);
  const taskDefinitions = await installedTaskDefinitions(provider.hvigorJsPath);
  const compilerIdentity = await installedCompilerIdentity(provider.sdkPath);
  return { provider, evidence: { source: provider.sourceType, version: provider.readVersion() ?? null,
    tools, sdk, sdkPath: provider.sdkPath, taskDefinitions, compilerIdentity,
    unavailable: ['arkts-compiler-version', 'native-toolchain-version', ...compilerIdentity.components.arkguardPackage ? [] : ['arkguard-version']] } };
}
function environment(provider: ToolProvider, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home,
    PATH: [dirname(provider.javaPath), dirname(provider.nodePath), process.env.PATH ?? ''].join(delimiter),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    JAVA_HOME: dirname(dirname(provider.javaPath)), DEVECO_SDK_HOME: provider.sdkPath,
    HVIGOR_USER_HOME: join(home, '.hvigor'), OHPM_HOME: join(home, '.ohpm'),
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
    DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all',
  };
}
export async function officialAdapters(context: ExecutionContext, provider: ToolProvider, invocations: ProcessOutput[]) {
  const root = resolve(join(context.dataDir, 'tool-runs'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) { throw new Error('Unsafe tool process home'); }
  const home = await mkdtemp(join(root, 'build-')), env = environment(provider, home);
  const observationDirectory = join(home, 'compiler-observations'), observer = join(home, 'compiler-observer.cjs');
  const outputDirectory = join(home, 'output-observations');
  await mkdir(observationDirectory, { mode: 0o700 });
  await mkdir(outputDirectory, { mode: 0o700 });
  await writeFile(observer, compilerObserverSource + buildOutputObserverSource, { flag: 'wx', mode: 0o600 });
  let compilerObservation = emptyCompilerObservation();
  let outputLayout = emptyBuildOutputLayout();
  const invoke = async (script: string, args: string[]) => {
    const observing = script === provider.hvigorJsPath && args.some((arg) => /^assemble/.test(arg));
    const observingOutputs = observing || script === provider.hvigorJsPath && args.includes('tasks');
    const processEnv = observingOutputs ? { ...env, NODE_OPTIONS: `--require ${JSON.stringify(observer)}`,
      OHMATE_COMPILER_OBSERVATIONS: observationDirectory, OHMATE_COMPILER_PROJECT: context.projectRoot ?? context.cwd,
      OHMATE_COMPILER_SDK: provider.sdkPath, OHMATE_BUILD_OUTPUT_OBSERVATIONS: outputDirectory,
      ...(args.includes('tasks') ? { OHMATE_QUERY_OUTPUT_METADATA: '1' } : {}) } : env;
    const result = await executeToolProcess({ executable: provider.nodePath, argv: [script, ...args], env: processEnv }, context);
    const output = result.data as ProcessOutput;
    invocations.push(output);
    if (observing) {
      compilerObservation = await collectCompilerObservations(observationDirectory, context.projectRoot ?? context.cwd, provider.sdkPath)
        .catch(() => ({ ...emptyCompilerObservation(), invalid: true, missing: ['compiler-observation-unreadable'] }));
    }
    if (observingOutputs) {
      outputLayout = await collectBuildOutputLayout(outputDirectory, context.projectRoot ?? context.cwd)
        .catch(() => ({ ...emptyBuildOutputLayout(), invalid: true, missing: ['build-output-observation-unreadable'] }));
    }
    if (result.exitCode !== 0) { throw new OfficialProcessError(output); }
  };
  let noDaemon = false;
  const hvigor = new HvigorAdapter(provider, context.projectRoot ?? context.cwd, true,
    (args) => invoke(provider.hvigorJsPath, [...args, ...(noDaemon ? ['--no-daemon'] : [])]));
  return {
    hvigor, ohpm: new OhpmAdapter(provider, context.projectRoot ?? context.cwd, (args) => invoke(provider.ohpmJsPath, args)),
    compilerObservation: () => compilerObservation,
    outputLayout: () => outputLayout,
    initialize: async () => {
      await invoke(provider.hvigorJsPath, ['--help']);
      noDaemon = /--no-daemon\b/.test(invocations.at(-1)!.stdout);
      if (!noDaemon) { throw new Error('An observed no-daemon backend is required for isolated execution'); }
    },
    close: () => rm(home, { recursive: true, force: true }),
  };
}
export function observedTasks(invocations: ProcessOutput[]): Set<string> {
  const text = stripVTControlCharacters([...invocations].reverse().find((item) => item.argv.includes('tasks'))?.stdout ?? '');
  const qualified = [...text.matchAll(/(?:^|\n)\s*(?::?[\w.-]+[:@])+([A-Za-z][\w]*)(?=\s|$)/g)].map((item) => item[1]);
  const described = [...text.matchAll(/(?:^|\n)([A-Za-z][\w]*) - [^\n]+/g)].map((item) => item[1]);
  return new Set([...qualified, ...described]);
}
