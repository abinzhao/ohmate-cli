/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 单个标签对象
 */
export interface Tag {
  /** 标签ID */
  id: string;
  /** 服务类型 */
  serviceType: string;
  /** 标签名称 */
  name: string;
  /** 标签英文名称 */
  enName: string;
  /** 创建时间 */
  createTime: string | null;
  /** 更新时间 */
  updateTime: string;
  /** 标签类型 */
  type: string;
  /** 是否关联 */
  linked: boolean;
}

/**
 * 格物API通用响应结构
 */
export interface MatrixApiResponse<T> {
  /** 响应码 */
  code: string;
  /** 响应消息 */
  message: string;
  /** 响应数据 */
  data: T;
}

/**
 * Tags API 响应数据
 */
export interface TagsData {
  /** 技能标签列表 */
  skill: Tag[];
}

/**
 * Tags API 响应
 */
export type TagsResponse = MatrixApiResponse<TagsData>;

/**
 * 技能所有者
 */
export interface Owner {
  /** 所有者ID */
  id: string;
  /** 用户ID */
  userId: string;
  /** 来源 */
  source: string;
  /** 账号 */
  account: string;
  /** 英文名 */
  enName: string;
  /** 中文名 */
  cnName: string;
  /** 头像 */
  image: string;
  /** 角色列表 */
  roleList: string[] | null;
}

/**
 * 技能分类
 */
export interface Category {
  /** 分类ID */
  id: string;
  /** 模块类型 */
  moduleType: string;
  /** 英文名称 */
  enName: string;
  /** 中文名称 */
  cnName: string;
  /** 英文描述 */
  enDescription: string;
  /** 中文描述 */
  cnDescription: string;
}

/**
 * 技能标签（Skill 中的 tags 字段）
 */
export interface SkillTag {
  /** 标签ID */
  id: string;
  /** 服务类型 */
  serviceType: string;
  /** 标签名称 */
  name: string;
  /** 英文名称 */
  enName: string;
  /** 创建时间 */
  createTime: string | null;
  /** 更新时间 */
  updateTime: string;
  /** 标签类型 */
  type: string;
  /** 是否关联 */
  linked: boolean;
}

/**
 * 单个技能对象
 */
export interface Skill {
  /** 技能ID，唯一标识 */
  id: string;
  /** 技能名称 */
  name: string;
  /** 英文名称，名称唯一不会重复 */
  enName: string;
  /** 所有者信息 */
  owner: Owner;
  /** 分类列表 */
  categoryList: Category[];
  /** 组织ID */
  orgId: string;
  /** 标签ID列表 */
  tagIds: string[];
  /** 描述 */
  description: string;
  /** 可见性 */
  visibility: string | null;
  /** Markdown文件ID */
  mdFileId: string;
  /** 账号 */
  account: string;
  /** 提示词 */
  prompt: string | null;
  /** 状态 */
  status: number;
  /** 归档URL */
  archiveUrl: string | null;
  /** 版本 */
  version: string | null;
  /** 仓库地址 */
  repository: string;
  /** 模型名称 */
  modelName: string | null;
  /** 允许的工具 */
  allowedTools: string | null;
  /** 下载量 */
  download: number;
  /** API下载量 */
  apiDownload: number;
  /** 收藏数 */
  favor: number;
  /** 浏览量 */
  view: number;
  /** 创建时间 */
  createTime: string;
  /** 更新时间 */
  updateTime: string;
  /** 作者 */
  author: string | null;
  /** 来源URL */
  sourceUrl: string | null;
  /** 总体评分 */
  overallScore: string;
  /** 实用性评分 */
  utilityScore: string;
  /** 安全性评分 */
  securityScore: string;
  /** 是否收藏 */
  favorTag: boolean;
  /** 部署状态 */
  deployStatus: string | null;
  /** 组织 */
  organization: string | null;
  /** 是否可编辑 */
  canEdit: boolean;
  /** 标签列表 */
  tags: SkillTag[];
  /** 扫描是否成功 */
  scanSuccess: boolean;
  /** 是否存在 */
  exist: boolean;
}

/**
 * Skills API 响应数据
 */
export interface SkillsData {
  /** 总数 */
  count: number;
  /** 技能列表 */
  list: Skill[];
}

/**
 * Skills API 响应
 */
export type SkillsResponse = MatrixApiResponse<SkillsData>;

/**
 * 校验和数据
 */
export interface ChecksumData {
  /** 英文名称 */
  enName: string;
  /** SHA256 哈希值 */
  sha256: string;
  /** 文件大小（字节） */
  size: number;
  /** 创建时间 */
  createTime: string;
}

/**
 * Checksum API 响应
 */
export type ChecksumResponse = MatrixApiResponse<ChecksumData>;

/**
 * 技能操作结果（统一接口）
 * 用于表示安装、移除等操作的结果
 */
export interface SkillOperationResult {
  /** 是否成功 */
  success: boolean;
  /** 实际安装方式；跳过安装时省略。 */
  mode?: 'symlink' | 'copy';
  path?: string;
  reason?: string;
  fallbackReason?: string;
  /** 是否跳过（已存在或不存在） */
  skipped?: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * 安装目标（封装 agents、projectAgents 和 customPath）
 */
export interface InstallationTargets {
  /** 是否由 --agent 显式选择；缺省 API 调用按显式选择处理。 */
  explicitAgents?: boolean;
  /** 全局 agent 列表 */
  agents: string[];
  /** 项目级 agent 列表 */
  projectAgents: Array<{ project: string; agent: string }>;
  /** 自定义路径 */
  customPath?: string;
}

export interface AddOptions {
  readonly all?: boolean;
  readonly agent?: string;
  readonly skill?: string;
  readonly force?: boolean;
  readonly project?: string;
  readonly path?: string;
}

export interface RemoveOptions {
  readonly skill?: string;
  readonly agent?: string;
  readonly project?: string;
  readonly path?: string;
}

export interface InitOptions {
  readonly agent?: string;
  readonly project?: string;
  /** Target directory path for skill installation (mutually exclusive with --project and --agent) */
  readonly path?: string;
  readonly force?: boolean;
  /** Configure MCP server for syntax checking (no skill installation) */
  readonly mcp?: boolean;
  /** Install skill only (same as default behavior, explicit for symmetry with --mcp) */
  readonly skill?: boolean;
}
