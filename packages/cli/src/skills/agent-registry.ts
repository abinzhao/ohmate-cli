/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { samePath } from './installation/directory-installation.js';
import {
  AGENT_SKILLS_CONFIG,
  UNIVERSAL_SKILLS_DIR,
  type AgentSkillsEntry,
} from '../config/skills.js';

/** 将配置中的用户目录展开为绝对路径。 */
export function expandPathTemplate(template: string): string {
  return path.resolve(
    template === '~' || template.startsWith('~/')
      ? path.join(homedir(), template.slice(1))
      : template
  );
}

export function getAgentNames(): string[] {
  return Object.keys(AGENT_SKILLS_CONFIG);
}

export function parseAgentNames(option: string | undefined): string[] {
  return [
    ...new Set(
      (option ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
}

export function getAgentEntry(agentName: string): AgentSkillsEntry {
  const entry = Object.prototype.hasOwnProperty.call(
    AGENT_SKILLS_CONFIG,
    agentName
  )
    ? AGENT_SKILLS_CONFIG[agentName]
    : undefined;
  if (!entry) {
    throw new Error(
      `Invalid agent: ${agentName}, Valid options are: ${getAgentNames().join(', ')}`
    );
  }
  return entry;
}

/** 全局安装入口。 */
export function getGlobalSkillsDir(agentName: string): string {
  return expandPathTemplate(getAgentEntry(agentName).globalSkillsDir);
}

export function getProjectSkillsDir(
  projectDir: string,
  agentName: string
): string {
  return path.join(projectDir, getAgentEntry(agentName).skillsDir);
}

/** 共享 Agent 入口：全局 ~/.agents/skills，项目 <project>/.agents/skills。 */
export function getSharedAgentSkillsDir(projectDir?: string): string {
  return path.join(projectDir ?? homedir(), UNIVERSAL_SKILLS_DIR);
}

/** 按安装范围返回配置中的实际入口，不根据项目路径改写全局路径。 */
export function getNativeSkillsDir(
  agentName: string,
  projectDir?: string
): string {
  return projectDir
    ? getProjectSkillsDir(projectDir, agentName)
    : getGlobalSkillsDir(agentName);
}

/** 当前范围内的安装入口是否就是共享 Agent 入口。 */
export function isUniversalAgent(
  agentName: string,
  projectDir?: string
): boolean {
  const dir = getNativeSkillsDir(agentName, projectDir);
  return samePath(dir, getSharedAgentSkillsDir(projectDir));
}

/** 只返回配置明确列出的旧目录；与当前目录相同的条目去重排除。 */
export function getStaleSkillsDirs(
  agentName: string,
  projectDir?: string
): string[] {
  const entry = getAgentEntry(agentName);
  const candidates = projectDir
    ? (entry.legacySkillsDirs ?? []).map((dir) => path.join(projectDir, dir))
    : (entry.legacyGlobalSkillsDirs ?? []).map(expandPathTemplate);
  const seen = [getNativeSkillsDir(agentName, projectDir)];
  return candidates.filter((dir) => {
    if (seen.some((previous) => samePath(previous, dir))) {
      return false;
    }
    seen.push(dir);
    return true;
  });
}

/** 只用点号开头的独立配置目录检测项目 Agent。 */
export function hasProjectAgentRoot(
  projectDir: string,
  agentName: string
): boolean {
  const root = getAgentEntry(agentName).skillsDir.split('/')[0];
  return root.startsWith('.') && fs.existsSync(path.join(projectDir, root));
}

/** CLI 检测策略：沿用 develop 的规则，其余只检测已知的独立目录。 */
export function isAgentInstalled(
  agentName: string,
  projectDir?: string
): boolean {
  const entry = getAgentEntry(agentName);
  if (entry.detect) {
    return entry.detect.some((dir) => fs.existsSync(expandPathTemplate(dir)));
  }
  const global = getGlobalSkillsDir(agentName);
  const shared = [getSharedAgentSkillsDir(), getGlobalSkillsDir('universal')];
  if (
    !shared.some((dir) => samePath(dir, global)) &&
    fs.existsSync(path.dirname(global))
  ) {
    return true;
  }
  return !!(
    projectDir &&
    entry.skillsDir !== UNIVERSAL_SKILLS_DIR &&
    hasProjectAgentRoot(projectDir, agentName)
  );
}
