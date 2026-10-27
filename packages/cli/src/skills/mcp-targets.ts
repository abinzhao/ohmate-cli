/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { MCP_TARGET_AGENT_ROOTS } from '../config/mcp.js';
import type { InstallationTargets } from '../types/skills.js';
import { parseAgentNames } from './agent-registry.js';

/** Skill 路径变更不改变 MCP 的候选 Agent；显式指定仍可创建配置目录。 */
export async function resolveMcpInstallationTargets(
  options: { agent?: string },
  project?: string
): Promise<InstallationTargets> {
  const agents: string[] = [];
  const candidates = options.agent
    ? parseAgentNames(options.agent)
    : Object.keys(MCP_TARGET_AGENT_ROOTS);
  for (const name of candidates) {
    if (!Object.prototype.hasOwnProperty.call(MCP_TARGET_AGENT_ROOTS, name)) {
      throw new Error(`Invalid MCP agent: ${name}`);
    }
    if (
      options.agent ||
      fs.existsSync(path.join(homedir(), MCP_TARGET_AGENT_ROOTS[name]))
    ) {
      agents.push(name);
    }
  }
  if (!agents.length) {
    throw new Error(
      'No agents supporting MCP configuration found; use --skill'
    );
  }
  return project
    ? { agents: [], projectAgents: agents.map((agent) => ({ project, agent })) }
    : { agents, projectAgents: [] };
}
