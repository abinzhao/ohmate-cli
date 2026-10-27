/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export { DevecoCliMcpServer, createMcpServer } from './server.js';
export type { McpServerConfig } from './server.js';
export { ArktsCheckTool, CppCheckTool, ClangdLspTool } from './tools/index.js';
export { ToolRouter, createToolRouter } from './router.js';
export type { ToolDefinition, ToolHandler, RegisteredTool } from './router.js';