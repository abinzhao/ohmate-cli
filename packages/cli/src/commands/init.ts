/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Command } from 'commander';
import { red, cyan } from 'colorette';
import {
  SkillInstaller,
  resolveBundledSkillDir,
  summarizeOperationResults,
  validatePathMutex,
  validateDirectoryPath,
  resolveInstallationTargets,
  installMcpConfigToAgentGlobal,
  installMcpConfigToAgentProject,
  summarizeMcpResults,
  resolveMcpInstallationTargets,
} from '../skills/index.js';
import { AGENT_MCP_CONFIG } from '../config/mcp.js';
import {
  InitOptions,
  SkillOperationResult,
  type InstallationTargets,
} from '../types/skills.js';
import {
  telemetry,
  EventType,
  type McpConfigOperation,
  type SkillConfigOperation,
  type TrackMeasurement,
} from '../trace/index.js';

function resolveTraceAgents(targets: InstallationTargets): string[] {
  return [
    ...new Set([
      ...targets.agents,
      ...targets.projectAgents.map(({ agent }) => agent),
    ]),
  ];
}

async function recordSkillConfigEvent(
  event: SkillConfigOperation,
  start: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  await telemetry
    .track(event, {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    })
    .catch(() => {});
}

async function trackSkillConfigInstall(
  targets: InstallationTargets,
  sourceDir: string,
  resolvedPath: string | undefined,
  resolvedProject: string | undefined,
  force: boolean
): Promise<SkillOperationResult[]> {
  const event: SkillConfigOperation = {
    event: EventType.SkillConfigOperation,
    subAction: 'install',
    targetType: resolvedPath ? 'path' : resolvedProject ? 'project' : 'global',
    agents: resolveTraceAgents(targets),
  };
  const start = Date.now();
  try {
    const results = await new SkillInstaller().installBundledSkill(
      sourceDir,
      targets,
      force
    );
    const success = results.every((result) => result.success);
    await recordSkillConfigEvent(
      event,
      start,
      success,
      success ? null : 'SKILL_INSTALL_FAILED'
    );
    return results;
  } catch (error) {
    const errorCode =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.name)
        : 'UnknownError';
    await recordSkillConfigEvent(event, start, false, errorCode);
    throw error;
  }
}

/**
 * 给所选 Agent 配置项目级 MCP。
 */
async function installProjectLevelMcp(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string,
  force: boolean
): Promise<Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[]> {
  const results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] =
    [];

  for (const { project, agent } of targets.projectAgents) {
    const result = await installMcpConfigToAgentProject(agent, project, force);
    results.push(result);
  }
  for (const agentName of targets.agents) {
    const result = await installMcpConfigToAgentProject(
      agentName,
      resolvedProject,
      force
    );
    results.push(result);
  }
  return results;
}

/**
 * 给所选 Agent 配置全局 MCP。
 */
async function installGlobalMcp(
  agentNames: string[],
  force: boolean
): Promise<Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[]> {
  const results: Awaited<ReturnType<typeof installMcpConfigToAgentGlobal>>[] =
    [];
  for (const agentName of agentNames) {
    const agentConfig = AGENT_MCP_CONFIG[agentName];
    if (!agentConfig) {
      continue;
    }
    const result = await installMcpConfigToAgentGlobal(
      agentName,
      process.cwd(),
      force
    );
    results.push(result);
  }
  return results;
}

function supportsMcp(agent: string): boolean {
  return agent !== 'qoder' && agent !== 'dsh' && !!AGENT_MCP_CONFIG[agent];
}

/**
 * 按所选安装范围配置 MCP，并校验显式指定的 Agent 是否支持 MCP。
 */
async function executeMcpInstallations(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string | undefined,
  options: InitOptions
): Promise<void> {
  // 用户明确指定了不支持 MCP 的 agent 时报错
  const unsupportedAgent = resolveTraceAgents(targets).find(
    (agent) => !supportsMcp(agent)
  );
  if (options.agent && unsupportedAgent) {
    throw new Error(
      `${unsupportedAgent} does not support MCP configuration via DevEco CLI. Use --skill instead, or use other supported agents for MCP.`
    );
  }

  const force = options.force ?? false;

  // 过滤掉不支持 MCP 的 agent
  const filteredProjectAgents = targets.projectAgents.filter((p) =>
    supportsMcp(p.agent)
  );
  const filteredAgents = targets.agents.filter(supportsMcp);
  if (filteredProjectAgents.length === 0 && filteredAgents.length === 0) {
    throw new Error(
      'No agents supporting MCP configuration found; use --skill'
    );
  }

  const filteredTargets = {
    ...targets,
    projectAgents: filteredProjectAgents,
    agents: filteredAgents,
  };

  const mcpResults = resolvedProject
    ? await installProjectLevelMcp(filteredTargets, resolvedProject, force)
    : await installGlobalMcp(filteredTargets.agents, force);

  if (mcpResults.length > 0) {
    console.log(cyan('MCP Configuration:'));
    summarizeMcpResults(mcpResults);
  }
}

