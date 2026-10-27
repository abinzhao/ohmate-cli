/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  inferCppLanguageId,
  isSupportedCppFile,
  toFileUri,
} from '../utils/common.js';
import { mcpLog } from '../utils/mcp-logger.js';
import { ClangdLspManager } from '../lsp/ClangdLspManager.js';
import { LSP_METHOD } from '../lsp/constant.js';
import { buildNotReadyResponse, buildErrorResponse, type CppToolResult } from './cpp-lsp-shared.js';

/** C++ 位置类语言特性集合。 */
export type CppLspFeature = 'hover' | 'definition' | 'declaration' | 'references' | 'implementation';

/**
 * ClangdLspTool — C++ 位置类语言特性工具适配器。
 *
 * 承载除 `check` 外的 C++ MCP 工具行为：
 * - {@link handleLspFeature} 位置类（hover/definition/declaration/references/implementation）
 * - {@link handleWorkspaceSymbol} / {@link handleWorkspaceSymbolRaw} 全工程符号
 * - {@link handleDocumentSymbol} 单文件符号树
 * - {@link handleCallHierarchy} 调用层级（incoming only；outgoing 返回明确错误）
 *
 * 与 {@link CppCheckTool} 同为 {@link ClangdLspManager} 的无状态适配器，
 * 构造时接收 server 持有的 manager 实例。生命周期由 manager 自管。
 */
export class ClangdLspTool {
  private readonly manager: ClangdLspManager;

  /** feature → LSP method 映射（仅 clangd 支持的位置类特性）。 */
  private static readonly FEATURE_METHOD_MAP: Record<CppLspFeature, string> = {
    hover: LSP_METHOD.HOVER,
    definition: LSP_METHOD.DEFINITION,
    declaration: LSP_METHOD.DECLARATION,
    references: LSP_METHOD.REFERENCES,
    implementation: LSP_METHOD.IMPLEMENTATION,
  };

  constructor(manager: ClangdLspManager) {
    this.manager = manager;
  }

