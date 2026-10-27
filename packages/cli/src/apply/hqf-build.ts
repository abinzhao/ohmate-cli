/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import type { ToolProvider } from '../toolchain/index.js';
import { debugLog } from '../utils/logger.js';
import { resolveModuleSrcPath } from './module-path.js';

export async function buildSignedHqf(
  toolProvider: ToolProvider,
  projectRoot: string,
  moduleNames: string[],
  productName: string
): Promise<string[]> {
  const javaBinDir = path.dirname(toolProvider.javaPath);
  // NOTE: env 构造与 HvigorAdapter (hvigor-adapter.ts) 重复，后续可提取共享 helper 统一
  const env = {
    ...process.env,
    PATH: `${javaBinDir}${path.delimiter}${process.env.PATH || ''}`,
    DEVECO_SDK_HOME: toolProvider.sdkPath,
  } as Record<string, string>;

  const args = [
    toolProvider.hvigorJsPath,
    '--mode', 'module',
    '-p', `module=${moduleNames.join(',')}@${productName}`,
    '-p', `product=${productName}`,
    '-p', 'debuggable=true',
    'assembleDevHqf',
  ];

  debugLog(`[buildSignedHqf] ${toolProvider.nodePath} ${args.join(' ')}`);

  const result = await execa(toolProvider.nodePath, args, {
    cwd: projectRoot,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    reject: false,
  });

  // hvigor 用 exit code -1 表示"abc 编译产物无效"。
  // Windows 上 GetExitCodeProcess 返回无符号 DWORD，process.exit(-1) 经 execa 读到 4294967295；
  // `| 0` 重解释为 int32 还原 -1。
  const signedExitCode = (result.exitCode ?? 0) | 0;
  if (signedExitCode === -1) {
    throw new Error('hvigor hot compile produced invalid abc (exit code -1)');
  }
  if (signedExitCode !== 0) {
    throw new Error(`hvigor assembleDevHqf failed with exit code ${result.exitCode}`);
  }

  return moduleNames.map((m) => resolveHqfPath(projectRoot, m, productName));
}

function outputsDir(projectRoot: string, moduleName: string, productName: string): string {
  const srcPath = resolveModuleSrcPath(projectRoot, moduleName);
  return path.join(projectRoot, srcPath, 'build', productName, 'outputs');
}

function resolveSignedHqfPath(projectRoot: string, moduleName: string, productName: string): string {
  return path.join(outputsDir(projectRoot, moduleName, productName), `${moduleName}-${productName}-signed.hqf`);
}

function resolveHqfPath(projectRoot: string, moduleName: string, productName: string): string {
  const outputs = outputsDir(projectRoot, moduleName, productName);
  const exact = resolveSignedHqfPath(projectRoot, moduleName, productName);
  if (fs.existsSync(exact)) {
    return exact;
  }
  // 精确 signed 未找到 → 递归找 signed，再 fallback 任意 .hqf（含 unsigned，用于未配置 signingConfigs 的工程）
  const fallback =
    findHqfBySuffix(outputs, '-signed.hqf') ??
    findHqfBySuffix(outputs, '.hqf');
  if (!fallback) {
    throw new Error(`Signed hqf not found at ${exact} (and no *.hqf under ${outputs})`);
  }
  debugLog(`[buildSignedHqf] signed hqf not at exact path, using fallback: ${fallback}`);
  return fallback;
}

function findHqfBySuffix(dir: string, suffix: string): string | null {
  if (!fs.existsSync(dir)) {
    return null;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findHqfBySuffix(full, suffix);
      if (found) {
        return found;
      }
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      return full;
    }
  }
  return null;
}
