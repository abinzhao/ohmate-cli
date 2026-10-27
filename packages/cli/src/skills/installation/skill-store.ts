/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lock } from 'proper-lockfile';
import type { SkillOperationResult } from '../../types/skills.js';
import { getCliDataDir } from '../../utils/cli-data-dir.js';
import { extractSkill } from '../skill-package.js';
import { assertSafeSkillName } from '../skill-name.js';
import {
  lstatIfExists,
  replaceDirectory,
  resolveDirectoryEntry,
  samePath,
  pathsOverlap,
  skipped,
  skipExisting,
} from './directory-installation.js';
import type { SkillDestination } from './agent-paths.js';

function storageRoot(project?: string): string {
  return project
    ? path.join(project, '.deveco-cli', 'skills')
    : path.join(getCliDataDir(), 'skills');
}

export function getSkillStoreEntry(name: string, project?: string): string {
  assertSafeSkillName(name);
  return path.join(storageRoot(project), 'store', name);
}

async function resolveStoragePath(
  destination: string,
  project?: string
): Promise<string> {
  const basePath = project ?? getCliDataDir();
  const base = await fs
    .realpath(basePath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return resolveDirectoryEntry(basePath);
      }
      throw error;
    });
  const expected = path.join(base, path.relative(basePath, destination));
  const entry = await resolveDirectoryEntry(expected);
  if (!samePath(expected, entry)) {
    throw new Error(
      `Skill storage parent redirects outside its managed location: ${expected}`
    );
  }
  return entry;
}

export async function resolveSkillStoreEntry(
  name: string,
  project?: string
): Promise<string> {
  return resolveStoragePath(getSkillStoreEntry(name, project), project);
}

/** 同一范围、同名 Skill 的安装与删除共用跨进程锁。 */
export async function withSkillLock<T>(
  name: string,
  scope: { project?: string; customPath?: string },
  action: () => Promise<T>
): Promise<T> {
  assertSafeSkillName(name);
  const root = scope.customPath ?? storageRoot(scope.project);
  const lockPath = scope.customPath
    ? await resolveDirectoryEntry(path.join(root, `.${name}.lock`))
    : await resolveStoragePath(
        path.join(root, 'locks', `${name}.lock`),
        scope.project
      );
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const release = await lock(root, {
    realpath: false,
    lockfilePath: lockPath,
    stale: 30000,
    update: 10000,
    retries: { retries: 100, minTimeout: 50, maxTimeout: 200 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

/** 校验实体目录；不将外部链接当作受管理的 archive 实体。 */
async function assertStoredSkill(entry: string): Promise<void> {
  const stats = await fs.lstat(entry);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !(await fs.stat(path.join(entry, 'SKILL.md'))).isFile()
  ) {
    throw new Error(`Invalid Skill store: ${entry}`);
  }
}

/** 有效实体默认复用；显式 force 才发布下载的新内容。 */
export async function prepareStoredSkill(
  name: string,
  buffer: Buffer,
  project: string | undefined,
  destinations: readonly SkillDestination[],
  force: boolean
): Promise<{ source?: string; results: SkillOperationResult[] }> {
  const entry = await resolveSkillStoreEntry(name, project);
  const existing = await lstatIfExists(entry);
  if (!force && !existing) {
    const entries = await Promise.all(
      destinations.map((d) => lstatIfExists(d.path))
    );
    if (entries.every(Boolean)) {
      return {
        results: destinations.map((d) => skipped(d.path, 'already-exists')),
      };
    }
  }
  for (const destination of destinations) {
    for (const target of [destination.path, ...destination.legacy]) {
      if (pathsOverlap(entry, target)) {
        throw new Error(
          `Skill store and destination overlap: ${entry}, ${target}`
        );
      }
    }
  }
  if (!force && existing) {
    try {
      await assertStoredSkill(entry);
    } catch (error) {
      throw new Error(
        `Cannot reuse Skill store ${entry}; use --force to replace: ${(error as Error).message}`,
        { cause: error }
      );
    }
    return { source: entry, results: [] };
  }
  return {
    source: entry,
    results: [await publishArchive(name, buffer, entry)],
  };
}

export async function installCustomArchive(
  name: string,
  buffer: Buffer,
  destination: string,
  force: boolean
): Promise<SkillOperationResult> {
  const entry = await resolveDirectoryEntry(destination);
  const preserved = await skipExisting(entry, force);
  return preserved ?? publishArchive(name, buffer, entry);
}

async function publishArchive(
  name: string,
  buffer: Buffer,
  entry: string
): Promise<SkillOperationResult> {
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const stageRoot = `${entry}.extract-${randomUUID()}`;
  try {
    await extractSkill(buffer, stageRoot, name);
    const stage = path.join(stageRoot, name);
    await assertStoredSkill(stage);
    await replaceDirectory(stage, entry);
    return { success: true, path: entry, reason: 'shared-entity-updated' };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}
