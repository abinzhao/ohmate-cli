/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../agent/context-files.js';
import { assertPublicValue } from '../tasks/task-state.js';
import { unifiedDiff } from '../workspace/patch-review.js';

export async function templateFiles(root: string) {
  const output: { path: string; sha256: string; bytes: number; format: string; diff?: string;
    operation: 'create'; oldHash: null; newHash: string }[] = [];
  const directories = [''];
  let bytes = 0;
  while (directories.length) {
    const dir = directories.pop()!;
    for (const name of (await readdir(join(root, dir))).sort()) {
      const path = dir ? `${dir}/${name}` : name, file = join(root, path), info = await lstat(file);
      if (info.isSymbolicLink()) { throw new Error('Template cannot contain symlinks'); }
      if (info.isDirectory()) { directories.push(path); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) { throw new Error('Unsupported template file'); }
      const content = await readFile(file);
      const identity = { path, sha256: sha256(content), bytes: content.length,
        operation: 'create' as const, oldHash: null, newHash: sha256(content) };
      bytes += content.length;
      if (bytes > 512 * 1024 || output.length >= 100) { throw new Error('Template exceeds review budget'); }
      if (path.endsWith('.png')) {
        output.push({ ...identity,
          format: content.length >= 24 && content.readUInt32BE(16) === 1 && content.readUInt32BE(20) === 1 ? 'fallback-icon' : 'image/png' });
        continue;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      assertPublicValue(text);
      output.push({ ...identity, format: 'text', diff: unifiedDiff(path, null, text) });
    }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
