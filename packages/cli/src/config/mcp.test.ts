/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  AGENT_MCP_CONFIG,
  buildOpenCodeMcpConfig,
  buildLocalStdioMcpConfig,
  buildCodebuddyMcpConfig,
  buildMcpServerConfig,
  buildMcpConfigForAgent,
} from './mcp.js';

describe('buildOpenCodeMcpConfig', () => {
  it('defaults PROJECT_PATH to the current directory', () => {
    expect(buildOpenCodeMcpConfig()).toEqual({
      type: 'local',
      command: ['devecocli', 'serve', 'mcp'],
      environment: { PROJECT_PATH: '.' },
      enabled: true,
    });
  });

  it('writes the absolute project path when provided', () => {
    const config = buildOpenCodeMcpConfig('E:/code/app');
    expect(config.environment?.PROJECT_PATH).toBe('E:/code/app');
    expect(config.type).toBe('local');
    expect(config.enabled).toBe(true);
  });
});

describe('buildLocalStdioMcpConfig', () => {
  it('defaults PROJECT_PATH to the current directory', () => {
    expect(buildLocalStdioMcpConfig()).toEqual({
      type: 'stdio',
      command: 'devecocli',
      args: ['serve', 'mcp'],
      env: { PROJECT_PATH: '.' },
      enabled: true,
    });
  });

  it('writes the absolute project path when provided', () => {
    const config = buildLocalStdioMcpConfig('E:/code/app');
    expect(config.env?.PROJECT_PATH).toBe('E:/code/app');
    expect(config.type).toBe('stdio');
  });
});

describe('buildMcpServerConfig', () => {
  it('defaults PROJECT_PATH to the workspaceFolder variable', () => {
    expect(buildMcpServerConfig()).toEqual({
      type: 'stdio',
      command: 'devecocli',
      args: ['serve', 'mcp'],
      env: { PROJECT_PATH: '${workspaceFolder}' },
    });
  });

  it('does not set enabled and writes the project path when provided', () => {
    const config = buildMcpServerConfig('E:/code/app');
    expect(config.enabled).toBeUndefined();
    expect(config.env?.PROJECT_PATH).toBe('E:/code/app');
  });
});

describe('buildMcpConfigForAgent', () => {
  it('returns an OpenCode local config for the opencode format', () => {
    const config = buildMcpConfigForAgent(AGENT_MCP_CONFIG.opencode);
    expect(config).toEqual(buildOpenCodeMcpConfig(undefined));
  });

  it('returns a local stdio config for the claude-code format', () => {
    const config = buildMcpConfigForAgent(AGENT_MCP_CONFIG['claude-code']);
    expect(config).toEqual(buildLocalStdioMcpConfig(undefined));
  });

  it('returns a local stdio config for the codex format', () => {
    const config = buildMcpConfigForAgent(AGENT_MCP_CONFIG.codex);
    expect(config).toEqual(buildLocalStdioMcpConfig(undefined));
  });

  it('returns the standard workspaceFolder config for standard formats', () => {
    for (const name of ['pi', 'cursor', 'trae-cn', 'qoder']) {
      const config = buildMcpConfigForAgent(AGENT_MCP_CONFIG[name]);
      expect(config).toEqual(buildMcpServerConfig(undefined));
    }
  });

  it('returns the codebuddy local config for the codebuddy format', () => {
    const config = buildMcpConfigForAgent(AGENT_MCP_CONFIG.codebuddy);
    expect(config).toEqual(buildCodebuddyMcpConfig(undefined));
    expect((config as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it('forwards the project path to every format', () => {
    const projectPath = 'E:/code/app';
    for (const name of Object.keys(AGENT_MCP_CONFIG)) {
      const config = buildMcpConfigForAgent(
        AGENT_MCP_CONFIG[name],
        projectPath
      );
      const env =
        (config as { environment?: Record<string, string> }).environment ??
        (config as { env?: Record<string, string> }).env;
      expect(env?.PROJECT_PATH).toBe(projectPath);
    }
  });
});

describe('AGENT_MCP_CONFIG', () => {
  it('keeps the entry key in sync with the name field', () => {
    for (const [key, entry] of Object.entries(AGENT_MCP_CONFIG)) {
      expect(entry.name).toBe(key);
    }
  });

  it('uses valid format and key values', () => {
    const formats = ['standard', 'opencode', 'claude-code', 'codex', 'codebuddy'];
    for (const entry of Object.values(AGENT_MCP_CONFIG)) {
      expect(formats).toContain(entry.format);
      expect(entry.mcpServersKey.length).toBeGreaterThan(0);
    }
    expect(AGENT_MCP_CONFIG.codex.mcpServersKey).toBe('mcp_servers');
  });

  it('uses relative project config paths', () => {
    for (const entry of Object.values(AGENT_MCP_CONFIG)) {
      expect(path.isAbsolute(entry.projectConfigPath)).toBe(false);
    }
    expect(AGENT_MCP_CONFIG.opencode.projectConfigPath).toBe(
      '.opencode/opencode.json'
    );
    expect(AGENT_MCP_CONFIG['claude-code'].projectConfigPath).toBe('.mcp.json');
  });
});