  /**
   * 统一的语言特性请求入口（位置类，params = {textDocument, position}）。
   * 覆盖：hover / definition / declaration / references / implementation。
   * 生命周期：didOpen → send request → await response → didClose。
   */
  async handleLspFeature(
    feature: CppLspFeature,
    args: { file: string; line: number; character: number },
  ): Promise<CppToolResult> {
    if (!this.manager.ready) {
      return buildNotReadyResponse();
    }

    const resolved = this.resolveSingleFile(args.file);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `File does not exist or is not a C/C++ file: ${args.file}` }],
        isError: true,
      };
    }

    const method = ClangdLspTool.FEATURE_METHOD_MAP[feature];
    if (!method) {
      return { content: [{ type: 'text', text: `Unknown feature: ${feature}` }], isError: true };
    }

    mcpLog.info(`[ClangdLspTool] handleLspFeature: ${feature} file=${resolved} line=${args.line} char=${args.character}`);

    try {
      const result = await this.withOpenFile(resolved, async (uri) => {
        const params: Record<string, unknown> = {
          textDocument: { uri },
          position: { line: args.line, character: args.character },
        };
        if (feature === 'references') {
          params.context = { includeDeclaration: true };
        }
        return this.manager.sendFeatureRequest(method, params);
      });
      const text = result == null
        ? `${feature}: no result`
        : `${feature}: ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return buildErrorResponse(feature, err);
    }
  }

  /**
   * workspaceSymbol 的结构化版本（供 server 层合并 ArkTS + C++ 结果用）。
   * 返回 SymbolInformation[] | null（null 表示无结果或出错）。
   */
  async handleWorkspaceSymbolRaw(
    query: string,
  ): Promise<unknown[] | null> {
    if (!this.manager.ready) {
      return null;
    }
    try {
      const result = await this.manager.sendFeatureRequest(
        LSP_METHOD.WORKSPACE_SYMBOL,
        { query },
      );
      if (Array.isArray(result)) {
        return result;
      }
      if (result == null) {
        return null;
      }
      return [result];
    } catch (err) {
      mcpLog.error(`[ClangdLspTool] handleWorkspaceSymbolRaw failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * documentSymbol：获取单个文件内的符号树（函数/类/变量列表 + range）。
   */
  async handleDocumentSymbol(file: string): Promise<CppToolResult> {
    if (!this.manager.ready) {
      return buildNotReadyResponse();
    }
    const resolved = this.resolveSingleFile(file);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `File does not exist or is not a C/C++ file: ${file}` }],
        isError: true,
      };
    }
    mcpLog.info(`[ClangdLspTool] handleDocumentSymbol: file=${resolved}`);
    try {
      const result = await this.withOpenFile(resolved, async (uri) => {
        return this.manager.sendFeatureRequest(
          LSP_METHOD.DOCUMENT_SYMBOL,
          { textDocument: { uri } },
        );
      });
      const text = result == null
        ? 'documentSymbol: no result'
        : `documentSymbol: ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return buildErrorResponse('documentSymbol', err);
    }
  }

  /**
   * callHierarchy：查询函数调用关系。
   * incoming: prepareCallHierarchy → incomingCalls
   * outgoing: clangd 不支持，返回明确错误。
   */
  async handleCallHierarchy(
    args: { file: string; line: number; character: number; direction: 'incoming' | 'outgoing' },
  ): Promise<CppToolResult> {
    if (!this.manager.ready) {
      return buildNotReadyResponse();
    }

    if (args.direction === 'outgoing') {
      return {
        content: [{ type: 'text', text: 'callHierarchy outgoing is not supported by clangd (incoming only)' }],
        isError: true,
      };
    }

    const resolved = this.resolveSingleFile(args.file);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `File does not exist or is not a C/C++ file: ${args.file}` }],
        isError: true,
      };
    }

    mcpLog.info(`[ClangdLspTool] handleCallHierarchy: file=${resolved} line=${args.line} char=${args.character} direction=${args.direction}`);

    try {
      const result = await this.withOpenFile(resolved, (uri) => this.fetchCallHierarchyResult(uri, args));
      const text = `callHierarchy (${args.direction}): ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return buildErrorResponse('callHierarchy', err);
    }
  }

  // ---------- 私有辅助 ----------

  /** 执行 prepareCallHierarchy 并归一化结果后收集所有 incoming calls。 */
  private async fetchCallHierarchyResult(
    uri: string,
    args: { line: number; character: number },
  ): Promise<{ items: unknown[]; calls: unknown[] }> {
    const prepareResult = await this.manager.sendFeatureRequest(
      LSP_METHOD.PREPARE_CALL_HIERARCHY,
      { textDocument: { uri }, position: { line: args.line, character: args.character } },
    );
    const items = this.normalizeCallHierarchyItems(prepareResult);
    if (items.length === 0) {
      return { items: [], calls: [] };
    }
    const allCalls = await this.collectIncomingCalls(items);
    return { items, calls: allCalls };
  }

  /** 将 prepareCallHierarchy 返回值归一化为数组（数组 / 单值 / 空）。 */
  private normalizeCallHierarchyItems(prepareResult: unknown): unknown[] {
    if (Array.isArray(prepareResult)) {
      return prepareResult;
    }
    if (prepareResult) {
      return [prepareResult];
    }
    return [];
  }

  /** 遍历所有 prepareCallHierarchy item 并汇总 incoming calls。 */
  private async collectIncomingCalls(items: unknown[]): Promise<unknown[]> {
    const allCalls: unknown[] = [];
    for (const item of items) {
      allCalls.push(...(await this.fetchIncomingCalls(item)));
    }
    return allCalls;
  }

  /** 收集单个 prepareCallHierarchy item 的 incoming calls（统一处理数组 / 单值 / 空）。 */
  private async fetchIncomingCalls(item: unknown): Promise<unknown[]> {
    const calls = await this.manager.sendFeatureRequest(LSP_METHOD.INCOMING_CALLS, { item });
    if (Array.isArray(calls)) {
      return calls;
    }
    if (calls) {
      return [calls];
    }
    return [];
  }

  /**
   * 打开文件 → 执行 action → 关闭文件。
   * didOpen/didClose 生命周期保证 clangd 上下文一致。
   */
  private async withOpenFile<T>(
    filePath: string,
    action: (uri: string) => Promise<T>,
  ): Promise<T> {
    const uri = toFileUri(filePath);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const languageId = inferCppLanguageId(filePath);

    mcpLog.info(`[ClangdLspTool] withOpenFile didOpen uri=${uri} langId=${languageId} len=${content.length}`);
    this.manager.sendNotification({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, text: content, languageId, version: content.length },
      },
    });
    try {
      return await action(uri);
    } finally {
      this.manager.sendNotification({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      });
    }
  }

  /** 解析单个文件路径，返回绝对路径或 null。 */
  private resolveSingleFile(fileArg: string): string | null {
    const resolved = path.isAbsolute(fileArg)
      ? fileArg
      : path.join(this.manager.projectRoot, fileArg);
    if (!fs.existsSync(resolved)) {
      return null;
    }
    if (!fs.statSync(resolved).isFile()) {
      return null;
    }
    if (!isSupportedCppFile(resolved)) {
      return null;
    }
    return resolved;
  }
}
