/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { debugLog } from '../utils/logger.js';
import { compareStudioVersions, readStudioVersion } from './studio-version.js';

/** macOS .app bundle 中用于精确识别 DevEco Studio 的 product name */
const DEVECO_STUDIO_BUNDLE_NAME = 'DevEco Studio';

/** product-info.json 相对于 .app 根目录的相对路径各段 */
const PRODUCT_INFO_REL_PATH = ['Contents', 'Resources', 'product-info.json'] as const;

/** product-info.json 中标识产品名称的字段 */
const PRODUCT_INFO_NAME_KEY = 'name';

function directories(candidates: string[]): string[] {
  return candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 读取 <app>/Contents/Resources/product-info.json 的 name 字段。
 * @param appRoot - .app 包的根目录路径
 * @returns 产品名称，文件缺失或不可解析时返回 undefined
 */
function readProductName(appRoot: string): string | undefined {
  const file = path.join(appRoot, ...PRODUCT_INFO_REL_PATH);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const name = json[PRODUCT_INFO_NAME_KEY];
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按 product-info.json 的 name 精确识别是否为 DevEco Studio。
 * 目录名可被手动修改，不作判断依据。
 * @param appPath - .app 包的根目录路径
 * @returns 是否为 DevEco Studio
 */
function isDevEcoStudioApp(appPath: string): boolean {
  return readProductName(appPath) === DEVECO_STUDIO_BUNDLE_NAME;
}

function macCandidates(): string[] {
  const result: string[] = [];
  for (const directory of [
    path.join(os.homedir(), 'Applications'),
    '/Applications',
  ]) {
    try {
      result.push(
        ...fs
          .readdirSync(directory)
          .filter((entry) => entry.endsWith('.app'))
          .map((entry) => path.join(directory, entry))
          .filter(isDevEcoStudioApp)
      );
    } catch {
      // Application directory is optional.
    }
  }
  return result;
}

type RegistryEntry = {
  keys?: string[];
  values?: Record<string, { value: string }>;
};

async function registryList(keys: string[]): Promise<Record<string, RegistryEntry>> {
  // Loaded on demand so non-Windows startup does not pay for the registry client.
  const { default: regedit } = await import('regedit');
  return new Promise((resolve, reject) =>
    regedit.list(keys, (error, value) =>
      error ? reject(error) : resolve(value as Record<string, RegistryEntry>)
    )
  );
}

async function registryCandidates(
  root: string,
  includes: (key: string) => boolean,
  valueName: string
): Promise<string[]> {
  const parent = await registryList([root]);
  const keys = (parent[root]?.keys ?? [])
    .filter(includes)
    .map((key) => `${root}\\${key}`);
  if (keys.length === 0) {
    return [];
  }
  const entries = await registryList(keys);
  return keys.flatMap((key) => {
    const value = entries[key]?.values?.[valueName]?.value;
    return value ? [value] : [];
  });
}

async function windowsCandidates(): Promise<string[]> {
  const result = [path.join('C:', 'Program Files', 'Huawei', 'DevEco Studio')];
  for (const root of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    try {
      result.push(
        ...(await registryCandidates(
          root,
          (key) =>
            key
              .normalize('NFKC')
              .trim()
              .toLowerCase()
              .startsWith('deveco studio'),
          'InstallLocation'
        ))
      );
    } catch {
      // Registry keys are optional.
    }
  }
  for (const root of [
    'HKLM\\SOFTWARE\\Huawei\\DevEco Studio',
    'HKLM\\SOFTWARE\\WOW6432Node\\Huawei\\DevEco Studio',
  ]) {
    try {
      result.push(...(await registryCandidates(root, () => true, '')));
    } catch {
      // Registry keys are optional.
    }
  }
  return result;
}

export async function discoverStudioInstallRoot(): Promise<{
  root: string;
  version: string;
}> {
  const platform = os.platform();
  if (platform === 'linux') {
    throw new Error(
      'DevEco Studio is not available on Linux. Set DEVECO_CLI_CLT_PATH to a Command Line Tools installation.'
    );
  }
  const candidates =
    platform === 'darwin' ? macCandidates() : await windowsCandidates();
  const versioned = directories(candidates).flatMap((root) => {
    const version = readStudioVersion(root);
    if (!version) {
      debugLog(`[ToolProvider] Skipping ${root}: could not read version`);
      return [];
    }
    debugLog(`[ToolProvider] ${root} => version ${version}`);
    return [{ root, version }];
  });
  if (!versioned.length) {
    throw new Error(
      'DevEco Studio installation not found in default locations. Set DEVECO_CLI_STUDIO_PATH to a DevEco Studio installation, or set DEVECO_CLI_CLT_PATH to a Command Line Tools installation.'
    );
  }
  return versioned.reduce((best, current) =>
    compareStudioVersions(current.version, best.version) > 0 ? current : best
  );
}
