/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// 认证相关常量
export {
  AppConfig,
  DEFAULT_LOGIN_CONFIG,
  ApiEndpoints,
  CryptoConstants,
} from '../auth/auth-config';

// 网络相关常量
export { TimeConstants, NetworkConstants } from './network';

// Skills 相关常量
export { SkillsApiConstants, AGENT_SKILLS_CONFIG } from './skills';

// MCP 相关常量
export {
  MCP_SERVER_NAME,
  AGENT_MCP_CONFIG,
  buildMcpServerConfig,
  buildOpenCodeMcpConfig,
  buildMcpConfigForAgent,
} from './mcp';

// 项目相关常量，用于 CLI 和 MCP 共享
export { ProjectConstants } from './project';

// IDE 下载路径
export const IDE_DOWNLOAD_URL = 'https://developer.huawei.com/consumer/cn/download/';


