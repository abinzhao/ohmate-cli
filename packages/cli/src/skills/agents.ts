/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { cyan } from 'colorette';
import { SkillOperationResult, InstallationTargets } from '../types/skills.js';
import { resolvePath, resolveBundledSkillDir } from './skill-package.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import {
  getAgentNames,
  getAgentEntry,
  parseAgentNames,
  isAgentInstalled,
} from './agent-registry.js';
import { SkillInstaller } from './installation/skill-installer.js';
import { getCurrentVersion } from '../update/index.js';

const fsp = fs.promises;

/**
 * 规范化并去重 Agent 名称。
 * @throws 名称无效时抛出错误。
 */
export async function parseAgentList(
  agentOption: string | undefined
): Promise<string[]> {
  const names = parseAgentNames(agentOption);
  for (const name of names) {
    getAgentEntry(name);
  }
  return names;
}

export async function getAllExistingAgents(
  project?: string
): Promise<string[]> {
  return getAgentNames().filter((name) => isAgentInstalled(name, project));
}

/**
 * 将已有的全局 deveco-cli 安装迁移到包内 Skill。
 * @throws 任一路径迁移失败时抛出错误。
 */
export async function syncBundledSkillToExistingAgents(): Promise<void> {
  const sourceDir = resolveBundledSkillDir();
  await new SkillInstaller().migrateBundledSkill(sourceDir, {
    agents: getAgentNames(),
  });
}

/** 每个 CLI 版本执行一次全局 Skill 迁移，失败后在下次命令重试。 */
export async function migrateSkillSymlinkIfVersionChanged(): Promise<void> {
  try {
    const markerPath = path.join(
      getCliDataDir(),
      'skills',
      'migration-version'
    );
    const marker = await fsp
      .readFile(markerPath, 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return '';
        }
        throw error;
      });
    const version = getCurrentVersion();
    if (marker.trim() === version) {
      return;
    }
    await syncBundledSkillToExistingAgents();
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await fsp.writeFile(markerPath, version, 'utf8');
  } catch {
    // 迁移失败时继续执行当前命令。
  }
}

/**
 * 汇总并输出 skill 操作结果
 * 失败计数 > 0 时设置 process.exitCode = 1
 */
export function summarizeOperationResults(
  results: SkillOperationResult[]
): void {
  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.success).length;

  console.log();
  console.log(cyan('Finished:'));
  for (const result of results) {
    if (!result.path) {
      continue;
    }
    const reason =
      result.reason === 'already-exists'
        ? 'already exists; use --force to replace'
        : result.reason;
    const detail = result.fallbackReason
      ? ' (link failed: ' + result.fallbackReason + ')'
      : (reason ?? result.error)
        ? ' (' + (reason ?? result.error) + ')'
        : '';
    const status = !result.success
      ? 'failed'
      : result.skipped
        ? 'skipped'
        : (result.mode ??
          (result.reason === 'shared-entity-updated' ? 'updated' : 'removed'));
    console.log('  ' + status + ': ' + result.path + detail);
  }
  console.log(`  Success: ${successCount}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`  Failed: ${failedCount}`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

/**
 * 验证路径存在且是目录
 */
export function validateDirectoryPath(
  path: string,
  label: string,
  force?: boolean
): void {
  if (!fs.existsSync(path)) {
    if (force) {
      return;
    }
    throw new Error(`${label} "${path}" not found`);
  }
  if (!fs.statSync(path).isDirectory()) {
    throw new Error(`"${path}" is not a directory`);
  }
}

/**
 * 验证 --path 与 --project/--agent 互斥，并解析路径
 * @returns 解析后的路径（如果有）
 */
export function validatePathMutex(
  pathOpt: string | undefined,
  project: string | undefined,
  agent: string | undefined
): { resolvedPath: string | undefined; resolvedProject: string | undefined } {
  if (pathOpt && (project || agent)) {
    throw new Error('Cannot use `--path` with `--project` or `--agent`');
  }
  return {
    resolvedPath: pathOpt ? resolvePath(pathOpt) : undefined,
    resolvedProject: project ? resolvePath(project) : undefined,
  };
}

/**
 * 解析安装目标（agents、projectAgents、customPath）
 * @param options 包含 agent、project、path 的选项对象
 * @param resolvedPath 已解析的自定义路径
 * @param resolvedProject 已解析的项目路径
 * @returns 安装目标对象
 */
export async function resolveInstallationTargets(
  options: { agent?: string; project?: string; path?: string },
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<InstallationTargets> {
  if (resolvedPath) {
    return { agents: [], projectAgents: [], customPath: resolvedPath };
  }
  const names = options.agent
    ? await parseAgentList(options.agent)
    : await getAllExistingAgents(resolvedProject);
  if (!names.length) {
    throw new Error(
      'No agents found. Install an AI agent (cursor, opencode, etc.) or use `--path` for a custom location.'
    );
  }
  return resolvedProject
    ? {
        agents: [],
        explicitAgents: !!options.agent,
        projectAgents: names.map((agent) => ({
          project: resolvedProject,
          agent,
        })),
      }
    : { agents: names, projectAgents: [], explicitAgents: !!options.agent };
}
