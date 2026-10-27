/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { httpClient } from '../utils/http-client.js';
import type { HttpResponse } from '../types/http.js';
import { SkillsApiConstants } from '../config/constants.js';
import { assertSafeSkillName } from './skill-name.js';
import {
  getAgentNames,
  getAgentEntry,
  getNativeSkillsDir,
  isAgentInstalled,
} from './agent-registry.js';
import type {
  TagsResponse,
  SkillsResponse,
  Skill,
  ChecksumData,
  ChecksumResponse,
} from '../types/skills.js';

// 需要排除的标签名称数组（DevEco标签的技能有冲突）
const EXCLUDED_TAG_NAMES: readonly string[] = ['DevEco'];

/**
 * 获取需要的标签 ID 列表（仅 HMOS）
 * 通过 Tags API 查询所有标签，返回匹配标签的 ID 列表
 * @returns 标签 ID 数组
 * @throws 如果 API 调用失败或找不到任何标签
 */
export async function fetchTagIds(): Promise<string[]> {
  // 调用 Tags API 获取标签列表
  const response = await httpClient.get(SkillsApiConstants.TAGS_API_URL);

  // 验证并解析响应
  const data = validateApiResponse<TagsResponse>(response, 'Tags API');

  // 在标签列表中查找 HMOS 标签
  const requiredTags = data.data.skill.filter((tag) => tag.name === 'HMOS');

  if (requiredTags.length === 0) {
    throw new Error('No HMOS tag found.');
  }

  return requiredTags.map((tag) => tag.id);
}

/**
 * 获取单个标签的所有技能（自动翻页）
 * @param tagId - 标签 ID
 * @returns 该标签下的所有技能数组
 * @throws 如果 API 调用失败
 */
async function fetchSkillsForTag(tagId: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const pageSize = SkillsApiConstants.DEFAULT_PAGE_SIZE;
  const maxPages = SkillsApiConstants.DEFAULT_MAX_PAGES;
  let pageNum = 1;

  while (pageNum <= maxPages) {
    // 发送 POST 请求
    const response = await httpClient.post(SkillsApiConstants.SKILLS_API_URL, {
      headers: {
        'Content-Type': 'application/json',
      },
      params: {
        pageNum,
        pageSize,
        tagIds: [tagId],
      },
    });

    // 验证并解析响应
    const data = validateApiResponse<SkillsResponse>(response, 'Skills API');

    // 将当前页的技能添加到数组
    skills.push(...data.data.list);

    // 如果当前页数据少于页大小，说明已经是最后一页
    if (data.data.list.length < pageSize) {
      break;
    }

    pageNum++;
  }

  return skills;
}

/**
 * 获取所有技能
 * 通过 Skills API 分别获取每个标签下的所有技能，并合并去重
 * 同时过滤掉包含 DevEco 标签的技能
 * @param tagIds - 标签 ID 数组
 * @returns 所有技能数组（根据 id 去重，且不包含 DevEco 标签）
 * @throws 如果 API 调用失败
 */
export async function fetchAllSkills(tagIds: string[]): Promise<Skill[]> {
  const skillMap = new Map<string, Skill>();

  const fetchPromises = tagIds.map((tagId) => fetchSkillsForTag(tagId));
  const allTagSkills = await Promise.all(fetchPromises);

  for (const tagSkills of allTagSkills) {
    for (const skill of tagSkills) {
      if (!skillMap.has(skill.id)) {
        skillMap.set(skill.id, skill);
      }
    }
  }

  return Array.from(skillMap.values()).filter((skill) =>
    skill.tags?.every((tag) => !EXCLUDED_TAG_NAMES.includes(tag.name))
  );
}

/**
 * 在单个标签中搜索技能
 * @param keyword - 搜索关键词
 * @param tagId - 标签 ID
 * @returns 该标签下匹配的技能数组
 * @throws 如果 API 调用失败
 */
