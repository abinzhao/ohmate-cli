/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { evidenceFile } from './evidence.js';
import { readEvidenceText } from './source-scope.js';

interface InstalledComponent {
  path: string; sha256: string; size: number; version: string | null; name?: string; executionObserved: false;
}
const metadataSchema = z.object({ name: z.string().min(1).max(200), version: z.string().min(1).max(200) });
function componentPaths(sdk: string) {
  const loader = join(sdk, 'default/openharmony/ets/build-tools/ets-loader');
  const platform = process.platform === 'darwin' ? 'build-mac' : process.platform === 'win32' ? 'build-win' : 'build';
  return {
    etsMetadata: join(sdk, 'default/openharmony/ets/oh-uni-package.json'),
    loaderPackage: join(loader, 'package.json'), loaderPlugin: join(loader, 'compile_plugin.js'), loaderMain: join(loader, 'main.js'),
    arkConfig: join(loader, 'lib/fast_build/ark_compiler/common/process_ark_config.js'), arkUtils: join(loader, 'lib/ark_utils.js'),
    typescriptPackage: join(loader, 'node_modules/typescript/package.json'),
    typescript: join(loader, 'node_modules/typescript/lib/typescript.js'),
    arkguardPackage: join(loader, 'node_modules/arkguard/package.json'),
    arkguard: join(loader, 'node_modules/arkguard/lib/ArkObfuscator.js'),
    arkguardConfig: join(loader, 'node_modules/arkguard/lib/initialization/ConfigResolver.js'),
    es2abc: join(loader, 'bin/ark', platform, 'bin', `es2abc${process.platform === 'win32' ? '.exe' : ''}`),
  };
}
export async function installedCompilerIdentity(sdkPath: string) {
  const components: Record<string, InstalledComponent> = {}, missing: string[] = [];
  if (await realpath(sdkPath).catch(() => null) !== resolve(sdkPath)) {
    return { sdkPath, scope: 'installed-default-candidates', components, missing: ['unsafe-sdk-root'] };
  }
  for (const [key, path] of Object.entries(componentPaths(sdkPath))) {
    try {
      const document = key.endsWith('Package') ? await readEvidenceText(sdkPath, path, 64 * 1024) : null;
      const evidence = document?.evidence ?? await evidenceFile(sdkPath, path);
      const metadata = document ? metadataSchema.parse(JSON.parse(document.text)) : null;
      components[key] = { path, sha256: evidence.sha256, size: evidence.size, version: metadata?.version ?? null,
        ...(metadata ? { name: metadata.name } : {}), executionObserved: false };
    } catch { missing.push(key); }
  }
  return { sdkPath, scope: 'installed-default-candidates', components, missing };
}
export async function compilerIdentityDrift(identity: Awaited<ReturnType<typeof installedCompilerIdentity>>): Promise<string[]> {
  const current = await installedCompilerIdentity(identity.sdkPath);
  if (current.missing.includes('unsafe-sdk-root')) { return ['unsafe-sdk-root']; }
  return [...new Set([...Object.keys(identity.components), ...Object.keys(current.components)])]
    .filter((name) => identity.components[name]?.sha256 !== current.components[name]?.sha256).sort();
}
