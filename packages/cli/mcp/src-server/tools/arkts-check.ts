/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  cleanupOldSiblingDirs,
  detectStandardProtocol,
  findHarmonyProject,
  getMcpLogDirectory,
  getRequestId,
  normalizePath,
  sleep,
  toFileUri,
} from '../utils/common.js';
import { mcpLog } from '../utils/mcp-logger.js';
import { ArktsLspManager } from '../lsp/ArktsLspManager.js';
import { initializeLogger } from '../lsp/logger.js';
import { toUnixPath } from '../lsp/utils.js';
import { LSP_INIT_TIMEOUT_MS, LSP_METHOD, ACE_SERVER_METHOD } from '../lsp/constant.js';
import type { LspMessage } from '../lsp/types.js';

const INDEX_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // index 目录最大保留 7 天
const LOG_DIR_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // log 目录最大保留 5 天
/** legacy 模式下等待 publishDiagnostics 的超时（与老版本一致 2 分钟）。 */
const DIAGNOSTIC_TIMEOUT_MS = 2 * 60 * 1000;

type DiagnosticWaiter = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class ArktsCheckTool {
  private manager: ArktsLspManager | null = null;

  /** ace-server 子进程 pid；manager 未初始化时为 null。 */
  public get aceServerPid(): number | null {
    return this.manager?.aceServerPid ?? null;
  }

  private initialized: boolean = false;
  private initializing: boolean = false;
  private initPromise: Promise<void> | null = null;
  private initDeadlineTimer: NodeJS.Timeout | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((err: Error) => void) | null = null;

  private projectPath: string;
  /** 启动期固定 sdkPath（env / CLT|Studio 布局），全流程共用 */
  private sdkPath: string;
  /** 启动期固定 arkts-lang-server 路径（env / CLT|Studio 布局），ace-server 入口由其派生 */
  private arktsLangServerPath: string | null;
  /** 启动期固定 node 可执行文件路径（工具链 bundled node） */
  private nodePath?: string;
  private nodeMaxOldSpaceSize?: string;
  /** 配置文件变化回调，透传给 ArktsLspManager，由 server 层设置 needsResync 标志位 */
  private onConfigChangedCallback: (() => void) | null = null;
  /** LSP 初始化进度回调，由 server 层设置，handleLspMessage 收到进度通知时调用 */
  private onInitProgress: ((detail: string, percent: number | null) => void) | null = null;
  /** dep-parse 进度回调，由 server 层设置，doInitialize 传给 manager.start() */
  private onDepParseProgress: ((current: number, total: number) => void) | null = null;
  /** 是否使用标准 LSP 协议（doInitialize 时按 standardIndex/index.js 存在性设置）。 */
  private useStandardProtocol: boolean = true;
  /** 是否使用 socket 传输（启动期由 server 层 --list-protocols 探测后注入，本类不再自行探测）。 */
  private readonly useSocket: boolean;
  /** legacy 模式：按 uri 等待 publishDiagnostics 的 waiter。 */
  private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter>();
  /** didOpen 文档版本号，每次发送递增，保证 LSP server 感知文件内容更新。 */
  private documentVersion = 0;

  /** feature 名称 → LSP method 字符串的映射（解决 camelCase → UPPER_SNAKE_CASE 不匹配） */
  private static readonly FEATURE_METHOD_MAP: Record<string, string> = {
    hover: LSP_METHOD.HOVER,
    definition: LSP_METHOD.DEFINITION,
    declaration: LSP_METHOD.DECLARATION,
    references: LSP_METHOD.REFERENCES,
    implementation: LSP_METHOD.IMPLEMENTATION,
    completion: LSP_METHOD.COMPLETION,
    signatureHelp: LSP_METHOD.SIGNATURE_HELP,
    documentHighlight: LSP_METHOD.DOCUMENT_HIGHLIGHT,
  };

  constructor(
    projectPath: string,
    sdkPath: string,
    arktsLangServerPath: string | null,
    nodeMaxOldSpaceSize?: string,
    nodePath?: string,
    useSocket: boolean = false
  ) {
    this.projectPath = projectPath;
    this.sdkPath = sdkPath;
    this.arktsLangServerPath = arktsLangServerPath;
    this.nodeMaxOldSpaceSize = nodeMaxOldSpaceSize;
    this.nodePath = nodePath;
    this.useSocket = useSocket;
  }

  /** 注册配置文件变化回调，透传给 ArktsLspManager */
  setOnConfigChanged(callback: () => void): void {
    this.onConfigChangedCallback = callback;
  }

  /** 注册 LSP 初始化进度回调（handleLspMessage 收到进度通知时调用） */
  setOnInitProgress(callback: (detail: string, percent: number | null) => void): void {
    this.onInitProgress = callback;
  }

  /** 注册 dep-parse 进度回调（doInitialize 传给 manager.start()） */
  setOnDepParseProgress(callback: (current: number, total: number) => void): void {
    this.onDepParseProgress = callback;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initializing = true;
    this.initPromise = this.doInitialize()
      .then(() => {
        this.initialized = true;
      })
      .finally(() => {
        this.initializing = false;
      });
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const { harmonyRoot, arktsLangServerPath, useStandardProtocol } =
      this.resolveProjectAndDeveco();
    this.useStandardProtocol = useStandardProtocol;

    const normalizedProjectRoot = normalizePath(harmonyRoot);
    const { logPath, indexPath } = this.getLogAndIndexPath(normalizedProjectRoot);

    // 异步清理过期 index 和 log 目录
    setImmediate(() => {
      cleanupOldSiblingDirs(indexPath, INDEX_DIR_MAX_AGE_MS, '[ArkTS-Check]');
      cleanupOldSiblingDirs(logPath, LOG_DIR_MAX_AGE_MS, '[ArkTS-Check]');
    });

    // 把 logPath 注册给 lsp 内部的 logger（仅用于供 ace-server 子进程作为 --logger-path）。
    initializeLogger(logPath);

    const parsedMaxSize = this.nodeMaxOldSpaceSize
      ? parseInt(this.nodeMaxOldSpaceSize, 10)
      : NaN;
    const nodeMaxOldSpaceSize = Number.isNaN(parsedMaxSize) ? undefined : parsedMaxSize;
    mcpLog.info(`ArktsCheck nodeMaxOldSpaceSize: incoming='${this.nodeMaxOldSpaceSize ?? '(unset)'}', parsed=${nodeMaxOldSpaceSize ?? 'undefined → dynamic formula applies'}`);

    // sdkPath 与 arktsLangServerPath 均在启动期固定，此处直接复用，不再派生。
    const sdkPath = this.sdkPath;
    mcpLog.info(`[ArktsCheck] sdkPath=${sdkPath}, arktsLangServerPath=${arktsLangServerPath}, useStandardProtocol=${useStandardProtocol}, useSocket=${this.useSocket}`);
    this.manager = new ArktsLspManager({
      sdkPath,
      arktsLangServerPath,
      workspaceRoot: toUnixPath(normalizedProjectRoot),
      indexLogPath: indexPath,
      nodeMaxOldSpaceSize,
      useStandardProtocol,
      nodePath: this.nodePath,
      useSocket: this.useSocket,
    });
    this.manager.setOnMessage((msg) => this.handleLspMessage(msg));
    if (this.onConfigChangedCallback) {
      this.manager.setOnConfigChanged(this.onConfigChangedCallback);
    }

    await new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      this.armInitTimer(LSP_INIT_TIMEOUT_MS);
      // start() 内部异步触发 arkts/initialized 或 arkts/initializationFailed
      this.manager!.start([], this.onDepParseProgress ?? undefined).catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        this.failInit(e);
      });
    });
  }

  /** 校验 / 规范化 projectPath；arktsLangServerPath 由启动期固定值提供。 */
  private resolveProjectAndDeveco(): {
    harmonyRoot: string;
    arktsLangServerPath: string;
    useStandardProtocol: boolean;
  } {
    const harmonyRoot = findHarmonyProject(this.projectPath);
    if (!harmonyRoot) {
      throw new Error(
        `Failed to find HarmonyOS project from path: ${this.projectPath}`
      );
    }
    this.projectPath = harmonyRoot;

    const arktsLangServerPath = this.arktsLangServerPath;
    if (!arktsLangServerPath) {
      throw new Error('arkts-lang-server path not found');
    }

    const useStandardProtocol = detectStandardProtocol(arktsLangServerPath);
    return { harmonyRoot, arktsLangServerPath, useStandardProtocol };
  }

  private armInitTimer(ms: number): void {
    if (this.initDeadlineTimer) {
      clearTimeout(this.initDeadlineTimer);
    }
    this.initDeadlineTimer = setTimeout(() => {
      const reject = this.initReject;
      this.clearInitHandlers();
      reject?.(new Error('LSP initialize timeout'));
    }, ms);
  }

  private clearInitHandlers(): void {
    if (this.initDeadlineTimer) {
      clearTimeout(this.initDeadlineTimer);
      this.initDeadlineTimer = null;
    }
    this.initResolve = null;
    this.initReject = null;
  }

  private failInit(err: Error): void {
    const reject = this.initReject;
    this.clearInitHandlers();
    reject?.(err);
  }

  /**
   * 对单个文件进行诊断检查。通过标准 LSP textDocument/diagnostic
   * 拉取式请求获取诊断结果，返回 diagnostics 数组。
   */
  async checkFile(filePath: string): Promise<unknown> {
    if (!this.initialized) {
      await this.initialize();
    }
    const manager = this.manager;
    if (!manager) {
      throw new Error('ArktsLspManager not initialized');
    }

    const sendUri = toFileUri(filePath);

    const content = await fs.promises.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).replace(/^\./, '');
    const languageId = `deveco.apptool.${ext || 'plaintext'}`;

    if (manager.useStandardProtocol) {
      return this.checkFileStandard(manager, sendUri, content, languageId);
    }
    return this.checkFileLegacy(manager, filePath, sendUri, content, languageId);
  }

  private async checkFileStandard(
    manager: ArktsLspManager,
    sendUri: string,
    content: string,
    languageId: string,
  ): Promise<unknown> {
    mcpLog.debug(`textDocument/didOpen uri=${sendUri} content_len=${content.length}`);
    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri: sendUri, text: content, languageId, version: ++this.documentVersion },
    });
    try {
      mcpLog.debug(`textDocument/diagnostic uri=${sendUri}`);
      const result = await manager.diagnostic({ textDocument: { uri: sendUri } });
      return extractDiagnosticItems(result);
    } finally {
      this.sendNotification('textDocument/didClose', { textDocument: { uri: sendUri } });
    }
  }

  /** legacy：publish-wait（didOpen onAsyncOpenFile → 等 publishDiagnostics → didClose）。 */
  private async checkFileLegacy(
    manager: ArktsLspManager,
    filePath: string,
    sendUri: string,
    content: string,
    languageId: string,
  ): Promise<unknown> {
    const key = sendUri;
    manager.registerDiagnosticCallback(sendUri);
    const diagnosticsPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.diagnosticWaiters.delete(key)) {
          reject(new Error('Wait for diagnostics timeout'));
        }
      }, DIAGNOSTIC_TIMEOUT_MS);
      this.diagnosticWaiters.set(key, { resolve, reject, timer });
    });
    mcpLog.debug(`textDocument/didOpen(legacy) uri=${sendUri} content_len=${content.length}`);
    manager.onAsyncOpenFile({
      textDocument: { uri: sendUri, text: content, languageId, version: content.length },
      editorFiles: [sendUri],
      isFromEditor: false,
    });
    try {
      return await diagnosticsPromise;
    } finally {
      manager.closeFileLegacy(sendUri, false);
    }
  }

  /**
   * 处理来自 MCP 的工具调用。
   */
  async handleCall(args: {
    files: string[];
  }): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (!this.initialized) {
      return this.buildNotReadyResponse();
    }

    const errors: string[] = [];
    const infoMsgs: string[] = [];

    const validFiles = this.collectValidFiles(args.files, errors);
    if (validFiles.length === 0) {
      const text = errors.length > 0 ? errors.join('\n') : 'No valid .ets files';
      return {
        content: [{ type: 'text', text }],
        isError: true,
      };
    }

    await this.runDiagnosticsForFiles(validFiles, errors, infoMsgs);
    return this.formatCallResult(errors, infoMsgs);
  }

  /**
   * 统一的语言特性请求入口（位置类，params = {textDocument, position}）。
   * 覆盖：hover / definition / declaration / references / implementation / completion / signatureHelp / documentHighlight。
   * 生命周期与 check 一致：didOpen → send request → await response → didClose。
   */
  async handleLspFeature(
    feature: 'hover' | 'definition' | 'declaration' | 'references' | 'implementation' | 'completion' | 'signatureHelp' | 'documentHighlight',
    args: { file: string; line: number; character: number }
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (!this.initialized) {
      return this.buildNotReadyResponse();
    }

    const resolved = this.resolveSingleFile(args.file);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `File does not exist or is not a .ets file: ${args.file}` }],
        isError: true,
      };
    }

    const method = ArktsCheckTool.FEATURE_METHOD_MAP[feature];
    if (!method) {
      return { content: [{ type: 'text', text: `Unknown feature: ${feature}` }], isError: true };
    }

    mcpLog.info(`handleLspFeature: ${feature} file=${resolved} line=${args.line} char=${args.character}`);

    try {
      const result = await this.withOpenFile(resolved, async (uri) => {
        const params: Record<string, unknown> = {
          textDocument: { uri },
          position: { line: args.line, character: args.character },
        };
        if (feature === 'references') {
          params.context = { includeDeclaration: true };
        }
        return this.manager!.sendFeatureRequest(method, params);
      });
      const text = result == null
        ? `${feature}: no result`
        : `${feature}: ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mcpLog.error(`handleLspFeature ${feature} failed: ${msg}`);
      return {
        content: [{ type: 'text', text: `${feature} failed: ${msg}` }],
        isError: true,
      };
    }
  }

  /**
   * workspaceSymbol：按名称搜索全工程符号。
   * 不依赖具体文件，无需 didOpen/didClose，只需 LSP 处于 READY 状态。
   */
  async handleWorkspaceSymbol(
    query: string
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (!this.initialized) {
      return this.buildNotReadyResponse();
    }

    mcpLog.info(`handleWorkspaceSymbol: query="${query}"`);

    try {
      const result = await this.manager!.sendFeatureRequest(
        LSP_METHOD.WORKSPACE_SYMBOL,
        { query },
      );
      const text = result == null
        ? `workspaceSymbol: no result`
        : `workspaceSymbol: ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mcpLog.error(`handleWorkspaceSymbol failed: ${msg}`);
      return {
        content: [{ type: 'text', text: `workspaceSymbol failed: ${msg}` }],
        isError: true,
      };
    }
  }

  /**
    * workspaceSymbol 的结构化版本（供 server 层合并 ArkTS + C++ 结果用，M4-2 决议）。
    * 返回 SymbolInformation[] | null（null 表示无结果或出错）。
    * 不改变现有 {@link handleWorkspaceSymbol} 行为。
    */
  async handleWorkspaceSymbolRaw(
    query: string
  ): Promise<unknown[] | null> {
    if (!this.initialized) {
      return null;
    }
    try {
      const result = await this.manager!.sendFeatureRequest(
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
      mcpLog.error(`handleWorkspaceSymbolRaw failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * documentSymbol：获取单个文件内的符号树（函数/类/变量列表 + range）。
   * 需要 didOpen/didClose 生命周期（与 hover/definition 一致），
   * 入参只需文件路径，不需要位置。
   */
  async handleDocumentSymbol(
    file: string
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (!this.initialized) {
      return this.buildNotReadyResponse();
    }

    const resolved = this.resolveSingleFile(file);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `File does not exist or is not a .ets file: ${file}` }],
        isError: true,
      };
    }

    mcpLog.info(`handleDocumentSymbol: file=${resolved}`);

    try {
      const result = await this.withOpenFile(resolved, async (uri) => {
        return this.manager!.sendFeatureRequest(
          LSP_METHOD.DOCUMENT_SYMBOL,
          { textDocument: { uri } },
        );
      });
      const text = result == null
        ? 'documentSymbol: no result'
        : `documentSymbol: ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mcpLog.error(`handleDocumentSymbol failed: ${msg}`);
      return {
        content: [{ type: 'text', text: `documentSymbol failed: ${msg}` }],
        isError: true,
      };
    }
  }

  /**
   * callHierarchy：查询函数调用关系。
   * 两步请求：prepareCallHierarchy 获取 item → incomingCalls/outgoingCalls 获取调用方/被调用方。
   * direction: 'incoming' = 谁调用了这个函数；'outgoing' = 这个函数调用了谁。
   */
  async handleCallHierarchy(
    args: { file: string; line: number; character: number; direction: 'incoming' | 'outgoing' }
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (!this.initialized) {
      return this.buildNotReadyResponse();
    }

    const resolved = this.resolveSingleFile(args.file);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `File does not exist or is not a .ets file: ${args.file}` }],
        isError: true,
      };
    }

    mcpLog.info(`handleCallHierarchy: file=${resolved} line=${args.line} char=${args.character} direction=${args.direction}`);

    try {
      const result = await this.withOpenFile(resolved, async (uri) => {
        const prepareResult = await this.manager!.sendFeatureRequest(
          LSP_METHOD.PREPARE_CALL_HIERARCHY,
          { textDocument: { uri }, position: { line: args.line, character: args.character } },
        );
        const items = Array.isArray(prepareResult) ? prepareResult : (prepareResult ? [prepareResult] : []);
        if (items.length === 0) {
          return { items: [], calls: [] };
        }

        const callsMethod = args.direction === 'incoming'
          ? LSP_METHOD.INCOMING_CALLS
          : LSP_METHOD.OUTGOING_CALLS;

        const allCalls: unknown[] = [];
        for (const item of items) {
          const calls = await this.manager!.sendFeatureRequest(callsMethod, { item });
          if (Array.isArray(calls)) {
            allCalls.push(...calls);
          } else if (calls) {
            allCalls.push(calls);
          }
        }
        return { items, calls: allCalls };
      });

      const text = `callHierarchy (${args.direction}): ${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mcpLog.error(`handleCallHierarchy failed: ${msg}`);
      return {
        content: [{ type: 'text', text: `callHierarchy failed: ${msg}` }],
        isError: true,
      };
    }
  }



  /**
   * 打开文件 → 执行 action → 关闭文件。
   * 复用 check 的 didOpen/didClose 生命周期，保证 ace-server 上下文一致。
   */
  private async withOpenFile<T>(
    filePath: string,
    action: (uri: string) => Promise<T>
  ): Promise<T> {
    const uri = toFileUri(filePath);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).replace(/^\./, '');
    const languageId = `deveco.apptool.${ext || 'plaintext'}`;

    mcpLog.debug(`withOpenFile didOpen uri=${uri} len=${content.length}`);
    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri, text: content, languageId, version: ++this.documentVersion },
    });
    try {
      return await action(uri);
    } finally {
      this.sendNotification('textDocument/didClose', {
        textDocument: { uri },
        isManual: false,
      });
    }
  }

  /** 解析单个文件路径，返回绝对路径或 null。 */
  private resolveSingleFile(fileArg: string): string | null {
    const resolved = path.isAbsolute(fileArg)
      ? fileArg
      : path.join(this.projectPath, fileArg);
    if (!fs.existsSync(resolved)) {
      return null;
    }
    if (!fs.statSync(resolved).isFile()) {
      return null;
    }
    if (!resolved.endsWith('.ets')) {
      return null;
    }
    return resolved;
  }

  /** LSP 未就绪时构造统一的错误返回。 */
  private buildNotReadyResponse(): {
    content: { type: string; text: string }[];
    isError: boolean;
  } {
    const msg = this.initializing
      ? 'LSP is initializing, please retry later'
      : !this.projectPath
        ? 'No project path configured; set the PROJECT_PATH parameter'
        : 'LSP not initialized';
    return {
      content: [{ type: 'text', text: msg }],
      isError: true,
    };
  }

  /** 把入参里的相对路径解析为绝对路径，并过滤出存在且后缀为 .ets 的文件。 */
  private collectValidFiles(files: string[], errors: string[]): string[] {
    const workspacePath = path.resolve(this.projectPath);
    const validFiles: string[] = [];
    for (const fileArg of files) {
      const resolved = path.resolve(path.isAbsolute(fileArg) ? fileArg : path.join(workspacePath, fileArg));

      if (!fs.existsSync(resolved)) {
        errors.push(`File does not exist: ${fileArg}`);
        continue;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        errors.push(`Not a regular file: ${fileArg}`);
        continue;
      }
      if (!resolved.endsWith('.ets')) {
        errors.push(`Not a .ets file: ${fileArg}`);
        continue;
      }
      validFiles.push(resolved);
    }
    return validFiles;
  }

  /** 逐个文件等待诊断，并把结果分流到 infoMsgs / errors。 */
  private async runDiagnosticsForFiles(
    files: string[],
    errors: string[],
    infoMsgs: string[]
  ): Promise<void> {
    for (const file of files) {
      await sleep(500);
      try {
        const result = await this.checkFile(file);
        infoMsgs.push(formatDiagnosticResult(file, result));
      } catch (err) {
        errors.push(
          `${file} => wait for diagnostics failed: ${(err as Error).message}`
        );
      }
    }
  }

  /** 把 errors / infoMsgs 拼成最终 MCP 响应。 */
  private formatCallResult(
    errors: string[],
    infoMsgs: string[]
  ): { content: { type: string; text: string }[]; isError: boolean } {
    const parts: string[] = [];
    if (errors.length > 0) {
      parts.push(errors.join('\n'));
    }
    if (infoMsgs.length > 0) {
      parts.push(infoMsgs.join('\n'));
    }
    let content = parts.join('\n').trim();
    const isError = errors.length > 0;
    if (!isError && infoMsgs.length === 0) {
      content = 'No diagnostics collected';
    }
    return {
      content: [{ type: 'text', text: content }],
      isError,
    };
  }

  async shutdown(): Promise<void> {
    const reject = this.initReject;
    this.clearInitHandlers();
    reject?.(new Error('LSP shutting down'));

    if (this.manager) {
      try {
        await this.manager.dispose();
      } catch (e) {
        mcpLog.warn(`Failed to dispose ArktsLspManager: ${e}`);
      }
      this.manager = null;
    }

    this.initialized = false;
    this.initializing = false;
    this.initPromise = null;
  }

  // ---------- LSP I/O ----------

  private sendNotification(method: string, params: unknown): void {
    if (!this.manager) {
      throw new Error('ArktsLspManager not initialized');
    }
    this.manager.sendNotification({ jsonrpc: '2.0', method, params });
  }

  private handleLspMessage(msg: LspMessage): void {
    const record = msg as unknown as Record<string, unknown>;
    const method = record.method as string | undefined;
    if (!method) {
      return;
    }

    switch (method) {
      case 'textDocument/publishDiagnostics':
        this.handleDiagnosticsNotification(record.params as Record<string, unknown> | undefined);
        break;
      case 'arkts/indexingProgress':
        this.handleIndexingProgress(record.params);
        break;
      case ACE_SERVER_METHOD.INDEXING_PROGRESS_UPDATE:
        this.handleIndexingProgress(record.params);
        break;
      case LSP_METHOD.PROGRESS:
        this.handleProgressNotification(record.params);
        break;
      case 'arkts/initialized': {
        mcpLog.info('Received arkts/initialized');
        const resolve = this.initResolve;
        this.clearInitHandlers();
        resolve?.();
        break;
      }
      case 'arkts/initializationFailed': {
        const reason = (record.params as { message?: string } | undefined)?.message ?? 'unknown';
        mcpLog.error(`LSP initialization failed: ${reason}`);
        const reject = this.initReject;
        this.clearInitHandlers();
        reject?.(new Error(`LSP initialize failed: ${reason}`));
        break;
      }
      case 'workspace/didChangeConfiguration':
        mcpLog.info('Received workspace/didChangeConfiguration, sync deferred to next check');
        break;
      default:
        break;
    }
  }

  /** 处理 aceProject/onIndexingProgressUpdate 及 arkts/indexingProgress 通知 */
  private handleIndexingProgress(params: unknown): void {
    const p = params as { moduleName?: string; current?: number; total?: number } | undefined;
    if (p?.current != null && p?.total != null && p.total > 0) {
      const percent = Math.round((p.current / p.total) * 100);
      const detail = `indexing ${p.current}/${p.total} modules` + (p.moduleName ? ` (${p.moduleName})` : '');
      this.onInitProgress?.(detail, percent);
    }
    if (this.initResolve) {
      this.armInitTimer(LSP_INIT_TIMEOUT_MS);
    }
  }

  /** 处理 $/progress 通知（标准 LSP WorkDoneProgress） */
  private handleProgressNotification(params: unknown): void {
    const value = (params as { value?: { kind?: string; message?: string; percentage?: number } } | undefined)?.value;
    if (value && (value.kind === 'report' || value.kind === 'begin')) {
      const percent = typeof value.percentage === 'number' ? Math.round(value.percentage) : null;
      const detail = value.message ?? (percent !== null ? `${percent}%` : 'indexing');
      this.onInitProgress?.(detail, percent);
    }
    if (this.initResolve) {
      this.armInitTimer(LSP_INIT_TIMEOUT_MS);
    }
  }

  /** legacy 模式：收到 publishDiagnostics 时 resolve 对应 waiter。 */
  private handleDiagnosticsNotification(
    params: Record<string, unknown> | undefined,
  ): void {
    if (!params) {
      return;
    }
    const uri = params.uri as string | undefined;
    if (!uri) {
      return;
    }
    let waiter = this.popDiagnosticWaiter(uri);
    // URI 不匹配时，若只有一个 pending waiter（check 串行），回退到它
    if (!waiter && this.diagnosticWaiters.size === 1) {
      const fallbackKey = this.diagnosticWaiters.keys().next().value as string;
      waiter = this.popDiagnosticWaiter(fallbackKey);
    }
    if (!waiter) {
      return;
    }
    if (typeof params.errorMessage === 'string') {
      mcpLog.warn(`diagnostics error uri=${uri} message=${params.errorMessage}`);
      waiter.resolve({ errorMessage: params.errorMessage });
      return;
    }
    const diagnostics = params.diagnostics;
    const count = Array.isArray(diagnostics) ? diagnostics.length : 0;
    mcpLog.debug(`diagnostics received uri=${uri} count=${count}`);
    waiter.resolve(Array.isArray(diagnostics) ? diagnostics : []);
  }

  private popDiagnosticWaiter(key: string): DiagnosticWaiter | undefined {
    const w = this.diagnosticWaiters.get(key);
    if (!w) {
      return undefined;
    }
    this.diagnosticWaiters.delete(key);
    clearTimeout(w.timer);
    return w;
  }

  // ---------- log / index 目录管理 ----------

  /**
   * 返回 (logPath, indexPath):
   * - logPath:   `<ArkTSCheck>/lsp-log/<request_id>/<nano_time>`
   * - indexPath: `<ArkTSCheck>/lsp-index/<request_id>`
   */
  private getLogAndIndexPath(projectRoot: string): {
    logPath: string;
    indexPath: string;
  } {
    try {
      const baseLogDir = path.join(getMcpLogDirectory(), 'ArkTSCheck');
      const mappingConfigPath = path.join(baseLogDir, 'mapping-config.properties');
      const requestId = getRequestId(projectRoot, mappingConfigPath);

      const nanoTime = `${Date.now()}${process.hrtime.bigint() % 1000000n}`;
      const logPath = path.join(
        baseLogDir,
        'lsp-log',
        String(requestId),
        nanoTime
      );
      const indexPath = path.join(baseLogDir, 'lsp-index', String(requestId));

      fs.mkdirSync(logPath, { recursive: true });
      fs.mkdirSync(indexPath, { recursive: true });

      return {
        logPath: normalizePath(logPath),
        indexPath: normalizePath(indexPath),
      };
    } catch {
      return { logPath: 'auto', indexPath: 'auto' };
    }
  }
}

/**
 * 从 textDocument/diagnostic 响应中提取 diagnostics 数组。
 * 支持标准 FullDocumentDiagnosticReport ({ kind: 'full', items }) 和裸数组。
 */
function extractDiagnosticItems(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === 'object') {
    const report = result as { kind?: unknown; items?: unknown };
    if (report.kind === 'full' && Array.isArray(report.items)) {
      return report.items;
    }
  }
  return [];
}

/**
 * 把 `checkFile` 的返回值格式化为单行人类可读字符串。
 *  - 数组：空 => `no diagnostics`，否则序列化诊断列表
 *  - `{ errorMessage }`：诊断失败提示
 *  - 其它：兜底序列化
 */
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
