/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { assertPublicValue } from '../tasks/task-state.js';

const denied = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
function publicFile(path: string) {
  if (!path.endsWith('.json') || path.split(sep).some((part) => denied.test(part))) {
    throw new Error('Input file must be a public JSON file');
  }
}
export async function readInputFile(path: string, cwd: string, dataDir: string): Promise<unknown> {
  const file = resolve(cwd, path);
  publicFile(file);
  const canonical = await realpath(file);
  publicFile(canonical);
  if (canonical !== file || canonical === dataDir || canonical.startsWith(`${dataDir}${sep}`)) {
    throw new Error('Input file must not use symlinks or product state');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) { throw new Error('Input file is unsupported or exceeds 1 MiB'); }
    const bytes = await handle.readFile(), current = await lstat(file);
    if (bytes.length > 1024 * 1024 || current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1) {
      throw new Error('Input file changed while reading');
    }
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertPublicValue(input);
    return input;
  } finally { await handle.close(); }
}
