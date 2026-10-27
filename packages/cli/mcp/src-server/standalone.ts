/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// Separate bundle entry: `serve mcp` loads this lazily so the stdio MCP server
// and its schema-validation stack stay out of every other command's startup.
export { createMcpServer } from './server.js';
export type { McpServerConfig } from './server.js';
