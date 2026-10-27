/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { open, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { redactTaskValue } from '../tasks/task-redaction.js';

const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|credentials.*|.*\.(?:pem|key|p12|pfx|cer|crt|keystore))$/i;
const excluded = new Set(['node_modules', '.git', 'dist', 'build', 'artifacts', 'state']);
export interface Material { path: string; source: 'file' | 'rule'; sha256: string; bytes: number; redacted: boolean; text: string }
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export async function readMaterial(root: string, name: string, source: Material['source'], dataDir?: string): Promise<Material> {
  const lexical = relative(root, resolve(root, name));
  if (!lexical || lexical.startsWith(`..${sep}`) || lexical === '..' || lexical.split(sep).some((part) => sensitive.test(part) || excluded.has(part))) {
    throw new Error('Context path is outside scope or sensitive');
  }
  const file = await realpath(resolve(root, name)), canonical = relative(root, file);
  if (dataDir) {
    const privateRoot = await realpath(dataDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return resolve(dataDir); } throw error;
    });
    if (file === privateRoot || file.startsWith(`${privateRoot}${sep}`)) { throw new Error('Product state is not sendable context'); }
  }
  if (canonical.startsWith(`..${sep}`) || canonical === '..' || canonical.split(sep).some((part) => sensitive.test(part) || excluded.has(part))) {
    throw new Error('Context file resolves outside its permitted scope');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > 128 * 1024) { throw new Error('Context file is unsupported or exceeds 128 KiB'); }
    const data = await handle.readFile();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) { throw new Error('Binary context is not supported'); }
    const safe = redactTaskValue(text) as string;
    return { path: lexical, source, sha256: sha256(data), bytes: data.length, redacted: safe !== text, text: safe };
  } finally { await handle.close(); }
}

export async function applicableRules(root: string, files: string[], dataDir?: string): Promise<Material[]> {
  const names = new Set(['AGENTS.md']);
  for (const file of files) {
    let directory = dirname(resolve(root, file));
    while (directory !== root && directory.startsWith(`${root}${sep}`)) {
      names.add(relative(root, join(directory, 'AGENTS.md'))); directory = dirname(directory);
    }
  }
  try {
    for (const file of await readdir(join(root, '.ohmate', 'rules'))) {
      if (file.endsWith('.md')) { names.add(join('.ohmate', 'rules', file)); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
  const rules: Material[] = [];
  for (const name of [...names].sort()) {
    try { rules.push(await readMaterial(root, name, 'rule', dataDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
  }
  return rules;
}
