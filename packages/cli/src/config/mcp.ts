/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { homedir } from 'os';
import path from 'path';

/**
 * MCP Server 名称
 */
export const MCP_SERVER_NAME = 'deveco-mcp';

/** MCP 的目标检测范围独立于 Skill 注册表。 */
export const MCP_TARGET_AGENT_ROOTS: Readonly<Record<string, string>> = {
  'trae-cn': '.trae-cn',
  opencode: '.config/opencode',
  pi: '.pi/agent',
  deveco: '.config/deveco',
  cursor: '.cursor',
  codebuddy: '.codebuddy',
  qoder: '.qoder',
  'claude-code': '.claude',
  codex: '.codex',
  atomcode: '.atomcode',
  dsh: '.dsh',
};

/**
 * OpenCode MCP Local Server 配置格式
 * OpenCode 使用 `mcp` 字段， */
export interface OpenCodeMcpConfig {
  /** 类型：local */
  type: 'local';
  /** 命令和参数数组 */
  command: string[];
  /** 环境变量 */
  environment?: Record<string, string>;
  /** 是否启用 */
  enabled?: boolean;
  /** 超时时间 (ms) */
  timeout?: number;
}

/**
 * 标准 MCP Server 配置 (其他 AI 使用)
 * 用于 stdio 类型的 MCP 服务器
 */
export interface McpServerConfig {
  /** 服务器类型，默认 stdio */
  type?: 'stdio' | 'sse';
  /** 执行命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 是否启用 */
  enabled?: boolean;
}

/**
 * Agent MCP 配置信息
 */
export interface AgentMcpConfig {
  /** Agent 名称 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 是否支持全局 MCP 配置 */
  supportsGlobal: boolean;
  /** 全局配置文件路径（仅 supportsGlobal=true 时有效） */
  globalConfigPath: string;
  /** 项目级配置文件路径 */
  projectConfigPath: string;
  /** 配置文件中 MCP servers 的 JSON key */
  mcpServersKey: string;
  /** 配置格式类型 */
  format: 'standard' | 'opencode' | 'claude-code' | 'codex' | 'codebuddy';
}

/** 支持全局 MCP 配置的 agent 名称列表 */
export const GLOBAL_MCP_AGENTS = [
  'opencode',
  'pi',
  'cursor',
  'claude-code',
  'codex',
];

/**
 * 各 AI Agent 的 MCP 配置信息
 *
 * 关键区分：
 * - 全局模式（--mcp）：所有 supportsGlobal=true 的 agent 写入 globalConfigPath，PROJECT_PATH 用默认值
 * - 项目级模式（--mcp --project xxx）：opencode/trae-cn 写入项目目录下，其余写入 globalConfigPath（同全局路径），PROJECT_PATH 写入绝对路径
 */
export const AGENT_MCP_CONFIG: Record<string, AgentMcpConfig> = {
  /**
   * OpenCode - 支持全局 + 项目级（项目级写入项目目录）
   * 全局：~/.config/opencode/opencode.json
   * 项目级：<project>/.opencode/opencode.json
   */
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.config', 'opencode', 'opencode.json'),
    projectConfigPath: '.opencode/opencode.json',
    mcpServersKey: 'mcp',
    format: 'opencode',
  },

  /**
   * Pi Coding Agent - 支持全局 + 项目级
   * 全局：~/.pi/agent/mcp.json
   * 项目级：<project>/.pi/mcp.json
   */
  pi: {
    name: 'pi',
    displayName: 'Pi Coding Agent',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.pi', 'agent', 'mcp.json'),
    projectConfigPath: '.pi/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Trae-CN - 支持全局 + 项目级
   * 全局：
   *   Windows: %APPDATA%/Trae CN/User/mcp.json
   *   macOS: ~/Library/Application Support/Trae CN/User/mcp.json
   * 项目级：<project>/.trae/mcp.json
   */
  'trae-cn': {
    name: 'trae-cn',
    displayName: 'Trae-CN',
    supportsGlobal: true,
    globalConfigPath: path.join(
      process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'Trae CN', 'User')
        : path.join(homedir(), 'Library', 'Application Support', 'Trae CN', 'User'),
      'mcp.json'
    ),
    projectConfigPath: '.trae/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Cursor - 支持全局 + 项目级
   * 全局：~/.cursor/mcp.json
   * 项目级：<project>/.cursor/mcp.json
   */
  cursor: {
    name: 'cursor',
    displayName: 'Cursor',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.cursor', 'mcp.json'),
    projectConfigPath: '.cursor/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Codebuddy - 支持全局 + 项目级
   * 全局：~/.codebuddy/mcp.json
   * 项目级：<project>/.codebuddy/mcp.json
   */
  codebuddy: {
    name: 'codebuddy',
    displayName: 'Codebuddy',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.codebuddy', 'mcp.json'),
    projectConfigPath: '.codebuddy/mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'codebuddy',
  },

  /**
   * Qoder - 支持全局 + 项目级
   * 全局：~/Library/Application Support/Qoder/SharedClientCache/mcp.json (macOS)
   *        %APPDATA%/Qoder/SharedClientCache/mcp.json (Windows)
   * 项目级：<project>/.mcp.json
   */
  qoder: {
    name: 'qoder',
    displayName: 'Qoder',
    supportsGlobal: true,
    globalConfigPath: path.join(
      process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'Qoder', 'SharedClientCache')
        : path.join(homedir(), 'Library', 'Application Support', 'Qoder', 'SharedClientCache'),
      'mcp.json'
    ),
    projectConfigPath: '.mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'standard',
  },

  /**
   * Claude Code - 支持全局 + 项目级
   * 全局：~/.claude.json（user scope，mcpServers 在顶层）
   * 项目级：<project>/.mcp.json（project scope，团队共享）
   * 全局模式使用 PROJECT_PATH: '.'
   */
  'claude-code': {
    name: 'claude-code',
    displayName: 'Claude Code',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.claude.json'),
    projectConfigPath: '.mcp.json',
    mcpServersKey: 'mcpServers',
    format: 'claude-code',
  },

  /**
   * Codex - 支持全局 + 项目级
   * 全局：~/.codex/config.toml
   * 项目级：<project>/.codex/config.toml
   * Codex 使用 TOML 格式配置，MCP servers 写入 [mcp_servers.<name>] 表
   */
  codex: {
    name: 'codex',
    displayName: 'Codex',
    supportsGlobal: true,
    globalConfigPath: path.join(homedir(), '.codex', 'config.toml'),
    projectConfigPath: '.codex/config.toml',
    mcpServersKey: 'mcp_servers',
    format: 'codex',
  },
};

