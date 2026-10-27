/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { ToolProvider } from '../toolchain/index.js';
import { executeToolProcess, type ProcessOutput } from '../runtime/process-runner.js';
import { debugLog } from '../utils/logger.js';
import type { ExecutionContext } from '../runtime/types.js';
import { evidenceFile } from './evidence.js';

export async function inspectQualityProducer(kind: 'scan' | 'docs') {
  const provider = await ToolProvider.new();
  const entry = kind === 'scan' ? provider.codelinterPath : provider.arktsdocPath;
  const script = await realpath(entry), node = await realpath(provider.nodePath);
  const tools = {
    node: { ...await evidenceFile(dirname(node), node), path: node },
    producer: { ...await evidenceFile(dirname(script), script), path: script },
  };
  return { provider, script, evidence: { kind, source: provider.sourceType, version: provider.readVersion() ?? null, tools } };
}
export async function qualityProducer(context: ExecutionContext, producer: Awaited<ReturnType<typeof inspectQualityProducer>>, invocations: ProcessOutput[]) {
  const root = resolve(join(context.dataDir, 'tool-runs'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) { throw new Error('Unsafe quality tool home'); }
  const home = await mkdtemp(join(root, `${producer.evidence.kind}-`));
  const env = {
    HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
    PATH: [dirname(producer.provider.nodePath), process.env.PATH ?? ''].join(delimiter),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    DEVECO_SDK_HOME: producer.provider.sdkPath, DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all',
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
  };
  return { home, close: () => rm(home, { recursive: true, force: true }),
    invoke: async (argv: string[]) => {
      const executable = producer.evidence.tools.node.path;
      debugLog(`Executing: ${executable} ${[producer.script, ...argv].join(' ')}`);
      const result = await executeToolProcess({ executable, argv: [producer.script, ...argv], env }, context);
      const output = result.data as ProcessOutput;
      invocations.push(output);
      return output;
    } };
}
