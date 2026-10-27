/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SkillOperationResult } from '../../types/skills.js';

export async function lstatIfExists(destination: string) {
  try {
    return await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** 解析父目录的实际路径，不跟随目标条目的链接。 */
export async function resolveDirectoryEntry(
  destination: string
): Promise<string> {
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  try {
    return path.join(await fs.realpath(parent), path.basename(absolute));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
      parent === absolute
    ) {
      throw error;
    }
    return path.join(
      await resolveDirectoryEntry(parent),
      path.basename(absolute)
    );
  }
}

/** 用预先准备的目录条目替换目标，替换失败时恢复原条目。 */
export async function replaceDirectory(
  stage: string,
  destination: string
): Promise<void> {
  const backup = `${destination}.backup-${randomUUID()}`;
  const existed = await lstatIfExists(destination);
  if (existed) {
    await fs.rename(destination, backup);
  }
  try {
    await fs.rename(stage, destination);
  } catch (error) {
    if (existed) {
      await fs.rename(backup, destination);
    }
    throw error;
  }
  if (existed) {
    await fs.rm(backup, { recursive: true, force: true });
  }
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path
      .resolve(value)
      .replace(/^\\\\\?\\/, '')
      .replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

export function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative))
    );
  };
  return contains(left, right) || contains(right, left);
}

export async function installDirectory(
  sourceDir: string,
  destination: string,
  force = false
): Promise<SkillOperationResult> {
  const source = await fs.realpath(sourceDir);
  if (!(await fs.stat(source)).isDirectory()) {
    throw new Error(`Skill source is not a directory: ${sourceDir}`);
  }
  const entry = await resolveDirectoryEntry(destination);
  const existing = await lstatIfExists(entry);
  if (samePath(source, entry)) {
    return skipped(entry, 'same-source');
  }
  const resolved = existing
    ? await fs.realpath(entry).catch(() => entry)
    : entry;
  if (existing?.isSymbolicLink() && samePath(source, resolved)) {
    return skipped(entry, 'correct-link');
  }
  const preserved = await skipExisting(entry, force);
  if (preserved) {
    return preserved;
  }
  if (
    pathsOverlap(source, entry) ||
    (existing && pathsOverlap(source, resolved))
  ) {
    throw new Error(
      `Skill source and destination overlap: ${sourceDir}, ${destination}`
    );
  }
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const stage = `${entry}.install-${randomUUID()}`;
  try {
    const result = await prepareDirectory(source, stage);
    await replaceDirectory(stage, entry);
    return { success: true, path: entry, ...result };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function skipped(entry: string, reason: string): SkillOperationResult {
  return { success: true, skipped: true, path: entry, reason };
}

export async function skipExisting(
  entry: string,
  force: boolean
): Promise<SkillOperationResult | undefined> {
  if (!force && (await lstatIfExists(entry))) {
    return skipped(entry, 'already-exists');
  }
  return undefined;
}

async function prepareDirectory(
  source: string,
  stage: string
): Promise<Pick<SkillOperationResult, 'mode' | 'fallbackReason'>> {
  try {
    const target =
      process.platform === 'win32'
        ? source
        : path.relative(path.dirname(stage), source);
    await fs.symlink(
      target,
      stage,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    return { mode: 'symlink' };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.cp(source, stage, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
    return {
      mode: 'copy',
      fallbackReason: (error as NodeJS.ErrnoException).code ?? String(error),
    };
  }
}

export async function removeDirectory(
  destination: string
): Promise<SkillOperationResult> {
  const entry = await resolveDirectoryEntry(destination);
  const existing = await lstatIfExists(entry);
  if (!existing) {
    return skipped(entry, 'not-installed');
  }
  await fs.rm(entry, { recursive: !existing.isSymbolicLink(), force: true });
  return { success: true, path: entry };
}