/**
 * 构建 OpenCode MCP Server 配置
 * - 全局模式：PROJECT_PATH = '.'（当前目录），MCP server 会从 process.cwd() 自动检测项目
 * - 项目级模式（有 --project）：PROJECT_PATH 直接写入项目绝对路径
 */
export function buildOpenCodeMcpConfig(
  projectPath?: string
): OpenCodeMcpConfig {
  const environment: Record<string, string> = {
    // 全局用 '.'（MCP server 使用 process.cwd()），项目级直接写入绝对路径
    PROJECT_PATH: projectPath ?? '.',
  };

  return {
    type: 'local',
    command: ['devecocli', 'serve', 'mcp'],
    environment,
    enabled: true,
  };
}

/**
 * 构建 Local Stdio MCP Server 配置
 * 用于不支持 ${workspaceFolder} 变量替换的 AI agent（如 Claude Code），
 * - 全局模式：PROJECT_PATH = '.'（MCP server 从 process.cwd() 自动检测项目）
 * - 项目级模式（有 --project）：PROJECT_PATH 直接写入项目绝对路径
 */
export function buildLocalStdioMcpConfig(
  projectPath?: string
): McpServerConfig {
  const env: Record<string, string> = {
    PROJECT_PATH: projectPath ?? '.',
  };

  return {
    type: 'stdio',
    command: 'devecocli',
    args: ['serve', 'mcp'],
    env,
    enabled: true,
  };
}

/**
 * 构建 Codebuddy MCP Server 配置
 * Codebuddy 不支持 ${workspaceFolder} 变量替换，不校验 enabled 字段。
 * - 全局模式：PROJECT_PATH = '.'（MCP server 从 process.cwd() 自动检测项目）
 * - 项目级模式（有 --project）：PROJECT_PATH 直接写入项目绝对路径
 */
export function buildCodebuddyMcpConfig(
  projectPath?: string
): McpServerConfig {
  const env: Record<string, string> = {
    PROJECT_PATH: projectPath ?? '.',
  };

  return {
    type: 'stdio',
    command: 'devecocli',
    args: ['serve', 'mcp'],
    env,
  };
}

/**
 * 构建标准 MCP Server 配置
 * - 全局模式：PROJECT_PATH = '${workspaceFolder}'，AI 客户端会自动替换为当前项目路径
 * - 项目级模式（有 --project）：PROJECT_PATH 直接写入项目绝对路径
 */
export function buildMcpServerConfig(
  projectPath?: string
): McpServerConfig {
  const env: Record<string, string> = {
    // 全局用 '${workspaceFolder}'（AI 客户端替换），项目级直接写入绝对路径
    PROJECT_PATH: projectPath ?? '${workspaceFolder}',
  };

  return {
    type: 'stdio',
    command: 'devecocli',
    args: ['serve', 'mcp'],
    env,
  };
}

/**
 * 根据 agent 的格式类型构建 MCP 配置
 * - 全局模式：OpenCode 用 '.'，其他用 '${workspaceFolder}'
 * - 项目级模式（有 projectPath）：所有 agent 的 PROJECT_PATH 直接写入项目绝对路径
 */
export function buildMcpConfigForAgent(
  agentConfig: AgentMcpConfig,
  projectPath?: string
): McpServerConfig | OpenCodeMcpConfig {
  if (agentConfig.format === 'opencode') {
    return buildOpenCodeMcpConfig(projectPath);
  }
  if (agentConfig.format === 'claude-code') {
    return buildLocalStdioMcpConfig(projectPath);
  }
  if (agentConfig.format === 'codex') {
    return buildLocalStdioMcpConfig(projectPath);
  }
  if (agentConfig.format === 'codebuddy') {
    return buildCodebuddyMcpConfig(projectPath);
  }
  return buildMcpServerConfig(projectPath);
}