async function searchSkillsInTag(
  keyword: string,
  tagId: string
): Promise<Skill[]> {
  // 发送 POST 请求
  const response = await httpClient.post(SkillsApiConstants.SKILLS_API_URL, {
    headers: {
      'Content-Type': 'application/json',
    },
    params: {
      pageNum: 1,
      pageSize: SkillsApiConstants.DEFAULT_PAGE_SIZE,
      keyword,
      tagIds: [tagId],
    },
  });

  // 验证并解析响应
  const data = validateApiResponse<SkillsResponse>(response, 'Skills API');

  return data.data.list;
}

/**
 * 搜索技能
 * 通过 Skills API 分别在每个标签下搜索匹配关键词的技能，并合并去重
 * 同时过滤掉包含 DevEco 标签的技能
 * @param keyword - 搜索关键词
 * @param tagIds - 标签 ID 数组
 * @returns 匹配的技能数组（根据 id 去重，且不包含 DevEco 标签）
 * @throws 如果 API 调用失败
 */
export async function searchSkills(
  keyword: string,
  tagIds: string[]
): Promise<Skill[]> {
  const skillMap = new Map<string, Skill>();

  const searchPromises = tagIds.map((tagId) =>
    searchSkillsInTag(keyword, tagId)
  );
  const allTagSkills = await Promise.all(searchPromises);

  for (const tagSkills of allTagSkills) {
    for (const skill of tagSkills) {
      if (!skillMap.has(skill.id)) {
        skillMap.set(skill.id, skill);
      }
    }
  }

  return Array.from(skillMap.values()).filter((skill) =>
    skill.tags?.every((tag) => !EXCLUDED_TAG_NAMES.includes(tag.name))
  );
}

/**
 * 获取已安装指定 skill 的 agent 列表
 * 遍历所有 agent 配置，检查每个 agent 的 skills 目录下是否存在指定的 skill
 * @param skillName - skill 名称
 * @returns 已安装该 skill 的 agent 显示名称数组（按字母排序）
 */
export function getInstalledAgents(skillName: string): string[] {
  assertSafeSkillName(skillName);
  const installedAgents: string[] = [];

  // 遍历所有 agent 配置
  for (const agent of getAgentNames()) {
    const dir = getNativeSkillsDir(agent);
    if (!isAgentInstalled(agent)) {
      continue;
    }
    // 构建完整的 skill 路径
    const skillPath = path.join(dir, skillName);

    // 检查该路径是否存在
    if (fs.existsSync(skillPath)) {
      installedAgents.push(getAgentEntry(agent).displayName);
    }
  }

  // 按字母排序后返回
  return installedAgents.sort();
}

/**
 * API 响应基础接口
 * 所有 API 响应都应包含 code 和 message 字段
 */
interface ApiResponseBase {
  code: string;
  message: string;
}

/**
 * 验证 API 响应
 * 统一处理 HTTP 状态码检查和业务响应码检查
 * @param response HTTP 响应
 * @param apiName API 名称（用于错误消息）
 * @returns 解析后的 JSON 数据
 * @throws 如果 HTTP 状态码或业务响应码不符合预期
 */
export function validateApiResponse<T extends ApiResponseBase>(
  response: HttpResponse,
  apiName: string
): T {
  // 检查 HTTP 响应状态
  if (response.statusCode !== 200) {
    throw new Error(`${apiName} Request failed: HTTP ${response.statusCode}`);
  }

  // 解析响应数据
  const data: T = httpClient.parseJson<T>(response);

  // 检查业务响应码
  if (data.code !== SkillsApiConstants.SUCCESS_CODE) {
    throw new Error(
      `${apiName} Error returned: ${data.code} - ${data.message}`
    );
  }

  return data;
}

/**
 * 获取技能的校验和信息
 * 通过 Checksum API 获取指定技能的 SHA256 哈希值和文件大小
 * @param skillName - 技能名称
 * @returns 校验和数据
 * @throws 如果 API 调用失败或数据格式不正确
 */
export async function fetchSkillChecksum(
  skillName: string
): Promise<ChecksumData> {
  assertSafeSkillName(skillName);

  // 构建 Checksum API URL
  const url = `${SkillsApiConstants.SKILL_API_BASE}/${skillName}/checksum`;

  // 调用 Checksum API 获取校验和信息
  const response = await httpClient.get(url);

  // 验证并解析响应
  const data = validateApiResponse<ChecksumResponse>(response, 'Checksum API');

  return data.data;
}
