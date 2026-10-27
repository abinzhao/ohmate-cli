/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * BuildConfigManager：生成/清理 build/config/buildConfig.json（含
 * compileConfig + patchConfig），供 apply 的 hvigor assembleDevHqf 使用。
 *
 * 该文件存在期间，hvigor 的 GenerateLoaderJson 会把它的 patchConfig 注入
 * loader.json，使 ArkTS 编译进入热重载模式 —— 普通 hap 构建会因此多生成
 * ets/symbolMap.map。因此只允许在 hqf 构建期间通过 withBuildConfig 短暂
 * 存在，禁止在普通 run/build 流程生成。
 */

import fs from 'fs';
import * as path from 'path';
import { ToolProvider } from '../toolchain/index.js';
import type { Project } from '../utils/project.js';
import { debugLog } from '../utils/logger.js';
import { resolveModuleSrcPath } from './module-path.js';

export class BuildConfigManager {
  public static generate(
    projectRoot: string,
    moduleName: string,
    productName: string,
    toolProvider: ToolProvider
  ): void {
    const srcPath = resolveModuleSrcPath(projectRoot, moduleName);
    const moduleDir = path.join(projectRoot, srcPath);
    const configDir = path.join(moduleDir, 'build', 'config');
    const config = BuildConfigManager.buildConfig(
      projectRoot, moduleDir, productName, toolProvider
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'buildConfig.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
    debugLog(`[BuildConfigManager] buildConfig.json written to ${configDir}`);
    // es2abc 不自动创建 ets 输出目录，需预建
    const etsOutDir = path.join(moduleDir, 'build', productName, 'intermediates', 'loader_out', productName, 'ets');
    fs.mkdirSync(etsOutDir, { recursive: true });
  }

  /** 删除模块的 buildConfig.json，不存在时静默返回 */
  public static remove(projectRoot: string, moduleName: string): void {
    const srcPath = resolveModuleSrcPath(projectRoot, moduleName);
    const configPath = path.join(projectRoot, srcPath, 'build', 'config', 'buildConfig.json');
    if (!fs.existsSync(configPath)) {
      return;
    }
    fs.unlinkSync(configPath);
    debugLog(`[BuildConfigManager] buildConfig.json removed: ${configPath}`);
  }

  /**
   * 清理项目所有模块的 buildConfig.json（旧版本 run 或热重载会话的遗留）。
   * 普通 run/build 构建前调用，残留会使 hvigor 把 patchConfig 注入普通构建
   * （hap 里多出 ets/symbolMap.map）；该文件只是 apply 的临时缓存，删除无副作用
   */
  public static removeAll(project: Project): void {
    for (const module of project.profile.modules) {
      BuildConfigManager.remove(project.rootDir, module.name);
    }
  }

  /**
   * 在 buildConfig.json 存在期间执行 hqf 构建（assembleDevHqf 依赖它），
   * 结束后（含失败）立即删除，避免残留把后续普通构建带入热重载编译模式
   */
  public static async withBuildConfig<T>(
    projectRoot: string,
    moduleNames: string[],
    productName: string,
    toolProvider: ToolProvider,
    action: () => Promise<T>
  ): Promise<T> {
    for (const moduleName of moduleNames) {
      BuildConfigManager.generate(projectRoot, moduleName, productName, toolProvider);
    }
    try {
      return await action();
    } finally {
      for (const moduleName of moduleNames) {
        BuildConfigManager.remove(projectRoot, moduleName);
      }
    }
  }

  private static buildConfig(
    projectRoot: string,
    moduleDir: string,
    productName: string,
    toolProvider: ToolProvider
  ): { compileConfig: Record<string, string>; patchConfig: Record<string, string> } {
    const nodeDir = path.dirname(toolProvider.nodePath) + path.sep;
    const buildDefault = path.join(moduleDir, 'build', productName);
    const intermediates = path.join(buildDefault, 'intermediates');
    const loaderOut = path.join(intermediates, 'loader_out', productName);
    const resDir = path.join(intermediates, 'res', productName);

    return {
      compileConfig: {
        deviceType: 'default',
        buildMode: 'debug',
        compilerType: 'ark',
        note: 'false',
        logLevel: '3',
        hapMode: 'false',
        img2bin: 'true',
        Path: nodeDir,
        projectProfilePath: path.join(projectRoot, 'build-profile.json5'),
        localPropertiesPath: path.join(projectRoot, 'local.properties'),
        appResource: path.join(resDir, 'ResourceTable.txt'),
        cachePath: path.join(buildDefault, 'cache', productName, `${productName}@CompileArkTS`, 'esmodule', 'debug'),
        aceBuildJson: path.join(intermediates, 'loader', productName, 'loader.json'),
        aceModuleJsonPath: path.join(resDir, 'module.json'),
        aceSoPath: path.join(loaderOut, 'nativeDependencies.txt'),
        aceModuleRoot: path.join(moduleDir, 'src', 'main', 'ets'),
        aceModuleBuild: path.join(loaderOut, 'ets'),
        aceProfilePath: path.join(resDir, 'resources', 'base', 'profile'),
        aceSuperVisualPath: path.join(moduleDir, 'src', 'main', 'supervisual'),
        watchMode: 'true',
      },
      // apply(hqf)不启用 hotfix symbol map;热重载用独立的 HotReloadBuildConfigManager
      patchConfig: {
        enableMap: 'false',
        mode: 'hotReload',
        oldMapFilePath: path.join(loaderOut, 'ets'),
        changedFileList: path.join(intermediates, 'patch', productName, 'changedFileList.json'),
        patchAbcPath: path.join(intermediates, 'patch', productName, 'ets'),
        removeChangedFileListInSdk: 'true',
      },
    };
  }
}
