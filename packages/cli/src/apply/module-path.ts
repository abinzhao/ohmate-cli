/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { debugLog } from '../utils/logger.js';

/** 读取 build-profile.json5 找模块 srcPath（去 ./ 前缀），找不到返回 null */
function findModuleSrcPath(profilePath: string, moduleName: string): string | null {
  try {
    const profile = json5.parse(fs.readFileSync(profilePath, 'utf-8')) as {
      modules?: Array<{ name: string; srcPath: string }>;
    };
    const node = profile.modules?.find((m) => m.name === moduleName);
    return node?.srcPath ? node.srcPath.replace(/^\.\//, '') : null;
  } catch (e) {
    debugLog(`[apply] resolveModuleSrcPath fallback (module=${moduleName}): ${(e as Error).message}`);
    return null;
  }
}

/** 从 build-profile.json5 解析模块 srcPath（去 ./ 前缀），找不到则回退 moduleName */
export function resolveModuleSrcPath(projectRoot: string, moduleName: string): string {
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(profilePath)) {
    return moduleName;
  }
  return findModuleSrcPath(profilePath, moduleName) ?? moduleName;
}
