/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { cyan } from 'colorette';
import * as TOML from 'smol-toml';
import {
  AGENT_MCP_CONFIG,
  AgentMcpConfig,
  MCP_SERVER_NAME,
  buildMcpConfigForAgent,
} from '../config/mcp';
import { SkillOperationResult } from '../types/skills';

const fsp = fs.promises;

/**
 * MCP 配置安装结果
 */
export interface McpConfigResult extends SkillOperationResult {
  configPath?: string;
  agentName?: string;
  installType?: 'global' | 'project';
}

async function readJsonConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    if (content.trim() === '') {
      return {};
    }
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read configuration file ${filePath}: ${(err as Error).message}`, { cause: err });
  }
}

async function readTomlConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    if (content.trim() === '') {
      return {};
    }
    return TOML.parse(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read TOML config file ${filePath}: ${(err as Error).message}`, { cause: err });
  }
}

async function writeJsonConfig(filePath: string, config: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const content = JSON.stringify(config, null, 2);
  await fsp.writeFile(filePath, content, 'utf8');
}

async function writeTomlConfig(filePath: string, config: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const content = TOML.stringify(config);
  await fsp.writeFile(filePath, content, 'utf8');
}

function isMcpServerConfigured(
  config: Record<string, unknown>,
  mcpServersKey: string,
  serverName: string
): boolean {
  const mcpServers = config[mcpServersKey] as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return false;
  }
  return serverName in mcpServers;
}

function addMcpServerConfig(
  config: Record<string, unknown>,
  mcpServersKey: string,
  serverName: string,
  serverConfig: Record<string, unknown>,
  force: boolean
): boolean {
  if (!config[mcpServersKey] || typeof config[mcpServersKey] !== 'object') {
    config[mcpServersKey] = {};
  }
  const mcpServers = config[mcpServersKey] as Record<string, unknown>;
  if (serverName in mcpServers && !force) {
    return false;
  }
  mcpServers[serverName] = serverConfig;
  return true;
}

function removeMcpServerConfig(
  config: Record<string, unknown>,
  mcpServersKey: string,
  serverName: string
): boolean {
  const mcpServers = config[mcpServersKey] as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return false;
  }
  if (!(serverName in mcpServers)) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [serverName]: _, ...rest } = mcpServers;
  config[mcpServersKey] = rest;
  return true;
}

async function readConfig(
  agentConfig: AgentMcpConfig,
  filePath: string
): Promise<Record<string, unknown>> {
  if (agentConfig.format === 'codex') {
    return readTomlConfig(filePath);
  }
  return readJsonConfig(filePath);
}

async function writeConfig(
  agentConfig: AgentMcpConfig,
  filePath: string,
  config: Record<string, unknown>
): Promise<void> {
  if (agentConfig.format === 'codex') {
    return writeTomlConfig(filePath, config);
  }
  return writeJsonConfig(filePath, config);
}

/**
 * 安装 MCP 配置到指定 agent（全局）
 */
export async function installMcpConfigToAgentGlobal(
  agentName: string,
  projectPath: string,
  force: boolean = false
): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return {
      success: false,
      error: `Unknown agent: ${agentName}. Supported agents: ${Object.keys(AGENT_MCP_CONFIG).join(', ')}`,
    };
  }

  if (!agentConfig.supportsGlobal) {
    return {
      success: false,
      error: `${agentConfig.displayName} does not support global MCP configuration. Use --project to configure project-level MCP.`,
    };
  }

  try {
    const config = await readConfig(agentConfig, agentConfig.globalConfigPath);

    if (isMcpServerConfigured(config, agentConfig.mcpServersKey, MCP_SERVER_NAME) && !force) {
      console.log(`MCP server ${MCP_SERVER_NAME} already configured in ${agentConfig.globalConfigPath}.`);
      return {
        success: true,
        skipped: true,
        configPath: agentConfig.globalConfigPath,
        agentName,
        installType: 'global',
      };
    }

    const serverConfig = buildMcpConfigForAgent(agentConfig, undefined);
    addMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME, serverConfig as unknown as Record<string, unknown>, force);

    await writeConfig(agentConfig, agentConfig.globalConfigPath, config);
    console.log(`MCP server ${MCP_SERVER_NAME} configured in ${agentConfig.globalConfigPath}.`);

    return {
      success: true,
      configPath: agentConfig.globalConfigPath,
      agentName,
      installType: 'global',
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to configure MCP for ${agentConfig.displayName}: ${(err as Error).message}`,
    };
  }
}

/**
 * 安装 MCP 配置到指定 agent（项目级）
 */
export async function installMcpConfigToAgentProject(
  agentName: string,
  projectPath: string,
  force: boolean = false
): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return {
      success: false,
      error: `Unknown agent: ${agentName}. Supported agents: ${Object.keys(AGENT_MCP_CONFIG).join(', ')}`,
    };
  }

  const configFile = path.isAbsolute(agentConfig.projectConfigPath)
    ? agentConfig.projectConfigPath
    : path.join(projectPath, agentConfig.projectConfigPath);

  try {
    const config = await readConfig(agentConfig, configFile);

    if (isMcpServerConfigured(config, agentConfig.mcpServersKey, MCP_SERVER_NAME) && !force) {
      console.log(`MCP server ${MCP_SERVER_NAME} already configured in ${configFile}.`);
      return {
        success: true,
        skipped: true,
        configPath: configFile,
        agentName,
        installType: 'project',
      };
    }

    const serverConfig = buildMcpConfigForAgent(agentConfig, projectPath);
    addMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME, serverConfig as unknown as Record<string, unknown>, force);

    await writeConfig(agentConfig, configFile, config);
    console.log(`MCP server ${MCP_SERVER_NAME} configured in ${configFile}.`);

    return {
      success: true,
      configPath: configFile,
      agentName,
      installType: 'project',
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to configure MCP for ${agentConfig.displayName}: ${(err as Error).message}`,
    };
  }
}

