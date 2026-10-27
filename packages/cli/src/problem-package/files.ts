/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExecutionContext } from '../runtime/types.js';
import { PROBLEM_LIMITS } from './zip.js';

export async function withProblemFile<T>(path: string, budget: number,
  consume: (handle: FileHandle, size: number) => Promise<T>): Promise<T> {
  const before = await lstat(path);
  const regular = (info: typeof before) => {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > budget) {
      throw new Error('PROBLEM_FILE_UNSAFE');
    }
  };
  regular(before);
  if (await realpath(path) !== resolve(path)) { throw new Error('PROBLEM_FILE_UNSAFE'); }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat(); regular(opened);
    if (before.ino !== opened.ino || before.dev !== opened.dev) { throw new Error('PROBLEM_FILE_CHANGED'); }
    const result = await consume(handle, opened.size);
    const after = await handle.stat(), named = await lstat(path); regular(after); regular(named);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs || named.ino !== opened.ino || named.dev !== opened.dev) {
      throw new Error('PROBLEM_FILE_CHANGED');
    }
    return result;
  } finally { await handle.close(); }
}
export async function readProblemRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled);
    if (!bytesRead) { throw new Error('PROBLEM_FILE_CHANGED'); }
    filled += bytesRead;
  }
  return bytes;
}
export async function readProblemFile(path: string, budget = PROBLEM_LIMITS.maxArchiveBytes): Promise<Buffer> {
  return withProblemFile(path, budget, (handle, size) => readProblemRange(handle, 0, size));
}
export async function writeProblemFile(context: ExecutionContext, problemId: string, bytes: Buffer): Promise<string> {
  const root = resolve(context.dataDir);
  if (await realpath(root) !== root) { throw new Error('PROBLEM_ARTIFACT_UNSAFE'); }
  const base = join(root, 'problem-packages');
  await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') { throw error; }
  });
  const info = await lstat(base);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) {
    throw new Error('PROBLEM_ARTIFACT_UNSAFE');
  }
  const parent = await mkdtemp(join(base, 'export-')), path = join(parent, `${problemId}.ohmate-problem.zip`);
  let complete = false;
  try {
    context.abortSignal.throwIfAborted();
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    context.abortSignal.throwIfAborted();
    if (process.platform !== 'win32') {
      const directory = await open(parent, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    complete = true;
    return path;
  } finally { if (!complete) { await rm(parent, { recursive: true, force: true }); } }
}
