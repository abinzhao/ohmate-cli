/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const sourceRoot = path.join(repoRoot, '.plugin');
export const outputRoot = path.join(repoRoot, 'dist/plugin');
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const HOME_RELATIVE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/;

export async function loadPlatforms(
  file = path.join(sourceRoot, 'platforms.json')
) {
  const platforms = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('Plugin platform config must be a non-empty array.');
  }
  const seen = new Set();
  for (const item of platforms) {
    const { platform, hostName, manifestPath, manifest, runtime } = item;
    if (!/^[a-z0-9-]+$/.test(platform) || seen.has(platform)) {
      throw new Error(`Invalid or duplicate plugin platform: ${platform}`);
    }
    seen.add(platform);
    if (typeof hostName !== 'string' || !hostName.trim()) {
      throw new Error(`Missing host name for ${platform}.`);
    }
    // Manifests live in a dot directory so they cannot overwrite shared files.
    if (!/^\.[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(manifestPath)) {
      throw new Error(`Invalid manifest path for ${platform}: ${manifestPath}`);
    }
    if (
      manifest?.name !== 'deveco-cli' ||
      !VERSION_PATTERN.test(manifest.version)
    ) {
      throw new Error(`Invalid plugin manifest for ${platform}.`);
    }
    if (!/^[a-z0-9-]+$/.test(item.agentName ?? '')) {
      throw new Error(`Invalid devecocli agent name for ${platform}.`);
    }
    const { hostBinDirs, installRoot } = runtime ?? {};
    if (
      !Array.isArray(hostBinDirs) ||
      ![...hostBinDirs, installRoot].every(
        (dir) => typeof dir === 'string' && HOME_RELATIVE.test(dir)
      )
    ) {
      throw new Error(
        `Runtime paths for ${platform} must be relative to the user home directory.`
      );
    }
  }
  return platforms;
}

export function artifactPaths(
  { platform, manifest },
  root = path.join(outputRoot, platform)
) {
  return {
    target: path.join(root, manifest.name),
    zipPath: path.join(root, `${manifest.name}-${manifest.version}.zip`),
  };
}

export function templateVariables({ hostName, agentName, runtime }) {
  const home = (dir) => `\`~/${dir}\``;
  return {
    hostName,
    agentName,
    hostBinDirs: runtime.hostBinDirs.map(home).join(' → ') || '（未配置）',
    installRoot: home(runtime.installRoot),
  };
}

export function renderTemplate(text, variables) {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Unknown plugin template variable: ${name}`);
    }
    return variables[name];
  });
}
