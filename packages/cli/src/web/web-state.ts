/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { processIdentity } from '../runtime/process-tree.js';

export const serviceSchema = z.strictObject({
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), pid: z.number().int().positive(),
  identity: z.string().regex(/^[a-f0-9]{64}$/), controlSecret: z.string().regex(/^[a-f0-9]{64}$/),
  cwd: z.string(), projectRoot: z.string().nullable(), startedAt: z.iso.datetime(),
  debugSessionId: z.string().uuid().optional(),
  workbenchFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type WebServiceRecord = z.infer<typeof serviceSchema>;

async function directory(dataDir: string, create = false): Promise<string> {
  const root = join(dataDir, 'web');
  if (create) { await mkdir(root, { recursive: true, mode: 0o700 }); }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Unsafe web state directory'); }
  return root;
}
export async function readWebService(dataDir: string): Promise<WebServiceRecord | null> {
  try {
    const root = await directory(dataDir);
    const file = await open(join(root, 'service.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) { throw new Error('Unsafe web service record'); }
      const record = serviceSchema.parse(JSON.parse(await file.readFile('utf8')));
      return await processIdentity(record.pid) === record.identity ? record : null;
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error; }
}
export async function writeWebService(dataDir: string, record: WebServiceRecord): Promise<void> {
  const root = await directory(dataDir, true), temporary = join(root, `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(serviceSchema.parse(record))); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(root, 'service.json'));
  } finally { await rm(temporary, { force: true }); }
}
export async function clearWebService(dataDir: string, record: WebServiceRecord): Promise<void> {
  const current = await readWebService(dataDir);
  if (current?.pid === record.pid && current.identity === record.identity) {
    await rm(join(await directory(dataDir), 'service.json'), { force: true });
  }
}
