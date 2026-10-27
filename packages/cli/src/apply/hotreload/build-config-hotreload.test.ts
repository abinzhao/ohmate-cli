/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HotReloadBuildConfigManager } from './build-config-hotreload.js';
import type { ToolProvider } from '../../toolchain/index.js';
interface BuildConfig {
  compileConfig: Record<string, string>;
  patchConfig: Record<string, string>;
}
const toolProvider = {
  nodePath: path.join('/sdk', 'toolchains', 'node'),
} as ToolProvider;
interface ExpectedPaths {
  nodeDir: string;
  buildDefault: string;
  intermediates: string;
  loaderOut: string;
  resDir: string;
}
function expectedPaths(moduleDir: string, productName: string): ExpectedPaths {
  const buildDefault = path.join(moduleDir, 'build', productName);
  const intermediates = path.join(buildDefault, 'intermediates');
  return {
    nodeDir: path.dirname(toolProvider.nodePath) + path.sep,
    buildDefault,
    intermediates,
    loaderOut: path.join(intermediates, 'loader_out', productName),
    resDir: path.join(intermediates, 'res', productName),
  };
}
function expectedCompileConfig(
  projectRoot: string,
  moduleDir: string,
  productName: string,
  paths: ExpectedPaths
): Record<string, string> {
  const { nodeDir, buildDefault, intermediates, loaderOut, resDir } = paths;
  return {
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
    cachePath: path.join(
      buildDefault,
      'cache',
      productName,
      `${productName}@CompileArkTS`,
      'esmodule',
      'debug'
    ),
    aceBuildJson: path.join(
      intermediates,
      'loader',
      productName,
      'loader.json'
    ),
    aceModuleJsonPath: path.join(resDir, 'module.json'),
    aceSoPath: path.join(loaderOut, 'nativeDependencies.txt'),
    aceModuleRoot: path.join(moduleDir, 'src', 'main', 'ets'),
    aceModuleBuild: path.join(loaderOut, 'ets'),
    aceProfilePath: path.join(resDir, 'resources', 'base', 'profile'),
    aceSuperVisualPath: path.join(moduleDir, 'src', 'main', 'supervisual'),
    watchMode: 'true',
  };
}
function expectedPatchConfig(paths: ExpectedPaths): Record<string, string> {
  const { intermediates, loaderOut } = paths;
  return {
    enableMap: 'true',
    mode: 'hotReload',
    oldMapFilePath: path.join(loaderOut, 'ets'),
    changedFileList: path.join(
      intermediates,
      'hotReload',
      'changedFileList.json'
    ),
    patchAbcPath: path.join(intermediates, 'hotReload', 'patchAbcPath', 'ets'),
    removeChangedFileListInSdk: 'true',
  };
}
function expectedConfig(
  projectRoot: string,
  moduleDir: string,
  productName: string
): BuildConfig {
  const paths = expectedPaths(moduleDir, productName);
  return {
    compileConfig: expectedCompileConfig(
      projectRoot,
      moduleDir,
      productName,
      paths
    ),
    patchConfig: expectedPatchConfig(paths),
  };
}
function readConfig(moduleDir: string): BuildConfig {
  const configPath = path.join(
    moduleDir,
    'build',
    'config',
    'buildConfig.json'
  );
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as BuildConfig;
}
describe('HotReloadBuildConfigManager.generate', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-hotreload-config-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('writes the full buildConfig.json, creating the module tree on the way', () => {
    HotReloadBuildConfigManager.generate(
      root,
      'entry',
      'default',
      toolProvider
    );
    const moduleDir = path.join(root, 'entry');
    expect(readConfig(moduleDir)).toEqual(
      expectedConfig(root, moduleDir, 'default')
    );
  });
  it('resolves the module directory through the build profile srcPath', () => {
    fs.writeFileSync(
      path.join(root, 'build-profile.json5'),
      `{ "modules": [{ "name": "feature", "srcPath": "./features/feature" }] }`,
      'utf-8'
    );
    HotReloadBuildConfigManager.generate(
      root,
      'feature',
      'default',
      toolProvider
    );
    const moduleDir = path.join(root, 'features', 'feature');
    const config = readConfig(moduleDir);
    expect(config).toEqual(expectedConfig(root, moduleDir, 'default'));
    expect(config.compileConfig.aceModuleRoot).toBe(
      path.join(moduleDir, 'src', 'main', 'ets')
    );
  });
  it('keeps every path relative to the requested product name', () => {
    HotReloadBuildConfigManager.generate(
      root,
      'entry',
      'preview',
      toolProvider
    );
    const moduleDir = path.join(root, 'entry');
    const config = readConfig(moduleDir);
    expect(config).toEqual(expectedConfig(root, moduleDir, 'preview'));
    expect(config.patchConfig.changedFileList).toBe(
      path.join(
        moduleDir,
        'build',
        'preview',
        'intermediates',
        'hotReload',
        'changedFileList.json'
      )
    );
  });
  it('overwrites a stale buildConfig.json on regeneration', () => {
    HotReloadBuildConfigManager.generate(
      root,
      'entry',
      'default',
      toolProvider
    );
    const configPath = path.join(
      root,
      'entry',
      'build',
      'config',
      'buildConfig.json'
    );
    fs.writeFileSync(configPath, 'stale content', 'utf-8');
    HotReloadBuildConfigManager.generate(
      root,
      'entry',
      'default',
      toolProvider
    );
    const moduleDir = path.join(root, 'entry');
    expect(readConfig(moduleDir)).toEqual(
      expectedConfig(root, moduleDir, 'default')
    );
  });
  it('enables the hotfix symbol map for hot reload builds', () => {
    HotReloadBuildConfigManager.generate(
      root,
      'entry',
      'default',
      toolProvider
    );
    const { patchConfig } = readConfig(path.join(root, 'entry'));
    expect(patchConfig.enableMap).toBe('true');
    expect(patchConfig.mode).toBe('hotReload');
    expect(patchConfig.patchAbcPath).toBe(
      path.join(
        root,
        'entry',
        'build',
        'default',
        'intermediates',
        'hotReload',
        'patchAbcPath',
        'ets'
      )
    );
    expect(patchConfig.removeChangedFileListInSdk).toBe('true');
  });
});
