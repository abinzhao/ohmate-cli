/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildConfigManager } from './build-config.js';
import type { ToolProvider } from '../toolchain/index.js';

interface BuildConfig {
  compileConfig: Record<string, string>;
  patchConfig: Record<string, string>;
}

const toolProvider = {
  nodePath: path.join('/sdk', 'toolchains', 'node'),
} as ToolProvider;

function expectedCompileConfig(
  projectRoot: string,
  moduleDir: string,
  productName: string
): Record<string, string> {
  const nodeDir = path.dirname(toolProvider.nodePath) + path.sep;
  const buildDefault = path.join(moduleDir, 'build', productName);
  const intermediates = path.join(buildDefault, 'intermediates');
  const loaderOut = path.join(intermediates, 'loader_out', productName);
  const resDir = path.join(intermediates, 'res', productName);

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

function expectedPatchConfig(
  moduleDir: string,
  productName: string
): Record<string, string> {
  const intermediates = path.join(
    moduleDir,
    'build',
    productName,
    'intermediates'
  );
  const loaderOut = path.join(intermediates, 'loader_out', productName);
  const patchDir = path.join(intermediates, 'patch', productName);

  return {
    enableMap: 'false',
    mode: 'hotReload',
    oldMapFilePath: path.join(loaderOut, 'ets'),
    changedFileList: path.join(patchDir, 'changedFileList.json'),
    patchAbcPath: path.join(patchDir, 'ets'),
    removeChangedFileListInSdk: 'true',
  };
}

/** Composes the full expectation from the two section builders above. */
function expectedConfig(
  projectRoot: string,
  moduleDir: string,
  productName: string
): BuildConfig {
  return {
    compileConfig: expectedCompileConfig(projectRoot, moduleDir, productName),
    patchConfig: expectedPatchConfig(moduleDir, productName),
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

describe('BuildConfigManager.generate', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-build-config-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the full buildConfig.json, creating the module tree on the way', () => {
    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);

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

    BuildConfigManager.generate(root, 'feature', 'default', toolProvider);

    const moduleDir = path.join(root, 'features', 'feature');
    const config = readConfig(moduleDir);
    expect(config).toEqual(expectedConfig(root, moduleDir, 'default'));
    expect(config.compileConfig.aceModuleRoot).toBe(
      path.join(moduleDir, 'src', 'main', 'ets')
    );
  });

  it('keeps every path relative to the requested product name', () => {
    BuildConfigManager.generate(root, 'entry', 'preview', toolProvider);

    const moduleDir = path.join(root, 'entry');
    const config = readConfig(moduleDir);
    expect(config).toEqual(expectedConfig(root, moduleDir, 'preview'));
    expect(config.patchConfig.changedFileList).toBe(
      path.join(
        moduleDir,
        'build',
        'preview',
        'intermediates',
        'patch',
        'preview',
        'changedFileList.json'
      )
    );
  });

  it('pre-creates the ets loader_out output directory', () => {
    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);

    const etsOutDir = path.join(
      root,
      'entry',
      'build',
      'default',
      'intermediates',
      'loader_out',
      'default',
      'ets'
    );
    expect(fs.statSync(etsOutDir).isDirectory()).toBe(true);
  });

  it('overwrites a stale buildConfig.json on regeneration', () => {
    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);
    const configPath = path.join(
      root,
      'entry',
      'build',
      'config',
      'buildConfig.json'
    );
    fs.writeFileSync(configPath, 'stale content', 'utf-8');

    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);

    const moduleDir = path.join(root, 'entry');
    expect(readConfig(moduleDir)).toEqual(
      expectedConfig(root, moduleDir, 'default')
    );
  });

  it('disables the hotfix symbol map for regular builds', () => {
    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);

    const { patchConfig } = readConfig(path.join(root, 'entry'));
    expect(patchConfig.enableMap).toBe('false');
    expect(patchConfig.mode).toBe('hotReload');
    expect(patchConfig.removeChangedFileListInSdk).toBe('true');
  });
});

describe('BuildConfigManager.remove', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-build-config-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('deletes an existing buildConfig.json', () => {
    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);
    const configPath = path.join(root, 'entry', 'build', 'config', 'buildConfig.json');
    expect(fs.existsSync(configPath)).toBe(true);

    BuildConfigManager.remove(root, 'entry');

    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('is a no-op when buildConfig.json is missing', () => {
    expect(() => BuildConfigManager.remove(root, 'entry')).not.toThrow();
  });

  it('resolves the module directory through the build profile srcPath', () => {
    fs.writeFileSync(
      path.join(root, 'build-profile.json5'),
      `{ "modules": [{ "name": "feature", "srcPath": "./features/feature" }] }`,
      'utf-8'
    );
    BuildConfigManager.generate(root, 'feature', 'default', toolProvider);
    const configPath = path.join(
      root, 'features', 'feature', 'build', 'config', 'buildConfig.json'
    );

    BuildConfigManager.remove(root, 'feature');

    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe('BuildConfigManager.removeAll', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-build-config-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes the buildConfig.json of every module in the profile', () => {
    fs.writeFileSync(
      path.join(root, 'build-profile.json5'),
      `{ "modules": [{ "name": "entry", "srcPath": "./entry" }, { "name": "feature", "srcPath": "./features/feature" }] }`,
      'utf-8'
    );
    BuildConfigManager.generate(root, 'entry', 'default', toolProvider);
    BuildConfigManager.generate(root, 'feature', 'default', toolProvider);

    const project = {
      rootDir: root,
      profile: {
        modules: [
          { name: 'entry', srcPath: './entry' },
          { name: 'feature', srcPath: './features/feature' },
        ],
      },
    } as unknown as Parameters<typeof BuildConfigManager.removeAll>[0];

    BuildConfigManager.removeAll(project);

    expect(fs.existsSync(path.join(root, 'entry', 'build', 'config', 'buildConfig.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'features', 'feature', 'build', 'config', 'buildConfig.json'))).toBe(false);
  });
});

describe('BuildConfigManager.withBuildConfig', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-build-config-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const configPath = (moduleName: string): string =>
    path.join(root, moduleName, 'build', 'config', 'buildConfig.json');

  it('exposes buildConfig.json during the action and removes it afterwards', async () => {
    let seenDuringAction = false;

    const result = await BuildConfigManager.withBuildConfig(
      root,
      ['entry'],
      'default',
      toolProvider,
      async () => {
        seenDuringAction = fs.existsSync(configPath('entry'));
        return 'built';
      }
    );

    expect(seenDuringAction).toBe(true);
    expect(result).toBe('built');
    expect(fs.existsSync(configPath('entry'))).toBe(false);
  });

  it('removes buildConfig.json even when the action fails', async () => {
    await expect(
      BuildConfigManager.withBuildConfig(
        root,
        ['entry'],
        'default',
        toolProvider,
        async () => {
          throw new Error('hqf build failed');
        }
      )
    ).rejects.toThrow('hqf build failed');

    expect(fs.existsSync(configPath('entry'))).toBe(false);
  });

  it('generates and removes the config for every module', async () => {
    await BuildConfigManager.withBuildConfig(
      root,
      ['entry', 'feature'],
      'default',
      toolProvider,
      async () => {
        expect(fs.existsSync(configPath('entry'))).toBe(true);
        expect(fs.existsSync(configPath('feature'))).toBe(true);
      }
    );

    expect(fs.existsSync(configPath('entry'))).toBe(false);
    expect(fs.existsSync(configPath('feature'))).toBe(false);
  });
});
