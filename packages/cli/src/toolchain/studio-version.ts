/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { debugLog } from '../utils/logger.js';

function plist(root: string, key: string): string | undefined {
  const file = path.join(root, 'Contents', 'Info.plist');
  if (!fs.existsSync(file)) {
    debugLog(`[ToolProvider] Info.plist not found at: ${file}`);
    return undefined;
  }
  for (const [command, args] of [
    ['/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file]],
    ['plutil', ['-extract', key, 'raw', '-o', '-', file]],
  ] as const) {
    try {
      const value = execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (value && !value.includes('Does Not Exist')) {
        return value;
      }
    } catch {
      // Try the next plist reader.
    }
  }
  return undefined;
}

function macStudioVersion(root: string): string | undefined {
  const short = plist(root, 'CFBundleShortVersionString');
  if (!short) {
    return plist(root, 'CFBundleVersion');
  }
  const prefix = short.split('.').slice(0, 3).join('');
  const builds = [
    plist(root, 'CFBundleVersion'),
    plist(root, 'CFBundleGetInfoString')?.match(/DS-[\d.]+/)?.[0],
  ];
  for (const build of builds) {
      const suffix = build
      ?.split('.')
      .at(-1)
      ?.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '');
    if (suffix && /^\d+$/.test(suffix)) {
      return `${short}.${suffix}`;
    }
  }
  return short;
}

export function readStudioVersion(root: string): string | undefined {
  if (os.platform() === 'darwin') {
    return macStudioVersion(root);
  }
  const product = path.join(root, 'product-info.json');
  try {
    const version = JSON.parse(fs.readFileSync(product, 'utf8')).version;
    return typeof version === 'string' && version.trim()
      ? version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
export { compareNumericVersions as compareStudioVersions } from '../utils/semver.js';
