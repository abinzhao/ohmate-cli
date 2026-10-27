/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const ignored = new Set(['node_modules', '.git', '.hvigor', '.ohpm', 'build', 'dist', 'artifacts', '.DS_Store']);
const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;

export async function workspaceFingerprint(root: string, dataDir: string): Promise<string> {
  const hash = createHash('sha256');
  const pending = [root];
  let count = 0, bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => !ignored.has(entry.name) && !sensitive.test(entry.name) && resolve(directory, entry.name) !== resolve(dataDir))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let index = 0; index < entries.length; index += 4) {
      const group = entries.slice(index, index + 4);
      if ((count += group.length) > 10_000) { throw new Error('Workspace fingerprint exceeds 10000 entries'); }
      // Retain the scan owner until all sibling reads and closes settle, even on failure.
      const results = await Promise.allSettled(group.map(async entry => {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) { return null; }
        if (entry.isSymbolicLink()) { return `symlink:${await readlink(file)}`; }
        if (!entry.isFile()) { throw new Error('Workspace contains an unsupported file type'); }
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const size = (await handle.stat()).size;
          if (size > 8 * 1024 * 1024 || (bytes += size) > 64 * 1024 * 1024) {
            throw new Error('Workspace fingerprint exceeds the content limit');
          }
          return await handle.readFile();
        } finally { await handle.close(); }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') { throw failed.reason; }
      for (let offset = 0; offset < group.length; offset++) {
        const file = join(directory, group[offset].name), result = results[offset];
        if (result.status !== 'fulfilled') { throw result.reason; }
        hash.update(`${relative(root, file)}\0`);
        if (result.value === null) { pending.push(file); }
        else if (typeof result.value === 'string') { hash.update(result.value); }
        else { hash.update(result.value); hash.update('\0'); }
      }
    }
  }
  return hash.digest('hex');
}
