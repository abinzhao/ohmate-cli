/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { debugLog } from '../../utils/logger.js';

export interface PatchConfig {
  app: {
    bundleName: string;
    patchVersionCode: number;
    versionCode: number;
  };
  module: {
    name: string;
    type: string;
  };
}

interface AppConfig {
  bundleName: string;
  versionCode: number;
}

const DEFAULT_PATCH_VERSION_CODE = 2000000;
const DEFAULT_VERSION_CODE = 1000000;
const MODULE_TYPE_HOTRELOAD = 'hotreload';

export class PatchManager {
  public static generateOrUpdate(
    projectRoot: string,
    moduleSrcPath: string,
    moduleName: string
  ): PatchConfig {
    const appConfig = PatchManager.readAppConfig(projectRoot);

    const moduleRoot = path.resolve(projectRoot, moduleSrcPath);
    const patchJsonPath = path.join(moduleRoot, 'patch.json');

    let patchConfig: PatchConfig;

    if (fs.existsSync(patchJsonPath)) {
      debugLog(
        `[PatchManager] patch.json found at ${patchJsonPath}, incrementing patchVersionCode`
      );
      patchConfig = PatchManager.readExistingPatch(patchJsonPath);
      patchConfig.app.patchVersionCode += 1;
    } else {
      debugLog(`[PatchManager] patch.json not found, generating new one at ${patchJsonPath}`);
      patchConfig = {
        app: {
          bundleName: appConfig.bundleName,
          patchVersionCode: DEFAULT_PATCH_VERSION_CODE,
          versionCode: appConfig.versionCode,
        },
        module: {
          name: moduleName,
          type: MODULE_TYPE_HOTRELOAD,
        },
      };
    }

    PatchManager.writePatchJson(patchJsonPath, patchConfig);

    return patchConfig;
  }

  private static readAppConfig(projectRoot: string): AppConfig {
    const appJson5Path = path.join(projectRoot, 'AppScope', 'app.json5');

    if (!fs.existsSync(appJson5Path)) {
      throw new Error(
        `AppScope/app.json5 not found at ${appJson5Path}. Unable to read bundleName and versionCode.`
      );
    }

    const content = fs.readFileSync(appJson5Path, 'utf-8');
    const json = json5.parse(content) as {
      app?: { bundleName?: string; versionCode?: number };
    };

    const bundleName = json?.app?.bundleName;
    if (!bundleName) {
      throw new Error('bundleName is missing in AppScope/app.json5');
    }

    const versionCode = json?.app?.versionCode ?? DEFAULT_VERSION_CODE;

    return { bundleName, versionCode };
  }

  private static readExistingPatch(patchJsonPath: string): PatchConfig {
    const content = fs.readFileSync(patchJsonPath, 'utf-8');
    const parsed = JSON.parse(content) as PatchConfig;

    if (!parsed?.app?.patchVersionCode) {
      throw new Error(
        `Invalid patch.json at ${patchJsonPath}: missing app.patchVersionCode`
      );
    }

    return parsed;
  }

  private static writePatchJson(patchJsonPath: string, config: PatchConfig): void {
    const dir = path.dirname(patchJsonPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const jsonStr = JSON.stringify(config, null, 2);
    fs.writeFileSync(patchJsonPath, jsonStr, 'utf-8');

    debugLog(`[PatchManager] patch.json written to ${patchJsonPath}`);
    debugLog(`[PatchManager] Content: ${jsonStr}`);
  }
}
