/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import { green, red, cyan, yellow, dim } from 'colorette';
import pLimit from 'p-limit';
import { SpinnerHelper } from '../utils/spinner-helper.js';
import {
  fetchTagIds,
  fetchAllSkills,
  searchSkills,
  getInstalledAgents,
  downloadSkill,
  SkillInstaller,
  summarizeOperationResults,
  validatePathMutex,
  validateDirectoryPath,
  resolveInstallationTargets,
  getAgentNames,
} from '../skills/index.js';
import { isDevecoCodeAuth } from '../auth/utils/token-storage.js';
import {
  AddOptions,
  RemoveOptions,
  SkillOperationResult,
  InstallationTargets,
} from '../types/skills.js';
import { telemetry, EventType, type SkillOperation } from '../trace/index.js';
import { formatBytesMb } from '../utils/process-rss.js';

const DEVECO_CODE_AGENT = 'deveco';

/**
 * 获取要安装的技能名称列表
 */
async function getSkillNames(options: AddOptions): Promise<string[]> {
  const tagIds = await fetchTagIds();

  if (options.all) {
    // 如果 --all，调用 API 获取所有技能
    const skills = await fetchAllSkills(tagIds);
    return skills.map((s) => s.enName);
  } else {
    // 如果 --skill，查找指定技能（精确匹配 enName）
    const allSkills = await searchSkills(options.skill!, tagIds);
    const skill = allSkills.find((s) => s.enName === options.skill);
    if (!skill) {
      throw new ValidationError(
        'errorCode',
        `Skill "${options.skill}" not found`
      );
    }
    return [skill.enName];
  }
}

/**
 * 验证 add 命令的参数
 * @returns 解析后的路径
 */
function validateAddOptions(options: AddOptions): {
  resolvedPath: string | undefined;
  resolvedProject: string | undefined;
} {
  // 1. 参数验证：--all 和 --skill 不能同时指定
  if (options.all && options.skill) {
    throw new ValidationError(
      'errorCode',
      '`--all` and `--skill` cannot be specified together.'
    );
  }

  // 2. 参数验证：必须提供 --all 或 --skill
  if (!options.all && !options.skill) {
    throw new ValidationError('errorCode', 'Must specify `--all` or `--skill`');
  }

  // 3. 互斥验证并解析路径
  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );

  // 4. 目录存在性检查
  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory', options.force);
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory', options.force);
  }

  return { resolvedPath, resolvedProject };
}

function hasExplicitInstallTarget(
  options: { path?: string; project?: string; agent?: string },
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): boolean {
  return !!(
    resolvedPath ||
    resolvedProject ||
    options.path ||
    options.project ||
    options.agent
  );
}

function devecoCodeOnlyTargets(): InstallationTargets {
  return {
    agents: [DEVECO_CODE_AGENT],
    projectAgents: [],
    customPath: undefined,
  };
}

/**
 * 获取安装目标（skill 名称列表和安装目标）
 */
