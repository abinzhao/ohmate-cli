/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { publicPath } from '../workspace/path-guard.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';

export const workspaceTreeSchema = z.strictObject({
  projectRoot: z.string().nullable().default(null),
  path: z.string().max(1024).default(''),
  limit: z.number().int().min(1).max(200).default(100),
});
const generatedDirectories = new Set(['.cache', 'coverage', 'hvigor', 'oh_modules']);

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function directory(context: ExecutionContext, name: string): Promise<{ root: string; path: string; privateRoot: string }> {
  if (name) { publicPath(name); }
  const root = await realpath(context.projectRoot ?? context.cwd);
  const path = name ? join(root, ...name.split('/')) : root;
  const privateRoot = await realpath(context.dataDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return resolve(context.dataDir); }
    throw error;
  });
  if (!inside(root, path) || inside(privateRoot, path)) { throw new InputInvalidError('Workspace path is outside public scope'); }
  let current = root;
  for (const part of name ? name.split('/') : []) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new InputInvalidError('Workspace tree paths must be real directories');
    }
  }
  return { root, path, privateRoot };
}

/** Lists names and bounded metadata only; file contents still require the existing context review. */
export async function listWorkspaceTree(context: ExecutionContext, name: string, limit: number) {
  const selected = await directory(context, name), entries: {
    name: string; path: string; type: 'directory' | 'file'; bytes?: number;
  }[] = [];
  const handle = await opendir(selected.path);
  try {
    for await (const entry of handle) {
      context.abortSignal.throwIfAborted();
      const path = name ? `${name}/${entry.name}` : entry.name;
      if (path.split('/').some((part) => generatedDirectories.has(part))) { continue; }
      try { publicPath(path); } catch { continue; }
      const absolute = join(selected.root, ...path.split('/'));
      if (inside(selected.privateRoot, absolute)) { continue; }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { continue; }
      if (info.isDirectory()) { entries.push({ name: entry.name, path, type: 'directory' }); }
      else if (info.isFile() && info.nlink === 1 && Number.isSafeInteger(info.size)) {
        entries.push({ name: entry.name, path, type: 'file', bytes: info.size });
      }
      if (entries.length > limit) { break; }
    }
  } finally {
    await handle.close().catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') { throw error; }
    });
  }
  entries.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) :
    left.type === 'directory' ? -1 : 1);
  return { path: name, entries: entries.slice(0, limit), truncated: entries.length > limit, limit };
}
