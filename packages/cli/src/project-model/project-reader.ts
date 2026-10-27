/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';

export const profileSchema = z.object({
  modules: z.array(z.object({
    name: z.string().min(1),
    srcPath: z.string().min(1),
    targets: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  })),
});
export const moduleSchema = z.object({
  module: z.object({ name: z.string(), type: z.string(), deviceTypes: z.array(z.string()).optional() }).passthrough(),
});

export interface ProjectModel {
  root: string;
  modules: { name: string; path: string; type: string; targets: string[]; deviceTypes: string[] }[];
  lockfile: string | null;
}

async function inside(root: string, file: string): Promise<string> {
  const resolved = await realpath(file);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`Project path escapes root: ${file}`);
  }
  return resolved;
}

async function readModule(root: string, entry: z.infer<typeof profileSchema>['modules'][number]) {
  const directory = await inside(root, join(root, entry.srcPath));
  const file = await inside(root, join(directory, 'src/main/module.json5'));
  const metadata = moduleSchema.parse(JSON5.parse(await readFile(file, 'utf8'))).module;
  return {
    name: entry.name, path: directory, type: metadata.type,
    targets: entry.targets?.map((target) => target.name) ?? [],
    deviceTypes: metadata.deviceTypes ?? [],
  };
}

export async function readProject(root: string): Promise<ProjectModel> {
  const canonical = await realpath(root);
  const profileFile = await inside(canonical, join(canonical, 'build-profile.json5'));
  const profile = profileSchema.parse(JSON5.parse(await readFile(profileFile, 'utf8')));
  const modules = await Promise.all(profile.modules.map((entry) => readModule(canonical, entry)));
  const lockfile = join(canonical, 'oh-package-lock.json5');
  const hasLock = await stat(lockfile).then((info) => info.isFile(), () => false);
  return { root: canonical, modules, lockfile: hasLock ? lockfile : null };
}