async function getInstallationTargets(
  options: AddOptions,
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<{
  skillNames: string[];
  targets: InstallationTargets;
}> {
  const targets =
    isDevecoCodeAuth() &&
    !hasExplicitInstallTarget(options, resolvedPath, resolvedProject)
      ? devecoCodeOnlyTargets()
      : await resolveInstallationTargets(
          options,
          resolvedPath,
          resolvedProject
        );
  const skillNames = await getSkillNames(options);
  return { skillNames, targets };
}

/**
 * 批量安装技能
 */
async function installSkills(
  skillNames: string[],
  targets: InstallationTargets,
  spinner: SpinnerHelper,
  force: boolean
): Promise<{ results: SkillOperationResult[]; diskBytes: number }> {
  const results: SkillOperationResult[] = [];
  let diskBytes = 0;
  const total = skillNames.length;
  const limit = pLimit(5);

  // 并发启动下载任务
  const downloadPromises = skillNames.map((name) =>
    limit(() => downloadSkillSafe(name))
  );

  for (let i = 0; i < skillNames.length; i++) {
    const skillName = skillNames[i];
    const progress = total > 1 ? ` (${i + 1}/${total})` : '';
    spinner.start(`Installing ${skillName}${progress}...`);

    // 等待当前技能的下载结果
    const downloadResult = await downloadPromises[i];
    if (!downloadResult.success) {
      spinner.fail();
      console.log(
        red(`${skillName}: Download failed - ${downloadResult.error}`)
      );
      results.push({ success: false });
      continue;
    }
    diskBytes += downloadResult.buffer.length;
    spinner.stop();
    const installResults = await new SkillInstaller().installArchiveSkill(
      skillName,
      downloadResult.buffer,
      targets,
      force
    );
    results.push(...installResults);
  }

  return { results, diskBytes };
}

async function downloadSkillSafe(
  name: string
): Promise<
  { buffer: Buffer; success: true } | { error: string; success: false }
> {
  try {
    const buffer = await downloadSkill(name);
    return { buffer, success: true };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'unknown error';
    return { error: errorMsg, success: false };
  }
}

/**
 * 处理 add 子命令
 */
async function handleAddCommand(
  options: AddOptions
): Promise<{ diskBytes: number; results: SkillOperationResult[] }> {
  const spinner = new SpinnerHelper();
  try {
    spinner.start(`Installing skill...`);
    const { resolvedPath, resolvedProject } = validateAddOptions(options);

    const { skillNames, targets } = await getInstallationTargets(
      options,
      resolvedPath,
      resolvedProject
    );

    const { results, diskBytes } = await installSkills(
      skillNames,
      targets,
      spinner,
      options.force ?? false
    );

    spinner.stop();
    summarizeOperationResults(results);
    return { diskBytes, results };
  } catch (error: unknown) {
    spinner.stop();
    throw error;
  }
}

/** add/remove 共用：从 results 派生操作结果计数 + 失败原因（去重、脱敏）。 */
function computeOpCounts(
  results: SkillOperationResult[]
): Record<string, unknown> {
  const opTotal = results.length;
  const opSuccess = results.filter((r) => r.success && !r.skipped).length;
  const opSkipped = results.filter((r) => r.skipped).length;
  const opFailed = results.filter((r) => !r.success).length;
  const failedErrors = [
    ...new Set(
      results
        .filter((r) => !r.success && typeof r.error === 'string')
        .map((r) => sanitizeFailedError(r.error as string))
    ),
  ];
  return {
    opTotal,
    opSuccess,
    opFailed,
    opSkipped,
    ...(failedErrors.length > 0 ? { failedErrors } : {}),
  };
}

/** 失败原因脱敏：仅取首词（如 Unknown / Failed / Installation），剔除路径、技能名等细节。 */
function sanitizeFailedError(text: string): string {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(text.trim());
  return match ? match[1].slice(0, 32) : 'error';
}

class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function deriveSkillsErrorCode(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return error instanceof ValidationError
    ? (error as ValidationError).code
    : (e.code ?? e.name ?? 'UnknownError');
}

/**
 * 构造统计事件的参数列表，记录参数名称和 --agent 的取值。
 * 省略路径和 Skill 名称。
 */
function buildSkillsArgs(
  subAction: 'list' | 'find' | 'add' | 'remove',
  options: Partial<AddOptions> & { long?: boolean } = {}
): string[] {
  return [
    'skills',
    subAction,
    ...(options.all ? ['--all'] : []),
    ...(options.long ? ['--long'] : []),
    ...(options.skill ? ['--skill'] : []),
    ...(options.force ? ['--force'] : []),
    ...(options.agent ? ['--agent', options.agent] : []),
    ...(options.project ? ['--project'] : []),
    ...(options.path ? ['--path'] : []),
  ];
}

/** 记录 Skill 操作的耗时、执行结果和错误码，失败时继续抛出错误。 */
async function trackSkillsOperation(
  subAction: string,
  fn: () => Promise<Record<string, unknown>>,
  args: string[]
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  let extra: Record<string, unknown> = {};
  try {
    extra = await fn();
  } catch (e) {
    success = false;
    errorCode = deriveSkillsErrorCode(e);
    throw e;
  } finally {
    const event: SkillOperation = {
      event: EventType.SkillOperation,
      subAction,
      args,
      ...extra,
    };
    await telemetry.track(event, {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    });
  }
}

/** devecocli skills add：下载数据量 + 安装结果计数 + 失败原因。 */
function trackSkillsAdd(options: AddOptions): Promise<void> {
  return trackSkillsOperation(
    'add',
    async () => {
      const { diskBytes, results } = await handleAddCommand(options);
      return {
        diskUsage: formatBytesMb(diskBytes),
        ...(options.skill ? { skillName: options.skill } : {}),
        ...computeOpCounts(results),
      };
    },
    buildSkillsArgs('add', options)
  );
}

/**
 * 验证 remove 命令的参数
 * @returns 解析后的路径
 */
function validateRemoveOptions(options: RemoveOptions): {
  resolvedPath: string | undefined;
  resolvedProject: string | undefined;
} {
  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );
  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory');
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory');
  }
  return { resolvedPath, resolvedProject };
}

/**
 * 处理 remove 子命令
 */
async function handleRemoveCommand(
  skillName: string,
  options: RemoveOptions
): Promise<SkillOperationResult[]> {
  const spinner = new SpinnerHelper();
  try {
    spinner.start('Removing skill...');
    const { resolvedPath, resolvedProject } = validateRemoveOptions(options);
    spinner.stop();
    const results = await removeSkill(
      options,
      skillName,
      resolvedPath,
      resolvedProject
    );
    spinner.stop();
    summarizeOperationResults(results);
    return results;
  } catch (error: unknown) {
    spinner.stop();
    throw error;
  }
}

