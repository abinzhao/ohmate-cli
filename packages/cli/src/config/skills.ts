/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import agentsJson from './agents.json';

/** 共享的基础域名 */
const API_BASE_URL = 'https://matrix.openharmony.cn';

/**
 * Skills API 常量
 */
export const SkillsApiConstants = {
  /** Tags API 端点（获取技能标签列表） */
  TAGS_API_URL: `${API_BASE_URL}/api/model_base/model/tags?serviceType=skill`,
  /** Skills API 端点（获取技能列表） */
  SKILLS_API_URL: `${API_BASE_URL}/api/registry/skill/skills`,
  /** 共享的技能 API 基础路径 */
  SKILL_API_BASE: `${API_BASE_URL}/api/registry/skill`,
  /** 默认分页大小 */
  DEFAULT_PAGE_SIZE: 20,
  /** 默认最大分页数 */
  DEFAULT_MAX_PAGES: 100,
  /** 成功响应码 */
  SUCCESS_CODE: '20000',
} as const;

/** 单个 agent 的 Skill 路径配置；全局路径的 ~ 表示用户主目录。 */
export interface AgentSkillsEntry {
  readonly displayName: string;
  /** 相对项目根目录的安装入口 */
  readonly skillsDir: string;
  /** 全局安装入口 */
  readonly globalSkillsDir: string;
  /** develop 已有的检测目录；省略时由 CLI 根据独立安装目录检测 */
  readonly detect?: readonly string[];
  /** 与当前路径不同的 develop 项目旧目录 */
  readonly legacySkillsDirs?: readonly string[];
  /** 与当前路径不同的 develop 全局旧目录 */
  readonly legacyGlobalSkillsDirs?: readonly string[];
}

/** 共享 Agent 入口（相对全局主目录或项目根）；具体 Skill 条目链接到各自的源目录。 */
export const UNIVERSAL_SKILLS_DIR = '.agents/skills';

export const AGENT_SKILLS_CONFIG: Readonly<Record<string, AgentSkillsEntry>> =
  agentsJson as Record<string, AgentSkillsEntry>;