/**
 * 移除 MCP 配置（全局）
 */
export async function removeMcpConfigFromAgentGlobal(agentName: string): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return { success: false, error: `Unknown agent: ${agentName}` };
  }

  if (!agentConfig.globalConfigPath) {
    return { success: true, skipped: true, agentName };
  }

  try {
    const config = await readConfig(agentConfig, agentConfig.globalConfigPath);

    if (!removeMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME)) {
      console.log(`MCP server ${MCP_SERVER_NAME} not found in ${agentConfig.globalConfigPath}.`);
      return {
        success: true,
        skipped: true,
        configPath: agentConfig.globalConfigPath,
        agentName,
        installType: 'global',
      };
    }

    await writeConfig(agentConfig, agentConfig.globalConfigPath, config);
    console.log(`MCP server ${MCP_SERVER_NAME} removed from ${agentConfig.globalConfigPath}.`);

    return {
      success: true,
      configPath: agentConfig.globalConfigPath,
      agentName,
      installType: 'global',
    };
  } catch (err) {
    return { success: false, error: `Failed to remove MCP configuration: ${(err as Error).message}` };
  }
}

/**
 * 移除 MCP 配置（项目级）
 */
export async function removeMcpConfigFromAgentProject(
  agentName: string,
  projectPath: string
): Promise<McpConfigResult> {
  const agentConfig = AGENT_MCP_CONFIG[agentName];
  if (!agentConfig) {
    return { success: false, error: `Unknown agent: ${agentName}` };
  }

  const configFile = path.isAbsolute(agentConfig.projectConfigPath)
    ? agentConfig.projectConfigPath
    : path.join(projectPath, agentConfig.projectConfigPath);

  try {
    const config = await readConfig(agentConfig, configFile);

    if (!removeMcpServerConfig(config, agentConfig.mcpServersKey, MCP_SERVER_NAME)) {
      console.log(`MCP server ${MCP_SERVER_NAME} not found in ${configFile}`);
      return {
        success: true,
        skipped: true,
        configPath: configFile,
        agentName,
        installType: 'project',
      };
    }

    await writeConfig(agentConfig, configFile, config);
    console.log(`MCP server ${MCP_SERVER_NAME} removed from ${configFile}`);

    return {
      success: true,
      configPath: configFile,
      agentName,
      installType: 'project',
    };
  } catch (err) {
    return { success: false, error: `Failed to remove MCP config: ${(err as Error).message}` };
  }
}

export function getSupportedMcpAgents(): string[] {
  return Object.keys(AGENT_MCP_CONFIG);
}

export function getAgentMcpConfig(agentName: string): AgentMcpConfig | undefined {
  return AGENT_MCP_CONFIG[agentName];
}

export function summarizeMcpResults(results: McpConfigResult[]): void {
  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.success).length;

  console.log();
  console.log(cyan('Finished:'));
  console.log(`  Success: ${successCount}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`  Failed: ${failedCount}`);

  for (const r of results) {
    if (!r.success && r.error) {
      console.error(`  - ${r.agentName ?? 'unknown'}: ${r.error}`);
    }
  }

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}