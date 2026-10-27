/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { mcpLog } from '../utils/mcp-logger.js';

/** C++ LSP 工具（CppCheckTool / ClangdLspTool）统一返回类型。 */
export type CppToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

/** LSP 未就绪时的统一返回。 */
export function buildNotReadyResponse(): CppToolResult {
  return {
    content: [{ type: 'text', text: 'C++ LSP is not ready, please retry later' }],
    isError: true,
  };
}

/** 统一错误响应构造。 */
export function buildErrorResponse(label: string, err: unknown): CppToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  mcpLog.error(`[CppLsp] ${label} failed: ${msg}`);
  return {
    content: [{ type: 'text', text: `${label} failed: ${msg}` }],
    isError: true,
  };
}
