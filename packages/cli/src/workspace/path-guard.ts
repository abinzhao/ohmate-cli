/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { InputInvalidError } from '../runtime/types.js';

const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
const excluded = new Set(['node_modules', '.git', '.hvigor', '.ohpm', 'build', 'dist', 'artifacts', 'state']);
function inside(root: string, path: string) { return path === root || path.startsWith(`${root}${sep}`); }

export function publicPath(name: string): string {
  const parts = name.split('/');
  if (isAbsolute(name) || /[\\:]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    parts.some((part) => !part || part === '.' || part === '..' || sensitive.test(part) || excluded.has(part))) {
    throw new InputInvalidError('Patch path is outside scope or sensitive');
  }
  return name;
}

export async function patchPath(root: string, name: string, dataDir: string): Promise<string> {
  publicPath(name);
  const canonicalRoot = await realpath(root), file = join(canonicalRoot, ...name.split('/'));
  const privateRoot = await realpath(dataDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return resolve(dataDir); } throw error;
  });
  if (inside(privateRoot, file)) { throw new InputInvalidError('Product state is outside patch scope'); }
  const parts = relative(canonicalRoot, file).split(sep);
  let current = canonicalRoot;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = await lstat(current).catch((error) => {
      if (index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
    });
    if (!info) { break; }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) {
      throw new InputInvalidError('Patch targets must be regular unlinked files with existing real parent directories');
    }
  }
  return file;
}
