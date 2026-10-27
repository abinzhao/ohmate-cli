/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { ExecutionContext, Risk, ToolSpec } from './types.js';

export class ResourceBusyError extends Error {}

export async function acquireExecutionLock(spec: ToolSpec, risk: Risk, context: ExecutionContext): Promise<() => Promise<void>> {
  const keys: string[] = [];
  if (risk !== 'R0') { keys.push(`workspace:${context.workspaceId}`); }
  if (spec.requirements.includes('device')) {
    keys.push(`device:${spec.adapter === 'legacy-child' ? 'legacy-fleet' : context.target.device ?? 'legacy-fleet'}`);
  }
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const key of keys.sort()) { releases.push(await acquireDataLock(context.dataDir, key)); }
  } catch (error) {
    await Promise.all(releases.map((release) => release()));
    throw error;
  }
  return async () => { for (const release of releases.reverse()) { await release(); } };
}

export async function acquireDataLock(dataDir: string, key: string): Promise<() => Promise<void>> {
  const root = join(dataDir, 'locks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Unsafe lock directory'); }
  const file = join(root, createHash('sha256').update(key).digest('hex'));
  const handle = await open(file, constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  await handle.close();
  try { return await lockfile.lock(file, { stale: 15_000, update: 5_000, retries: 0 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') { throw new ResourceBusyError(`Resource is busy: ${key}`); }
    throw error;
  }
}
