/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExecutionContext } from '../runtime/types.js';
import { digest, evidenceFile } from './evidence.js';

async function notify(context: ExecutionContext, type: string, path: string, heldPath: string) {
  await context.eventSink({ taskId: context.taskId ?? '', sequence: 0, time: new Date().toISOString(),
    type, payload: { path, heldPath } });
}
async function unlinkIfPresent(file: string) {
  await unlink(file).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } });
}
async function displace(context: ExecutionContext, path: string, expected: string, action: (file: string) => Promise<void>) {
  const root = context.projectRoot ?? context.cwd, file = join(root, path);
  const held = `${file}.ohmate-${randomUUID()}.held`, heldPath = relative(root, held).split('\\').join('/');
  if ((await evidenceFile(root, file)).sha256 !== expected) { throw new Error('Build file changed before transaction'); }
  await notify(context, 'build.file.before-displace', path, heldPath);
  await rename(file, held);
  try {
    await notify(context, 'build.file.displaced', path, heldPath);
    if ((await evidenceFile(root, held)).sha256 !== expected) { throw new Error('Build file changed before displacement'); }
    await action(file);
    if ((await evidenceFile(root, held)).sha256 !== expected) { throw new Error('An open writer changed the displaced build file'); }
    await unlink(held);
  } catch (error) {
    try {
      // Exclusive publication preserves a concurrently created destination.
      await link(held, file); await unlink(held);
    } catch {
      throw new Error(`Build file conflict; displaced bytes retained at ${heldPath}`, { cause: error });
    }
    throw error;
  }
}
export async function replaceBuildFile(context: ExecutionContext, path: string, text: string, expected: string, mode: number) {
  const root = context.projectRoot ?? context.cwd, temporary = `${join(root, path)}.ohmate-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    await displace(context, path, expected, async (file) => {
      await link(temporary, file); await unlink(temporary);
      if ((await evidenceFile(root, file)).sha256 !== digest(text)) { throw new Error('Build file publication changed'); }
    });
  } finally { await unlinkIfPresent(temporary); }
}
export async function removeBuildFile(context: ExecutionContext, path: string, expected: string) {
  await displace(context, path, expected, async (file) => {
    const current = await lstat(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error;
    });
    if (current) { throw new Error('A subsequent build cache was created'); }
  });
}
export async function publishBuildFile(context: ExecutionContext, path: string, text: string, mode: number) {
  const root = context.projectRoot ?? context.cwd, file = join(root, path);
  if (await realpath(dirname(file)) !== dirname(file)) { throw new Error('Unsafe build file parent'); }
  const temporary = `${file}.ohmate-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, file); await unlink(temporary);
    if ((await evidenceFile(root, file)).sha256 !== digest(text)) { throw new Error('Build file publication changed'); }
  } finally { await unlinkIfPresent(temporary); }
}