/**
 * 执行 MCP 配置安装，并记录耗时、执行结果和错误信息。
 */
async function trackMcpConfigInstall(
  targets: Awaited<ReturnType<typeof resolveInstallationTargets>>,
  resolvedProject: string | undefined,
  options: InitOptions
): Promise<void> {
  const mcpEvent: McpConfigOperation = {
    event: EventType.Init,
    subAction: 'install',
    targetType: resolvedProject ? 'project' : 'global',
    agentName: options.agent,
  };
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await executeMcpInstallations(targets, resolvedProject, options);
  } catch (e) {
    success = false;
    errorCode =
      e instanceof Error
        ? ((e as NodeJS.ErrnoException).code ?? e.name)
        : 'UnknownError';
    throw e;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(mcpEvent, measurement);
  }
}

/**
 * devecocli init 入口
 * - 不带标志 / --skill：只安装 skill
 * - 带 --mcp：只配置 MCP（不安装 skill）
 * - --skill 和 --mcp 互斥
 */
async function handleInitCommand(options: InitOptions): Promise<void> {
  if (options.path && options.mcp) {
    throw new Error('--path applies to Skill installation only; remove --mcp');
  }
  // --skill 和 --mcp 互斥
  if (options.skill && options.mcp) {
    throw new Error(
      'Cannot use `--skill` and `--mcp` together. Use `--skill` for skill installation only, or `--mcp` for MCP configuration only.'
    );
  }

  const { resolvedPath, resolvedProject } = validatePathMutex(
    options.path,
    options.project,
    options.agent
  );

  if (resolvedProject) {
    validateDirectoryPath(resolvedProject, 'Project directory', options.force);
  }
  if (resolvedPath) {
    validateDirectoryPath(resolvedPath, 'Directory', options.force);
  }

  // --mcp 时只配置 MCP，不安装 skill
  if (options.mcp) {
    const targets = await resolveMcpInstallationTargets(
      options,
      resolvedProject
    );
    await trackMcpConfigInstall(targets, resolvedProject, options);
    return;
  }

  // 默认或 --skill：只安装 skill
  const targets = await resolveInstallationTargets(
    options,
    resolvedPath,
    resolvedProject
  );
  const sourceDir = resolveBundledSkillDir();
  const skillResults = await trackSkillConfigInstall(
    targets,
    sourceDir,
    resolvedPath,
    resolvedProject,
    options.force ?? false
  );

  console.log();
  if (skillResults.length > 0) {
    console.log(cyan('Skill Installation:'));
    summarizeOperationResults(skillResults);
  }
}

const initCommand = new Command('init')
  .description(
    'Install the deveco-cli skill or configure the deveco-mcp server into AI agents'
  )
  .option(
    '--agent <agents>',
    'Target agents, comma-separated; installs to all available agents if omitted'
  )
  .option(
    '--project <path>',
    'Project root directory for skill or MCP configuration'
  )
  .option(
    '--path <path>',
    'Path to install the skill directly (cannot be used with --project or --agent)'
  )
  .option(
    '--skill',
    'Install the deveco-cli skill only (same as default behavior; explicit for symmetry with --mcp)'
  )
  .option(
    '--mcp',
    'Configure the deveco-mcp server (syntax checking for .ets and C/C++) only; no skill installation'
  )
  .option(
    '-f, --force',
    'Replace existing Skill content or MCP configuration; create missing target directories'
  )
  .action(async (options: InitOptions) => {
    try {
      await handleInitCommand(options);
    } catch (error: unknown) {
      console.error(
        red(error instanceof Error ? error.message : String(error))
      );
      process.exitCode = 1;
    }
  });

export default initCommand;
