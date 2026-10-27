/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { access } from 'node:fs/promises';
import { ToolProvider } from '../toolchain/index.js';
import { readProject } from '../project-model/index.js';
import type { Diagnostic, ExecutionContext, ToolResult } from '../runtime/types.js';

async function inspectTools(warnings: Diagnostic[]) {
  try {
    const provider = await ToolProvider.new();
    const paths = {
      node: provider.nodePath, ohpm: provider.ohpmJsPath, hvigor: provider.hvigorJsPath,
      sdk: provider.sdkPath, hdc: provider.hdcPath, emulator: provider.emulatorPath,
    };
    const components = await Promise.all(Object.entries(paths).map(async ([name, path]) => ({
      name, path, available: await access(path).then(() => true, () => false),
    })));
    return { available: true, source: provider.sourceType, root: provider.toolchainRoot, version: provider.readVersion() ?? null, components };
  } catch (error) {
    warnings.push({ code: 'TOOLCHAIN_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
    return { available: false, components: [] };
  }
}

export async function inspectEnvironment(context: ExecutionContext): Promise<ToolResult> {
  const warnings: Diagnostic[] = [];
  let project = null;
  try {
    project = await readProject(context.projectRoot ?? context.cwd);
  } catch (error) {
    warnings.push({
      code: context.projectRoot ? 'PROJECT_INVALID' : 'PROJECT_NOT_FOUND',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const toolchain = await inspectTools(warnings);
  return {
    exitCode: context.projectRoot && !project ? 2 : 0,
    data: {
      node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 22 },
      platform: process.platform, arch: process.arch, project, toolchain,
      devices: { status: 'not-probed', reason: 'Device connections are queried only by explicit device commands' },
      telemetry: false,
    },
    warnings,
  };
}
