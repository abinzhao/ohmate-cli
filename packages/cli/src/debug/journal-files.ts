/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { securityError } from '../debug-protocol/security-schemas.js';

export async function journalSessionDirectory(dataDir: string, sessionId: string, create: boolean): Promise<string> {
  z.string().uuid().parse(sessionId);
  const root = resolve(dataDir);
  if (await realpath(root) !== root) { throw securityError('JOURNAL_UNSAFE'); }
  let current = root;
  for (const segment of ['debug-events', sessionId]) {
    current = join(current, segment);
    if (create) { await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') { throw error; }
    }); }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw securityError('JOURNAL_UNSAFE');
    }
  }
  return current;
}
export async function journalDirectory(dataDir: string, sessionId: string, streamId: string, create: boolean): Promise<string> {
  z.string().uuid().parse(streamId);
  const directory = join(await journalSessionDirectory(dataDir, sessionId, create), streamId);
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') { throw error; }
    });
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw securityError('JOURNAL_UNSAFE');
  }
  return directory;
}
function regular(info: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number; size: number; mode: number }, budget: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > budget ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) { throw securityError('JOURNAL_UNSAFE'); }
}
export async function readJournalFile(file: string, budget: number): Promise<Buffer> {
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 5 * 1024 * 1024) { throw securityError('JOURNAL_UNSAFE'); }
  const before = await lstat(file);
  regular(before, budget);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    regular(opened, budget);
    if (before.ino !== opened.ino || before.dev !== opened.dev) { throw securityError('JOURNAL_UNSAFE'); }
    const result = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
      if (!bytesRead) { break; }
      offset += bytesRead;
    }
    const after = await handle.stat(), named = await lstat(file);
    regular(after, budget); regular(named, budget);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ino !== named.ino || after.dev !== named.dev) { throw securityError('JOURNAL_UNSAFE'); }
    return result.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function writeJournalFile(file: string, value: unknown): Promise<number> {
  const bytes = Buffer.from(JSON.stringify(value));
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncJournalDirectory(join(file, '..'));
  return bytes.length;
}
export async function removeJournalFile(file: string, expectedHash: string): Promise<void> {
  const bytes = await readJournalFile(file, 512 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) { throw securityError('JOURNAL_CORRUPT'); }
  await unlink(file);
  await syncJournalDirectory(join(file, '..'));
}
async function syncJournalDirectory(root: string): Promise<void> {
  if (process.platform === 'win32') { return; }
  const directory = await open(root, constants.O_RDONLY);
  try { await directory.sync(); }
  finally { await directory.close(); }
}
export async function writeJournalCheckpoint(root: string, value: unknown): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) { throw securityError('JOURNAL_LIMIT'); }
  const file = join(root, 'checkpoint.json'), temporary = join(root, `${randomUUID()}.tmp`);
  try {
    await writeJournalFile(temporary, value);
    try { regular(await lstat(file), 4096); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    await rename(temporary, file);
    await syncJournalDirectory(root);
  } finally { await rm(temporary, { force: true }); }
}