async function removeSkill(
  options: RemoveOptions,
  skillName: string,
  resolvedPath: string | undefined,
  resolvedProject: string | undefined
): Promise<SkillOperationResult[]> {
  const targets =
    options.agent || resolvedPath
      ? await resolveInstallationTargets(options, resolvedPath, resolvedProject)
      : resolvedProject
        ? {
            agents: [],
            explicitAgents: false,
            projectAgents: getAgentNames().map((agent) => ({
              project: resolvedProject,
              agent,
            })),
          }
        : { agents: getAgentNames(), projectAgents: [] };
  return new SkillInstaller().removeSkill(skillName, targets);
}

// 创建主命令
const skillsCommand = new Command('skills').description(
  'Manage HarmonyOS skills'
);

// 添加 list 子命令
skillsCommand
  .command('list')
  .description('List all available HarmonyOS skills')
  .option(
    '-l, --long',
    'Show detailed information including description and installation status'
  )
  .action(async (options: { long?: boolean }) => {
    try {
      await trackSkillsOperation(
        'list',
        async () => {
          const spinner = new SpinnerHelper();
          try {
            spinner.start('Fetching skills...');
            const tagIds = await fetchTagIds();

            const skills = await fetchAllSkills(tagIds);

            if (skills.length === 0) {
              spinner.stop();
              console.log(yellow('No skills available.'));
              return { resultTotal: 0 };
            }
            spinner.succeed(`Fetched ${skills.length} skills`);

            for (const skill of skills) {
              if (!options.long) {
                console.log(skill.enName);
                continue;
              }
              console.log(cyan(skill.enName));
              console.log(dim(skill.description));

              const installedAgents = getInstalledAgents(skill.enName);
              if (installedAgents.length > 0) {
                console.log(
                  green(`Installed for: ${installedAgents.join(', ')}`)
                );
              }
              console.log();
            }
            return { resultTotal: skills.length };
          } finally {
            spinner.stop();
          }
        },
        buildSkillsArgs('list', options)
      );
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exitCode = 1;
    }
  });

// 添加 find 子命令
skillsCommand
  .command('find <keyword>')
  .description('Search skills by keyword')
  .action(async (keyword: string) => {
    try {
      await trackSkillsOperation(
        'find',
        async () => {
          const spinner = new SpinnerHelper();
          try {
            spinner.start('Searching skills...');
            const tagIds = await fetchTagIds();

            const skills = await searchSkills(keyword, tagIds);

            if (skills.length === 0) {
              console.log(yellow(`No skills found matching '${keyword}'.`));
              spinner.stop();
              return { resultTotal: 0, queryLen: keyword.length, keyword };
            }

            spinner.succeed(`Found ${skills.length} skills.`);

            for (const skill of skills) {
              console.log(cyan(skill.enName));
              console.log(dim(skill.description));
              console.log();
            }
            return {
              resultTotal: skills.length,
              queryLen: keyword.length,
              keyword,
            };
          } finally {
            spinner.stop();
          }
        },
        buildSkillsArgs('find')
      );
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exitCode = 1;
    }
  });

// 添加 add 子命令
skillsCommand
  .command('add')
  .description('Install skills to AI agents')
  .option('--all', 'Install all available skills')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated; Omit to install to all available agents'
  )
  .option('--skill <skill-name>', 'Name of the skill to install')
  .option(
    '-f, --force',
    'Replace existing Skill content; create missing project or custom target directories'
  )
  .option('--project <path>', 'Project root directory for skill installation')
  .option(
    '--path <path>',
    'Path to install the skill directly (cannot be used with --project or --agent)'
  )
  .action(async (options: AddOptions) => {
    try {
      await trackSkillsAdd(options);
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exitCode = 1;
    }
  });

// 添加 remove 子命令
skillsCommand
  .command('remove')
  .description('Remove an installed skill from AI agents')
  .requiredOption('--skill <skill-name>', 'Name of the skill to remove')
  .option(
    '--agent <agents>',
    'Target agents, comma-separated.Omit to remove from all available agents'
  )
  .option('--project <path>', 'Project root directory for skill removal')
  .option('--path <path>', 'Path for skill removal')
  .action(async (options: RemoveOptions) => {
    try {
      await trackSkillsOperation(
        'remove',
        async () => {
          const results = await handleRemoveCommand(options.skill!, options);
          return { skillName: options.skill!, ...computeOpCounts(results) };
        },
        buildSkillsArgs('remove', options)
      );
    } catch (error: unknown) {
      console.error(red((error as Error).message));
      process.exitCode = 1;
    }
  });

export default skillsCommand;
