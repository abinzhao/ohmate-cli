/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSON5 from 'json5';
import { readProject } from '../project-model/index.js';

export async function writeProjectBaseline(root: string, appName: string): Promise<void> {
  const project = await readProject(root);
  const read = async (path: string) => JSON5.parse(await readFile(join(root, path), 'utf8'));
  const app = (await read('AppScope/app.json5')).app;
  const profile = await read('build-profile.json5');
  const module = (await read('entry/src/main/module.json5')).module;
  const dependencies = await read('oh-package.json5');
  const pages = await read('entry/src/main/resources/base/profile/main_pages.json');
  const text = `# ${appName}

Generated baseline from the bundled DevEco application template and current JSON5 configuration.
Product requirements, target users and performance budgets: 待确认.

- Bundle: ${app.bundleName}; Stage UIAbility: ${module.mainElement}.
- Root markers: build-profile.json5, oh-package.json5, hvigorfile.ts, AppScope/app.json5.
- Products/API: ${JSON.stringify(profile.app.products.map((item: Record<string, unknown>) => ({
    name: item.name, compatibleSdkVersion: item.compatibleSdkVersion, targetSdkVersion: item.targetSdkVersion, runtimeOS: item.runtimeOS,
  })))}. Compile API uses the product toolchain; not independently verified.
- Modules/targets/devices: ${JSON.stringify(project.modules.map((item) => ({ ...item, path: relative(root, item.path) })))}.
- Entry routes: entry/src/main/resources/base/profile/main_pages.json → ${JSON.stringify(pages.src)}.
- Abilities/extensions: ${JSON.stringify({ abilities: module.abilities.map((item: Record<string, unknown>) => ({
    name: item.name, srcEntry: item.srcEntry, exported: item.exported,
  })), extensions: module.extensionAbilities })}.
- Root dependency declarations: ${JSON.stringify(dependencies)}. Lockfile: not generated; no install performed.
- Layout is the template's entry module. products/features/common and VersionFile are not present.
- UI is the template ArkUI page; custom HDS/navigation, theme, material, window/safe area and large-font strategy: 待确认.
- Resource directories: base and entry/src/main/resources/dark. Additional languages, timezone, RTL and accessibility acceptance: 待确认.
- State, storage, network, Mock, cache, account isolation and cloud integration: no additional configuration generated.
- Permissions: ${JSON.stringify(module.requestPermissions ?? [])}; no signing credentials generated.
- ArkGuard: entry/obfuscation-rules.txt and entry/build-profile.json5; release obfuscation and symbol retention require review.
- Additional dependencies, permissions, migrations, signing, device changes, deployment and publishing require explicit approval.
- Verify from this root: ohmatecli doctor; ohmatecli project inspect; ohmatecli build --help; ohmatecli check --help.
- Build/test/run/device/UI/performance acceptance: not run. Resolve actual targets and official task help before execution.
`;
  await writeFile(join(root, 'AGENTS.md'), text, { flag: 'wx' });
}
