/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  inferCppLanguageId,
  isSupportedCppFile,
  toFileUri,
} from '../utils/common.js';
import { ClangdLspManager } from '../lsp/ClangdLspManager.js';
import { buildNotReadyResponse, type CppToolResult } from './cpp-lsp-shared.js';

/** 诊断等待间隔（ms），避免并发压垮 clangd。 */
const CHECK_FILE_GAP_MS = 500;

/**
 * CppCheckTool — `check` MCP 工具适配器（仅诊断）。
 *
 * 仅承载 `deveco-mcp_check` 工具的行为：对 C/C++ 文件做静态语法检查，
 * 通过 clangd `publishDiagnostics` push → waiter 模式获取诊断结果。
 *
 * 生命周期（spawn clangd / initialize / dispose）由 {@link ClangdLspManager} 自管，
 * 本类不再持有生命周期；构造时接收 server 持有的 manager 实例。位置类语言特性
 * （hover/definition/.../callHierarchy）见 {@link ClangdLspTool}。
 */
export class CppCheckTool {
  private readonly manager: ClangdLspManager;

  constructor(manager: ClangdLspManager) {
    this.manager = manager;
  }

  static getToolDefinition() {
    return {
      name: 'check_cpp_files',
      description:
        'Perform static syntax checks on the provided C/C++ files and return clangd diagnostics.',
      inputSchema: z.object({
        files: z
          .array(z.string())
          .describe(
            'List of C/C++ file paths to check, format: ["file1.cpp","file2.hpp",...]',
          ),
      }),
    };
  }

  /**
   * 处理来自 MCP 的 check 工具调用。
   */
  async handleCall(args: {
    files: string[];
  }): Promise<CppToolResult> {
    if (!this.manager.ready) {
      return buildNotReadyResponse();
    }

    const errors: string[] = [];
    const infoMsgs: string[] = [];

    const validFiles = this.collectValidFiles(args.files, errors);
    if (validFiles.length === 0) {
      const text = errors.length > 0 ? errors.join('\n') : 'No valid C/C++ files';
      return { content: [{ type: 'text', text }], isError: true };
    }

    for (const file of validFiles) {
      await sleep(CHECK_FILE_GAP_MS);
      try {
        const result = await this.checkFile(file);
        infoMsgs.push(formatDiagnosticResult(file, result));
      } catch (err) {
        errors.push(`${file} => wait for diagnostics failed: ${(err as Error).message}`);
      }
    }

    const isError = errors.length > 0;
    const parts: string[] = [];
    if (errors.length > 0) {
      parts.push(errors.join('\n'));
    }
    if (infoMsgs.length > 0) {
      parts.push(infoMsgs.join('\n'));
    }
    let content = parts.join('\n').trim();
    if (!isError && infoMsgs.length === 0) {
      content = 'No diagnostic information collected';
    }
    return { content: [{ type: 'text', text: content }], isError };
  }

  /**
   * 对单个文件进行诊断检查。通过 publishDiagnostics push → waiter 模式获取诊断结果。
   * 时序：注册 waiter → didOpen → await diagnostics → didClose。
   */
  private async checkFile(filePath: string): Promise<unknown> {
    const uri = toFileUri(filePath);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const languageId = inferCppLanguageId(filePath);

    // 注册诊断 waiter（必须在 didOpen 之前，否则 clangd 推送的 diagnostics 会丢失）
    const diagPromise = this.manager.registerDiagnosticCallback(uri);

    this.manager.sendNotification({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, text: content, languageId, version: content.length },
      },
    });

    try {
      return await diagPromise;
    } finally {
      this.manager.sendNotification({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      });
    }
  }

  /** 把入参里的路径解析为绝对路径，过滤出存在且为 C/C++ 的文件。 */
  private collectValidFiles(files: string[], errors: string[]): string[] {
    const workspace = path.resolve(this.manager.projectRoot);
    const valid: string[] = [];
    for (const fileArg of files) {
      const resolved = path.resolve(path.isAbsolute(fileArg) ? fileArg : path.join(workspace, fileArg));

      if (!fs.existsSync(resolved)) {
        errors.push(`File does not exist: ${fileArg}`);
        continue;
      }
      if (!fs.statSync(resolved).isFile()) {
        errors.push(`Not a regular file: ${fileArg}`);
        continue;
      }
      if (!isSupportedCppFile(resolved)) {
        errors.push(`Not a supported C/C++ file: ${fileArg}`);
        continue;
      }
      try {
        valid.push(fs.realpathSync(resolved));
      } catch {
        valid.push(resolved);
      }
    }
    return valid;
  }
}

/** 把 checkFile 的返回值格式化为单行人类可读字符串。 */
function formatDiagnosticResult(file: string, result: unknown): string {
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return `${file} => no diagnostics`;
    }
    return `${file} => Diagnostic: ${JSON.stringify(result)}`;
  }
  if (
    result &&
    typeof result === 'object' &&
    typeof (result as { errorMessage?: unknown }).errorMessage === 'string'
  ) {
    const errorMessage = (result as { errorMessage: string }).errorMessage;
    return `${file} diagnostic failed, error_message: ${errorMessage}`;
  }
  return `${file} => diagnostic failed, result: ${JSON.stringify(result)}`;
}

/** 简易 sleep 工具。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
