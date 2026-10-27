/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { publicPath } from '../workspace/path-guard.js';
import type { ExecutionContext } from '../runtime/types.js';

export async function createTarget(path: string, context: ExecutionContext) {
  const root = await realpath(context.projectRoot ?? context.cwd), target = resolve(root, path);
  const name = relative(root, target).split(sep).join('/');
  publicPath(name);
  const privateRoot = resolve(context.dataDir);
  if (target === privateRoot || target.startsWith(`${privateRoot}${sep}`)) { throw new Error('Project creation cannot target private product state'); }
  let current = root;
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Creation requires existing real parent directories'); }
  }
  const state = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
  });
  if (state && (!state.isDirectory() || state.isSymbolicLink() || (await readdir(target)).length)) { throw new Error('Project target is not an empty real directory'); }
  return { target, name, identity: state ? `${state.dev}:${state.ino}:${state.mode}` : null };
}
