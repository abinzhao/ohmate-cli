/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ToolRouter, createToolRouter } from './router.js';
import { EventType, toTraceErrorCode, type Telemetry, type McpToolCall, type TrackMeasurement } from '../../src/trace/index.js';
import { readProcessRss, formatBytesMb } from '../../src/utils/process-rss.js';
import { ArktsCheckTool, CppCheckTool, ClangdLspTool } from './tools/index.js';
import { probeSocketSupport, detectStandardProtocol, findHarmonyProject, isSupportedCppFile } from './utils/common.js';
import { initMcpLogger, disposeMcpLogger, flushMcpLogger, getMcpLogFilePath, mcpLog } from './utils/mcp-logger.js';
import { ArktsLspManager, type SyncResult } from './lsp/ArktsLspManager.js';
import { resolveNodePath } from './lsp/utils.js';
import { ClangdLspManager } from './lsp/ClangdLspManager.js';
import { findCppModules, checkCppSyncRequired, resolveCustomCompileCommandsDir } from './lsp/sync/cpp-compile.js';
import { checkSyncRequired } from './lsp/sync/syncGuard.js';

/**
 * 项目生命周期状态枚举
 */
enum ProjectLifecycle {
  IDLE, // 无项目（空文件夹 / 启动时未检测到）
  DISCOVERING, // 正在扫描/检测项目
  SYNCING, // 项目已发现，正在执行 ohpm install + hvigor sync
  INITIALIZING, // sync 完成，LSP 正在初始化
  READY, // 完全就绪，check 工具可用
  ERROR, // sync 或 init 失败，可重试
}

/**
 * C++ 项目生命周期状态枚举（与 ArkTS 状态机并行，独立运转）
 */
enum CppLifecycle {
  IDLE_CPP, // 无项目 / 未启动 C++ 初始化
  DISCOVERING_CPP, // 检测 C++ 模块
  SYNCING_CPP, // 执行 compileNative + 合并 compile_commands.json
  INITIALIZING_CPP, // clangd spawn + initialize
  READY_CPP, // C++ 工具可用（含"无 C++ 代码"提前就绪）
  ERROR_CPP, // sync 或 init 失败，可重试
}

const MAX_INIT_RETRY = 3;
const SYNC_SKIP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHECK_FILES = 100;

/** ArkTS 初始化进度快照，agent 调用工具时从此构建 retry 消息 */
interface ArktsInitProgress {
  phase: 'ohpm' | 'hvigor' | 'dep-parse' | 'lsp-init';
  detail: string;
  percent: number | null;
  startedAt: number;
  updatedAt: number;
}

const PHASE_ORDER: ArktsInitProgress['phase'][] = ['ohpm', 'hvigor', 'dep-parse', 'lsp-init'];
const PHASE_LABELS: Record<ArktsInitProgress['phase'], string> = {
  'ohpm': 'ohpm install',
  'hvigor': 'hvigor sync',
  'dep-parse': 'dependency parse',
  'lsp-init': 'LSP init',
};
const RETRY_SEC = 15;

/**
 * MCP Server Configuration
 */
export interface McpServerConfig {
  projectPath?: string;
  /** 启动期由 ToolProvider 解析固定的 sdkPath（CLT|Studio 布局）。 */
  sdkPath?: string;
  /** 启动期由 ToolProvider 解析固定的 arkts-lang-server 根目录。 */
  arktsLangServerPath?: string;
  /** 启动期由 ToolProvider 解析固定的 node 可执行文件路径。 */
  nodePath?: string;
  /** 启动期由 ToolProvider 解析固定的 ohpm pm-cli.js 路径。 */
  ohpmJsPath?: string;
  /** 启动期由 ToolProvider 解析固定的 hvigorw.js 路径。 */
  hvigorJsPath?: string;
  /** 启动期由 ToolProvider 解析固定的 clangd 可执行文件路径。 */
  clangdPath?: string;
  nodeMaxOldSpaceSize?: string;
  /** debug 模式：true=console输出，false=文件输出（带轮转） */
  debug?: boolean;
  /** C++ LSP 服务开关，默认 true。关闭后跳过 compileNative + clangd 初始化，C++ 工具不可用。 */
  cppEnabled?: boolean;
  /**
   * 用户自定义 compile_commands.json 文件路径（DEVECO_CLI_CPP_COMPILE_COMMANDS）。
   * 指定且文件有效时跳过 compileNative 同步，clangd 直接读取该编译数据库。
   */
  cppCompileCommandsPath?: string;
  telemetry?: Telemetry;

}

/**
 * MCP Server
 */
export class DevecoCliMcpServer {
  private server: McpServer;
  private toolRouter: ToolRouter;
  private config: McpServerConfig = {};

  // Tool instances
  private arktsCheckTool: ArktsCheckTool | null = null;
  private cppCheckTool: CppCheckTool | null = null;
  private cppLspTool: ClangdLspTool | null = null;
  private cppLspManager: ClangdLspManager | null = null;

  // 项目生命周期状态
  private projectState: ProjectLifecycle = ProjectLifecycle.IDLE;
  private workspaceRoot: string = ''; // MCP 客户端提供的 workspace root，供重新扫描
  private sdkPath: string = ''; // 启动期固定 sdkPath（env / CLT|Studio 布局）
  private arktsLangServerPath: string | null = null; // 启动期固定 arkts-lang-server 路径
  private nodePath: string = ''; // 启动期固定 node 可执行文件路径
  private ohpmJsPath: string = ''; // 启动期固定 ohpm pm-cli.js 路径
  private hvigorJsPath: string = ''; // 启动期固定 hvigorw.js 路径
  private clangdPath: string | null = null; // 启动期固定 clangd 可执行文件路径
  private initPromise: Promise<void> | null = null; // 互斥锁：保证同一时刻只有一个初始化流程在执行
  private needsReinit: boolean = false; // 路径变更标记：初始化运行期间 setProjectPath() 被调用时设置
  private initRetryCount: number = 0; // 连续初始化失败时计数，超过 MAX_INIT_RETRY 后不再自动重试
  private originalProjectPath: string = ''; // 用户原始配置的路径（findHarmonyProject 解析前），用于区分"未设置"与"设置了但未找到鸿蒙工程"
  private configChangedTriggeredResync: boolean = false; // 配置文件变化触发的重新同步标记，用于区分提示消息
  private syncSkippedDueToLock: boolean = false; // sync 因锁被占用而跳过，用于返回更精确的提示消息
  private syncSkipStartedAt: number = 0; // 首次因锁竞争跳过 sync 的时间戳，超过 SYNC_SKIP_TIMEOUT_MS 后进入 ERROR 状态
  /** ArkTS 初始化进度快照，SYNCING/INITIALIZING 期间由回调更新，READY/ERROR 时置 null */
  private arktsInitProgress: ArktsInitProgress | null = null;
  /** ArkTS 初始化管道总计时起点（ohpm 开始时设置） */
  private arktsPipelineStartedAt: number = 0;
  /** 是否支持标准 LSP 协议（standardIndex/index.js 存在）。false=legacy ace-server，不注册位置类语言特性工具。 */
  private standardProtocolAvailable: boolean = false;
  /** 是否使用 socket 传输模式（--list-protocols 探测）。true 时不注册 restart 工具。 */
  private socketAvailable: boolean = false;

  // C++ 项目生命周期状态（与 ArkTS 状态机并行，独立运转）
  private cppProjectState: CppLifecycle = CppLifecycle.IDLE_CPP;
  private cppInitPromise: Promise<void> | null = null; // 互斥锁：保证同一时刻只有一个 C++ 初始化流程在执行
  private cppNeedsReinit: boolean = false; // 路径变更标记
  private cppInitRetryCount: number = 0; // 连续初始化失败计数
  private cppSyncSkippedDueToLock: boolean = false; // C++ sync 因锁被占用而跳过
  private cppSyncSkipStartedAt: number = 0; // 首次因锁竞争跳过 C++ sync 的时间戳
  private cppHasNoCppCode: boolean = false; // 工程无 C++ 代码，C++ 工具应返回 "no C++ code"
  private readonly cppEnabled: boolean; // C++ LSP 服务开关（默认 true，由 DEVECO_CLI_CPP_ENABLED 控制）
  /** 用户自定义 compile_commands.json 所在目录（有效时跳过 compileNative 同步）；无效/未配置为 null。 */
  private cppCustomCompileCommandsDir: string | null = null;
  /** 自定义 DB 目录的解析缓存键（路径模板 + 工程根），setProjectPath 切换工程后自动重解析。 */
  private cppCustomDirResolvedFor: string = '';

  constructor(config: McpServerConfig = {}) {
    this.config = config;
    
    // 初始化 Logger（根据 debug 配置决定输出方式）
    initMcpLogger(config.debug ?? false);
    
    // 处理 projectPath：
    let startPath: string;
    const configuredPath = config.projectPath?.trim() ?? '';
    this.originalProjectPath = configuredPath;
    if (configuredPath === '.') {
      startPath = process.cwd();
      mcpLog.info(`Constructor: configuredPath is '.', startPath: '${startPath}'`);
    } else if (configuredPath === '') {
      startPath = '';
      mcpLog.info(`Constructor: configuredPath is empty, startPath remains empty`);
    } else {
      startPath = configuredPath;
      mcpLog.info(`Constructor: using configured path as startPath: '${startPath}'`);
    }
    const foundProject = findHarmonyProject(startPath);
    mcpLog.info(`Constructor: findHarmonyProject('${startPath}') => ${foundProject ?? 'null'}`);
    this.config.projectPath = foundProject ?? undefined;

    // 启动期一次性固定组件路径（由 serve 命令经 ToolProvider 解析后注入）。
    // 后续 ArkTS / C++ 全流程（ace-server、ohpm/hvigor sync、compileNative、clangd）均使用注入值，不再重复解析。
    this.sdkPath = this.config.sdkPath ?? '';
    this.arktsLangServerPath = this.config.arktsLangServerPath ?? null;
    this.nodePath = this.config.nodePath ?? '';
    this.ohpmJsPath = this.config.ohpmJsPath ?? '';
    this.hvigorJsPath = this.config.hvigorJsPath ?? '';
    this.clangdPath = this.config.clangdPath ?? null;
    this.cppEnabled = this.config.cppEnabled ?? true;
    // 自定义 compile_commands 路径（支持 {workspace} 占位符 / 相对路径）在 C++ 初始化时按工程根解析，
    // 构造期不解析——projectPath 可能尚未确定或后续经 setProjectPath 变更。
    mcpLog.info(`Constructor: sdkPath='${this.sdkPath}', arktsLangServerPath='${this.arktsLangServerPath ?? '(null)'}', cppEnabled=${this.cppEnabled}, cppCompileCommandsPath='${this.config.cppCompileCommandsPath ?? '(none)'}'`);

    // Create MCP server instance
    this.server = new McpServer({
      name: 'devecocli-mcp-server',
      version: '0.0.1',
    });

    // Create tool router
    this.toolRouter = createToolRouter(config.telemetry, () => this.arktsCheckTool?.aceServerPid ?? null, () => this.config.projectPath ?? '', () => this.sdkPath ?? '');

    // 检测是否支持标准 LSP 协议（纯文件系统判定，可同步完成）。
    // socket 传输探测需要 spawn 子进程，放到 start() 里异步做，避免阻塞构造函数的事件循环。
    this.standardProtocolAvailable = this.detectStandardProtocolAvailable();
  }

  /**
   * Register all tools to the router.
   *
   * - `check`：静态语法分析（ArkTS + C/C++ 诊断）
   * - `hover` / `definition` / `declaration` / `references` / `implementation`：ArkTS 位置相关语言特性，
   *   共享 LSP 生命周期（didOpen → request → didClose），仅 READY 状态可用。
   * - `workspaceSymbol`：全工程符号搜索，无需打开文件，仅 READY 状态可用。
   * - `documentSymbol`：单文件符号树，需 didOpen/didClose，仅 READY 状态可用。
   * - `callHierarchy`：函数调用关系查询（incoming/outgoing），需 didOpen/didClose，仅 READY 状态可用。
   * - `restart`：原地重启（重置状态 + 重新 sync/init），不杀进程、客户端不断开；ERROR 态可用，可按 target 重启单侧。
   */
  private registerTools(): void {
    this.registerCheckTool();
    this.registerLspFeatureTools();
    // socket 模式下不注册 restart（共享 server 生命周期不由单个客户端控制）
    if (!this.socketAvailable) {
      this.registerRestartTool();
    }
  }

  /** 注册 restart 工具：原地重置状态并重新初始化（不杀进程、客户端连接保持）。 */
  private registerRestartTool(): void {
    this.toolRouter.add(
      {
        name: 'restart',
        description:
          'Restart the MCP server in-place: re-sync the project and re-initialize the LSP, ' +
          'without dropping the client connection. Use to recover from a stuck/ERROR state ' +
          'after fixing the root cause, instead of exiting and reopening the agent. ' +
          'Use target to restart one side only (arkts/cpp) or both (all, default). ' +
          'Only callable when the project state is ready/idle/error; during discovery/sync/init ' +
          '(large-project init can take minutes) it returns an error—wait for ready and retry tools instead. ' +
          'Caution: if initialization fails again after a restart, the cause is likely a persistent ' +
          'project/SDK configuration issue—do not call restart repeatedly; ask the user to fix the project first.',
        inputSchema: z.object({
          target: z
            .enum(['arkts', 'cpp', 'all'])
            .default('all')
            .describe(
              'Which backend to restart: "arkts" (ArkTS ace-server), "cpp" (C++ clangd), or "all" (both, default).',
            ),
        }),
      },
      async (args: Record<string, unknown>) => this.handleRestartCall(args),
    );
  }

  /** 注册 check 工具（ArkTS + C/C++ 诊断）。 */
  private registerCheckTool(): void {
    this.toolRouter.add(
      {
        name: 'check',
        description:
          'Perform static syntax analysis on HarmonyOS project source files and return structured diagnostics. ' +
          'Supported languages: ArkTS and C/C++.',
        inputSchema: z.object({
          files: z
            .array(z.string())
            .min(1)
            .describe(
              'List of source file paths to check, relative to the project root ' +
                '(absolute paths within the project are also accepted). ' +
                'Supports ArkTS and C/C++ files in the same call.'
            ),
        }),
      },
      async (args: Record<string, unknown>) => this.handleCheckCall(args)
    );
  }

  /**
   * 注册位置相关语言特性工具（hover/definition/declaration/references/implementation）。
   *
   * 这些工具按文件扩展名分流到 ArkTS 或 C++ 后端：
   * - ArkTS (.ets) → ace-server；若 DevEco 不支持标准 LSP 协议，运行时返回明确错误
   * - C/C++ → clangd（标准 LSP，不依赖 standardIndex/index.js）
   */
  private registerLspFeatureTools(): void {
    if (!this.standardProtocolAvailable) {
      mcpLog.info(
        'Skip registering LSP feature tools (hover/definition/declaration/references/implementation, ' +
          'workspaceSymbol, documentSymbol, callHierarchy): standard LSP protocol unavailable ' +
          '(standardIndex/index.js not found). These tools require a DevEco Studio version that ships the standard LSP server entry.',
      );
      return;
    }

    const lspPositionSchema = z.object({
      file: z.string().describe('Source file path, relative to the project root (absolute paths within the project are also accepted). Supports .ets (ArkTS) and C/C++ extensions.'),
      line: z.number().describe('Line number (0-based)'),
      character: z.number().describe('Character offset in the line (0-based)'),
    });

    for (const { name, description, feature } of this.getPositionFeatures()) {
      this.toolRouter.add(
        { name, description, inputSchema: lspPositionSchema },
        async (args: Record<string, unknown>) => this.handleLspFeatureCall(feature, args)
      );
    }

    this.registerSymbolTools();
    this.registerCallHierarchyTool();
  }

  /** 返回位置相关工具的定义列表。 */
  private getPositionFeatures(): Array<{ name: string; description: string; feature: 'hover' | 'definition' | 'declaration' | 'references' | 'implementation' | 'completion' | 'signatureHelp' | 'documentHighlight' }> {
    return [
      { name: 'hover', description: 'Get hover information (type info, documentation) at a specific position in an ArkTS (.ets) or C/C++ file.', feature: 'hover' },
      { name: 'definition', description: 'Find where the symbol at the given position is defined. Returns file path, line, and character.', feature: 'definition' },
      { name: 'declaration', description: 'Find the declaration of the symbol at the given position. In ArkTS, this may differ from definition.', feature: 'declaration' },
      { name: 'references', description: 'Find all references to the symbol at the given position across the HarmonyOS project.', feature: 'references' },
      { name: 'implementation', description: 'Find implementations of the symbol at the given position (e.g., interface implementations).', feature: 'implementation' },
    ];
  }

  /** 注册 workspaceSymbol（全工程搜索）和 documentSymbol（单文件符号树）。 */
  private registerSymbolTools(): void {
    this.toolRouter.add(
      {
        name: 'workspaceSymbol',
        description: 'Search for symbols by name across the entire HarmonyOS project.',
        inputSchema: z.object({
          query: z.string().describe('Symbol name (or partial) to search for'),
        }),
      },
      async (args: Record<string, unknown>) => this.handleWorkspaceSymbolCall(args)
    );

    this.toolRouter.add(
      {
        name: 'documentSymbol',
        description:
          'Get the symbol tree (functions, classes, variables with ranges) of an ArkTS (.ets) or C/C++ file. ' +
          'Useful for file overview, structured code breakdown, and large file slicing.',
        inputSchema: z.object({
          file: z.string().describe('Source file path, relative to the project root (absolute paths within the project are also accepted). Supports .ets and C/C++ extensions.'),
        }),
      },
      async (args: Record<string, unknown>) => this.handleDocumentSymbolCall(args)
    );
  }

  /** 注册 callHierarchy 工具（调用关系查询，支持 incoming/outgoing 方向）。 */
  private registerCallHierarchyTool(): void {
    this.toolRouter.add(
      {
        name: 'callHierarchy',
        description:
          'Query call hierarchy for a function at the given position. ' +
          'Use direction "incoming" to find callers, "outgoing" to find callees. ' +
          'ArkTS supports both directions; C/C++ (clangd) supports incoming only.',
        inputSchema: z.object({
          file: z.string().describe('Source file path, relative to the project root (absolute paths within the project are also accepted). Supports .ets and C/C++ extensions.'),
          line: z.number().describe('Line number (0-based)'),
          character: z.number().describe('Character offset in the line (0-based)'),
          direction: z.enum(['incoming', 'outgoing']).describe('"incoming" = who calls this function, "outgoing" = what this function calls'),
        }),
      },
      async (args: Record<string, unknown>) => this.handleCallHierarchyCall(args)
    );
  }

  /**
   * 检测当前安装是否支持标准 LSP 协议。
   * 判据：`standardIndex/index.js` 存在即为标准协议（socket 支持由 --list-protocols 探测）。
   * socket 与 stdio 共用 standardIndex/index.js 入口，仅启动 flag 不同。
   * 与 ArktsCheckTool.resolveProjectAndDeveco 的检测逻辑保持一致。
   * false=legacy ace-server 私有协议（仅 check 可用，位置类语言特性不可用）。
   */
  private detectStandardProtocolAvailable(): boolean {
    try {
      const arktsLangServerPath = this.arktsLangServerPath;
      if (!arktsLangServerPath) {
        mcpLog.info('Standard LSP protocol unavailable: arkts-lang-server path not found');
        return false;
      }
      const available = detectStandardProtocol(arktsLangServerPath);
      mcpLog.info(
        `ArktsCheck protocol: ${available ? 'standard LSP' : 'legacy ace-server'} ` +
          `(standardIndex/index.js exists=${available})`,
      );
      return available;
    } catch (err) {
      mcpLog.warn(`Failed to detect standard LSP protocol availability: ${err}`);
      return false;
    }
  }

  /** 通过 --list-protocols 异步探测是否使用 socket 传输模式（不阻塞事件循环）。 */
  private async detectSocketAvailable(): Promise<void> {
    try {
      const arktsLangServerPath = this.arktsLangServerPath;
      if (!arktsLangServerPath) {
        this.socketAvailable = false;
        return;
      }
      this.socketAvailable = await probeSocketSupport(arktsLangServerPath, resolveNodePath(this.nodePath));
      mcpLog.info(`Socket transport: ${this.socketAvailable ? 'enabled' : 'disabled (stdio mode)'} (--list-protocols probe)`);
    } catch {
      this.socketAvailable = false;
    }
  }

  /**
   * `check` 工具的统一入口：按文件扩展名分桶，分别调对应 LSP 工具，再合并结果。
   */
  private async handleCheckCall(
    args: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const files = Array.isArray((args as { files?: unknown }).files)
      ? ((args as { files: unknown[] }).files.filter(
          (f): f is string => typeof f === 'string'
        ))
      : [];
    if (files.length === 0) {
      mcpLog.warn('check tool called with empty files list');
      return {
        content: [{ type: 'text', text: 'No files provided' }],
        isError: true,
      };
    }
    if (files.length > MAX_CHECK_FILES) {
      mcpLog.warn(`check tool called with ${files.length} files (max: ${MAX_CHECK_FILES})`);
      return {
        content: [{ type: 'text', text: `Too many files: ${files.length}. Maximum allowed is ${MAX_CHECK_FILES}.` }],
        isError: true,
      };
    }

    const { etsFiles, cppFiles, unsupported } = classifyFiles(files);
    if (unsupported.length > 0) {
      mcpLog.warn(`Unsupported file types in check request: ${unsupported.join(', ')}`);
    }

    const errors: string[] = unsupported.map(
      (f) => `Unsupported file type: ${f} (only .ets and C/C++ source/header files are supported)`
    );
    const infos: string[] = [];

    if (etsFiles.length > 0) {
      this.mergeCheckResult(await this.callArktsCheck(etsFiles), errors, infos);
    }
    if (cppFiles.length > 0) {
      this.mergeCheckResult(await this.callCppCheck(cppFiles), errors, infos);
    }

    const isError = errors.length > 0;
    const text = [infos.join('\n'), errors.join('\n')]
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .trim();
    return {
      content: [{ type: 'text', text: text || 'No diagnostics collected' }],
      isError,
    };
  }

  /** 调 ArkTS 工具；按项目生命周期状态分流。 */
  private async callArktsCheck(files: string[]): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    switch (this.projectState) {
      case ProjectLifecycle.IDLE:
        return this.handleIdleCheck();
      case ProjectLifecycle.DISCOVERING:
        mcpLog.warn(`ArkTS check rejected: project is DISCOVERING, files: ${files.join(', ')}`);
        return { content: [{ type: 'text', text: this.buildInitRetryMessage() }], isError: true };
      case ProjectLifecycle.SYNCING:
        mcpLog.warn(`ArkTS check rejected: project is SYNCING, files: ${files.join(', ')}`);
        return { content: [{ type: 'text', text: this.buildInitRetryMessage() }], isError: true };
      case ProjectLifecycle.INITIALIZING:
        mcpLog.warn(`ArkTS check rejected: LSP is initializing, files: ${files.join(', ')}`);
        return { content: [{ type: 'text', text: this.buildInitRetryMessage() }], isError: true };
      case ProjectLifecycle.ERROR:
        return this.handleErrorCheck();
      case ProjectLifecycle.READY:
        return this.arktsCheckTool!.handleCall({ files });
      default:
        mcpLog.error(`ArkTS check: unknown project state ${this.projectState}, files: ${files.join(', ')}`);
        return { content: [{ type: 'text', text: `Unknown project state: ${this.projectState}` }], isError: true };
    }
  }

  /**
   * `hover` / `definition` / `references` / `completion` 工具的统一入口：
   * 校验参数 + containment → 按 projectState 分流（与 check 相同的状态机）。
   */
  private async handleLspFeatureCall(
    feature: 'hover' | 'definition' | 'declaration' | 'references' | 'implementation' | 'completion' | 'signatureHelp' | 'documentHighlight',
    args: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const file = (args as { file?: unknown }).file;
    const line = (args as { line?: unknown }).line;
    const character = (args as { character?: unknown }).character;

    if (typeof file !== 'string' || typeof line !== 'number' || typeof character !== 'number') {
      return {
        content: [{ type: 'text', text: `Missing or invalid parameters. Required: file (string), line (number), character (number).` }],
        isError: true,
      };
    }

    return this.routeLspRequest(file, feature, async () => {
      if (file.endsWith('.ets')) {
        return this.arktsCheckTool!.handleLspFeature(feature, { file, line, character });
      }
      // C++ file — clangd 支持的 5 个位置特性
      const cppFeature = feature as 'hover' | 'definition' | 'declaration' | 'references' | 'implementation';
      return this.cppLspTool!.handleLspFeature(cppFeature, { file, line, character });
    });
  }

  /**
    * `workspaceSymbol` 工具入口：校验 query 参数 → 双边状态机分流。
    * 不需要 containment 校验（不涉及具体文件路径）。
    * 行为（M4-2 决议）：
    *  - 两边都未 READY → 返回双边状态摘要
    *  - 至少一边 READY → 合并结果（按 location 去重，ArkTS 在前 C++ 在后，不排序）
    *  - 两边都 ERROR → 返回双边错误摘要
    */
  private async handleWorkspaceSymbolCall(
    args: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const query = (args as { query?: unknown }).query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Missing or invalid parameter: query (non-empty string required).' }],
        isError: true,
      };
    }

    return this.routeWorkspaceSymbolRequest(query);
  }

  /**
    * workspaceSymbol 双边合并路由（M4-2 决议）。
    * 去重键：location.uri + location.range.start.line + location.range.start.character。
    * 排序：不排序，ArkTS 在前 C++ 在后。
    */
  private async routeWorkspaceSymbolRequest(
    query: string
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const arktsReady = this.projectState === ProjectLifecycle.READY && this.arktsCheckTool !== null;
    const cppReady = this.cppProjectState === CppLifecycle.READY_CPP && !this.cppHasNoCppCode && this.cppLspTool !== null;

    if (!arktsReady && !cppReady) {
      // 两边都未 READY — 返回双边状态摘要
      const arktsDesc = this.describeArktsState();
      const cppDesc = this.describeCppState();
      mcpLog.info(`workspaceSymbol rejected: ArkTS ${arktsDesc}; C++ ${cppDesc}`);
      return {
        content: [{ type: 'text', text: `workspaceSymbol: ArkTS ${arktsDesc}; C++ ${cppDesc}` }],
        isError: true,
      };
    }

    // 至少一边 READY — 合并结果（按 location 去重，ArkTS 在前 C++ 在后）
    const merged: unknown[] = [];
    const seen = new Set<string>();

    if (arktsReady) {
      try {
        this.mergeSymbolItems(await this.arktsCheckTool!.handleWorkspaceSymbolRaw(query), seen, merged);
      } catch (err) {
        mcpLog.warn(`workspaceSymbol ArkTS query failed: ${(err as Error).message}`);
      }
    }

    if (cppReady) {
      try {
        this.mergeSymbolItems(await this.cppLspTool!.handleWorkspaceSymbolRaw(query), seen, merged);
      } catch (err) {
        mcpLog.warn(`workspaceSymbol C++ query failed: ${(err as Error).message}`);
      }
    }

    const text = merged.length === 0
      ? 'workspaceSymbol: no result'
      : `workspaceSymbol: ${JSON.stringify(merged, null, 2)}`;
    return { content: [{ type: 'text', text }] };
  }

  /** SymbolInformation 去重键：location.uri + range.start.line + range.start.character。 */
  private symbolDedupKey(item: unknown): string {
    const sym = item as {
      location?: {
        uri?: string;
        range?: { start?: { line?: number; character?: number } };
      };
    };
    const uri = sym?.location?.uri ?? '';
    const line = sym?.location?.range?.start?.line ?? 0;
    const char = sym?.location?.range?.start?.character ?? 0;
    return `${uri}:${line}:${char}`;
  }

  /** 把单边 workspaceSymbol 结果按 location 去重后合并进 merged。 */
  private mergeSymbolItems(items: unknown[] | null, seen: Set<string>, merged: unknown[]): void {
    if (!items) {
      return;
    }
    for (const item of items) {
      const key = this.symbolDedupKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }

  /** 返回 ArkTS 状态的简短描述（供 workspaceSymbol 摘要用）。 */
  private describeArktsState(): string {
    switch (this.projectState) {
      case ProjectLifecycle.IDLE: return 'idle';
      case ProjectLifecycle.DISCOVERING: return 'discovering';
      case ProjectLifecycle.SYNCING: return `syncing (retry ${RETRY_SEC}s)`;
      case ProjectLifecycle.INITIALIZING: return `initializing (retry ${RETRY_SEC}s)`;
      case ProjectLifecycle.ERROR: return `error (${this.initRetryCount}/${MAX_INIT_RETRY})`;
      case ProjectLifecycle.READY: return 'ready';
      default: return 'unknown';
    }
  }

  /** 返回 C++ 状态的简短描述（供 workspaceSymbol 摘要用）。 */
  private describeCppState(): string {
    switch (this.cppProjectState) {
      case CppLifecycle.IDLE_CPP: return 'idle';
      case CppLifecycle.DISCOVERING_CPP: return 'discovering';
      case CppLifecycle.SYNCING_CPP: return 'syncing (retry 25s)';
      case CppLifecycle.INITIALIZING_CPP: return 'initializing (retry 10s)';
      case CppLifecycle.ERROR_CPP: return `error (${this.cppInitRetryCount}/${MAX_INIT_RETRY})`;
      case CppLifecycle.READY_CPP: return this.cppHasNoCppCode ? 'ready (no C++ code)' : 'ready';
      default: return 'unknown';
    }
  }

  /**
   * `documentSymbol` 工具入口：校验 file 参数 + containment → 状态机分流。
   */
  private async handleDocumentSymbolCall(
    args: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const file = (args as { file?: unknown }).file;
    if (typeof file !== 'string') {
      return {
        content: [{ type: 'text', text: 'Missing or invalid parameter: file (string required).' }],
        isError: true,
      };
    }

    return this.routeLspRequest(file, 'documentSymbol', async () => {
      if (file.endsWith('.ets')) {
        return this.arktsCheckTool!.handleDocumentSymbol(file);
      }
      return this.cppLspTool!.handleDocumentSymbol(file);
    });
  }

  /**
   * `callHierarchy` 工具入口：校验 file/line/character/direction + containment → 状态机分流。
   */
  private async handleCallHierarchyCall(
    args: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const file = (args as { file?: unknown }).file;
    const line = (args as { line?: unknown }).line;
    const character = (args as { character?: unknown }).character;
    const direction = (args as { direction?: unknown }).direction;

    if (typeof file !== 'string' || typeof line !== 'number' || typeof character !== 'number') {
      return {
        content: [{ type: 'text', text: 'Missing or invalid parameters. Required: file (string), line (number), character (number).' }],
        isError: true,
      };
    }
    if (direction !== 'incoming' && direction !== 'outgoing') {
      return {
        content: [{ type: 'text', text: 'Parameter direction must be "incoming" or "outgoing".' }],
        isError: true,
      };
    }

    return this.routeLspRequest(file, `callHierarchy(${direction})`, async () => {
      if (file.endsWith('.ets')) {
        return this.arktsCheckTool!.handleCallHierarchy({ file, line, character, direction });
      }
      return this.cppLspTool!.handleCallHierarchy({ file, line, character, direction });
    });
  }

  /**
   * ArkTS 请求的统一状态机路由：IDLE/DISCOVERING/SYNCING/INITIALIZING/ERROR/READY。
   * 只有 READY 状态才执行 readyAction，其余返回 "please retry"。
   */
  private async routeArktsRequest(
    logLabel: string,
    readyAction: () => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    switch (this.projectState) {
      case ProjectLifecycle.IDLE:
        return this.handleIdleCheck();
      case ProjectLifecycle.DISCOVERING:
        mcpLog.warn(`ArkTS ${logLabel} rejected: project is DISCOVERING`);
        return { content: [{ type: 'text', text: this.buildInitRetryMessage() }], isError: true };
      case ProjectLifecycle.SYNCING:
        mcpLog.warn(`ArkTS ${logLabel} rejected: project is SYNCING`);
        return { content: [{ type: 'text', text: this.buildInitRetryMessage() }], isError: true };
      case ProjectLifecycle.INITIALIZING:
        mcpLog.warn(`ArkTS ${logLabel} rejected: LSP is initializing`);
        return { content: [{ type: 'text', text: this.buildInitRetryMessage() }], isError: true };
      case ProjectLifecycle.ERROR:
        return this.handleErrorCheck();
      case ProjectLifecycle.READY:
        return readyAction();
      default:
        mcpLog.warn(`ArkTS ${logLabel} rejected: unknown project state ${this.projectState}`);
        return { content: [{ type: 'text', text: 'Unknown project state, please retry' }], isError: true };
    }
  }

  /** IDLE 状态下检查：触发 ensureProjectReady（项目搜索由 Phase 1 统一处理），
   *  根据当前已有信息判断返回消息。
   */
  private async handleIdleCheck(): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    this.ensureProjectReady();
    if (this.config.projectPath) {
      let msg: string;
      let trigger: string;
      if (this.syncSkippedDueToLock) {
        const elapsedSec = this.syncSkipStartedAt > 0 ? Math.round((Date.now() - this.syncSkipStartedAt) / 1000) : 0;
        msg = `Another build process is running, sync deferred (waiting ${elapsedSec}s), please retry in 25 seconds`;
        trigger = 'lock contention';
        this.syncSkippedDueToLock = false;
      } else if (this.configChangedTriggeredResync) {
        msg = this.arktsInitProgress
          ? this.buildInitRetryMessage()
          : `Config file changed, resyncing project.${this.buildRetrySuffix()}`;
        trigger = 'config changed';
        this.configChangedTriggeredResync = false;
      } else {
        msg = this.arktsInitProgress
          ? this.buildInitRetryMessage()
          : `ArkTS project detected, syncing.${this.buildRetrySuffix()}`;
        trigger = 'initial';
      }
      mcpLog.info(`Idle check: project '${this.config.projectPath}' already known, triggering init (${trigger})`);
      return {
        content: [{ type: 'text', text: msg }],
        isError: true
      };
    }
    if (this.workspaceRoot || this.originalProjectPath) {
      mcpLog.info(`Idle check: no project path yet, will try from '${this.workspaceRoot}' or '${this.originalProjectPath}'`);
      return {
        content: [{ type: 'text', text: `Initializing.${this.buildRetrySuffix()}` }],
        isError: true
      };
    }
    mcpLog.warn(`Idle check: no search candidates available`);
    return {
      content: [{ type: 'text', text: 'No HarmonyOS project detected. Please verify the project directory or create a project first.' }],
      isError: true
    };
  }

  /** ERROR 状态下检查：自动重试（含冷却机制防止无限循环）。
   *  项目搜索由 ensureProjectReady Phase 1 统一处理，此处仅判断重试次数。
   */
  private async handleErrorCheck(): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    if (this.initRetryCount >= MAX_INIT_RETRY) {
      mcpLog.error(`Init retry limit reached (${this.initRetryCount}/${MAX_INIT_RETRY}), will not auto-retry`);
      return {
        content: [
          {
            type: 'text',
            text:
              `Project initialization failed repeatedly (auto-retry exhausted: ${this.initRetryCount}/${MAX_INIT_RETRY}). ` +
              'Ask the user to investigate and confirm `ohpm install` + `hvigor` sync succeed manually. ' +
              'Do NOT call the `restart` tool repeatedly — call it at most once after the user fixes the root cause; ' +
              'if it fails again, stop retrying and escalate to the user.',
          },
        ],
        isError: true,
      };
    }
    mcpLog.info(`Error check: auto-retrying (${this.initRetryCount}/${MAX_INIT_RETRY})`);
    this.arktsInitProgress = null;
    this.ensureProjectReady();
    return {
      content: [{ type: 'text', text: `Project initialization failed, auto-retrying.${this.buildRetrySuffix()}` }],
      isError: true
    };
  }

  /* ============================================================
   * ArkTS init progress helpers
   * ============================================================ */

  /** 固定 retry 后缀 */
  private buildRetrySuffix(): string {
    return ` Retry in ${RETRY_SEC}s. Expected total: 30s–10min (depends on project size).`;
  }

  /** 构建 ArkTS 初始化进度消息（三行：进度行 + 管道行 + retry 行） */
  private buildInitRetryMessage(): string {
    const p = this.arktsInitProgress;
    if (!p) {
      return `ArkTS init in progress.${this.buildRetrySuffix()}`;
    }
    const stepIdx = PHASE_ORDER.indexOf(p.phase) + 1;
    const phaseSec = Math.round((Date.now() - p.startedAt) / 1000);
    const totalSec = this.arktsPipelineStartedAt
      ? Math.round((Date.now() - this.arktsPipelineStartedAt) / 1000)
      : phaseSec;
    const pctStr = p.percent !== null ? ` (${p.percent}%)` : '';

    return [
      `ArkTS init [${stepIdx}/4] ${PHASE_LABELS[p.phase]}: ${p.detail}${pctStr} [${phaseSec}s, total ${totalSec}s]`,
      this.buildPipelineLine(p.phase),
      `Retry in ${RETRY_SEC}s. Expected total: 30s–10min (depends on project size).`,
    ].join('\n');
  }

  /** 构建管道状态行：✓ 已完成 / (…) 正在执行 / 省略 未开始 */
  private buildPipelineLine(currentPhase: ArktsInitProgress['phase']): string {
    const parts = PHASE_ORDER.map((phase) => {
      const done = PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(currentPhase);
      const running = phase === currentPhase;
      const label = PHASE_LABELS[phase];
      if (done) {
        return `${label} ✓`;
      }
      if (running) {
        return `${label}(…)`;
      }
      return label;
    });
    return `Pipeline: ${parts.join(' → ')}`;
  }

  /* ============================================================
   * C++ 路由（与 ArkTS routeArktsRequest 同构）
   * ============================================================ */

  /**
   * C++ 请求的统一状态机路由：IDLE_CPP/DISCOVERING_CPP/SYNCING_CPP/INITIALIZING_CPP/ERROR_CPP/READY_CPP。
   * 只有 READY_CPP 状态才执行 readyAction，其余返回 "please retry"。
   */
  private async routeCppRequest(
    logLabel: string,
    readyAction: () => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    switch (this.cppProjectState) {
      case CppLifecycle.IDLE_CPP:
        return this.handleCppIdleCheck();
      case CppLifecycle.DISCOVERING_CPP:
      case CppLifecycle.SYNCING_CPP:
        mcpLog.warn(`C++ ${logLabel} rejected: C++ project is ${CppLifecycle[this.cppProjectState]}`);
        return { content: [{ type: 'text', text: 'C++ project is syncing (compileNative), please retry in 25 seconds' }], isError: true };
      case CppLifecycle.INITIALIZING_CPP:
        mcpLog.warn(`C++ ${logLabel} rejected: clangd is initializing`);
        return { content: [{ type: 'text', text: 'C++ LSP (clangd) is initializing, please retry in 10 seconds' }], isError: true };
      case CppLifecycle.ERROR_CPP:
        return this.handleCppErrorCheck();
      case CppLifecycle.READY_CPP:
        if (!this.cppEnabled) {
          return { content: [{ type: 'text', text: 'C++ LSP is disabled. Set DEVECO_CLI_CPP_ENABLED=true to enable.' }], isError: true };
        }
        if (this.cppHasNoCppCode) {
          return { content: [{ type: 'text', text: 'No C++ code in this project' }], isError: true };
        }
        if (!this.cppLspManager?.ready) {
          return { content: [{ type: 'text', text: 'C++ LSP is not ready, please retry later' }], isError: true };
        }
        return readyAction();
      default:
        mcpLog.warn(`C++ ${logLabel} rejected: unknown C++ project state ${this.cppProjectState}`);
        return { content: [{ type: 'text', text: 'Unknown C++ project state, please retry' }], isError: true };
    }
  }

  /**
   * 按文件扩展名分流到 ArkTS 或 C++ 状态机。
   * - `.ets` → routeArktsRequest
   * - C/C++ 扩展名 → routeCppRequest
   * - 其他 → 返回 unsupported 错误
   */
  private async routeLspRequest(
    file: string,
    logLabel: string,
    readyAction: () => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (file.endsWith('.ets')) {
      return this.routeArktsRequest(logLabel, readyAction);
    }
    if (isSupportedCppFile(file)) {
      return this.routeCppRequest(logLabel, readyAction);
    }
    return { content: [{ type: 'text', text: `Unsupported file type: ${file} (only .ets and C/C++ source/header files are supported)` }], isError: true };
  }

  /** C++ IDLE_CPP 状态下检查：触发 ensureCppProjectReady，根据已有信息返回提示。 */
  private async handleCppIdleCheck(): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    this.ensureCppProjectReady();
    if (this.config.projectPath) {
      let msg: string;
      if (this.cppSyncSkippedDueToLock) {
        const elapsedSec = this.cppSyncSkipStartedAt > 0 ? Math.round((Date.now() - this.cppSyncSkipStartedAt) / 1000) : 0;
        msg = `Another build process is running, C++ sync deferred (waiting ${elapsedSec}s), please retry in 25 seconds`;
        this.cppSyncSkippedDueToLock = false;
      } else {
        msg = 'C++ project detected, syncing (compileNative), please retry in 25 seconds';
      }
      mcpLog.info(`C++ idle check: project '${this.config.projectPath}', triggering C++ init`);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
    return { content: [{ type: 'text', text: 'No HarmonyOS project detected for C++ tools.' }], isError: true };
  }

  /** C++ ERROR_CPP 状态下检查：自动重试（含冷却机制）。 */
  private async handleCppErrorCheck(): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    if (this.cppInitRetryCount >= MAX_INIT_RETRY) {
      mcpLog.error(`C++ init retry limit reached (${this.cppInitRetryCount}/${MAX_INIT_RETRY}), will not auto-retry`);
      return {
        content: [
          {
            type: 'text',
            text:
              `C++ project initialization failed repeatedly (auto-retry exhausted: ${this.cppInitRetryCount}/${MAX_INIT_RETRY}). ` +
              'Ask the user to investigate and confirm `hvigor compileNative` succeeds manually. ' +
              'Do NOT call the `restart` tool repeatedly — call it at most once after the user fixes the root cause; ' +
              'if it fails again, stop retrying and escalate to the user.',
          },
        ],
        isError: true,
      };
    }
    mcpLog.info(`C++ error check: auto-retrying (${this.cppInitRetryCount}/${MAX_INIT_RETRY})`);
    this.ensureCppProjectReady();
    return {
      content: [{ type: 'text', text: 'C++ project initialization failed, auto-retrying, please retry in 25 seconds' }],
      isError: true
    };
  }

  /** 调 C/C++ 工具；通过 C++ 状态机分流。 */
  private async callCppCheck(files: string[]): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    return this.routeCppRequest('check', async () => {
      return this.cppCheckTool!.handleCall({ files });
    });
  }

  /** 把单个子 handler 的返回合并到 errors / infos 池。 */
  private mergeCheckResult(
    result: { content: { type: string; text: string }[]; isError?: boolean },
    errors: string[],
    infos: string[]
  ): void {
    const text = result.content
      .map((c) => c.text)
      .filter((t) => t && t.trim().length > 0)
      .join('\n');
    if (!text) {
      return;
    }
    if (result.isError) {
      errors.push(text);
    } else {
      infos.push(text);
    }
  }

  /**
   * restart 状态守卫：target 涉及的侧仅在 READY/IDLE/ERROR 时允许；DISCOVERING/SYNCING/
   * INITIALIZING（健康进行中）返回错误提示，避免 agent 在大工程慢 init 期间误调 restart
   * 打断 sync/init。IDLE 放行：无 in-progress init 可打断，且偶尔是「卡 IDLE 需手动启动」的兜底
   *（restartArkts 内已用 initPromise 守 IDLE→DISCOVERING 切换竞态，仅设 needsReinit 延后）。
   */
  private assertRestartAllowed(
    target: 'arkts' | 'cpp' | 'all',
  ): { content: { type: string; text: string }[]; isError: true } | null {
    if (target === 'arkts' || target === 'all') {
      const s = this.projectState;
      if (s !== ProjectLifecycle.READY && s !== ProjectLifecycle.IDLE && s !== ProjectLifecycle.ERROR) {
        return {
          content: [{
            type: 'text',
            text:
              `ArkTS project state: ${this.describeArktsState()}, sync/init in progress, restart unavailable (would interrupt the current flow). ` +
              'Wait for the state to become ready and retry other tools directly—no restart needed. ' +
              'restart is only available in ready/idle/error states.',
          }],
          isError: true,
        };
      }
    }
    if (target === 'cpp' || target === 'all') {
      const cs = this.cppProjectState;
      if (cs !== CppLifecycle.READY_CPP && cs !== CppLifecycle.IDLE_CPP && cs !== CppLifecycle.ERROR_CPP) {
        return {
          content: [{
            type: 'text',
            text:
              `C++ project state: ${this.describeCppState()}, sync/init in progress, restart unavailable (would interrupt the current flow). ` +
              'Wait for the state to become ready and retry other tools directly—no restart needed. ' +
              'restart is only available in ready/idle/error states.',
          }],
          isError: true,
        };
      }
    }
    return null;
  }

  /**
   * restart 工具入口：原地重启 server（重置状态 + 重新 sync/init），客户端连接保持。
   * 按 target 选择重置 ArkTS 侧 / C++ 侧 / 双侧。fire-and-forget，立即返回提示。
   */
  private async handleRestartCall(
    args: Record<string, unknown>,
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const raw = (args as { target?: unknown }).target;
    const target: 'arkts' | 'cpp' | 'all' =
      raw === 'cpp' ? 'cpp' : raw === 'arkts' ? 'arkts' : 'all';
    if (target === 'cpp' && !this.cppEnabled) {
      return { content: [{ type: 'text', text: 'C++ LSP is disabled, cannot restart. Set DEVECO_CLI_CPP_ENABLED=true to enable.' }], isError: true };
    }
    // restart 仅在 READY/IDLE/ERROR 时执行；DISCOVERING/SYNCING/INITIALIZING 是健康进行中状态，
    // 此时 restart 会打断正在跑的 sync/init（大工程 init 尤其慢，常被 agent 误判卡死而误调）。
    const guard = this.assertRestartAllowed(target);
    if (guard) {
      return guard;
    }
    this.restartProject(target);
    const sides = target === 'all' ? 'ArkTS + C++' : target === 'cpp' ? 'C++' : 'ArkTS';
    return {
      content: [
        {
          type: 'text',
          text:
            `MCP server is restarting in-place (${sides}): re-sync project + re-initialize LSP. ` +
            `Client connection preserved—no need to exit the agent. Please retry tools in ~${RETRY_SEC}s.`,
        },
      ],
    };
  }

  /** 按 target 分流重置对应侧（或双侧）并触发重新初始化。 */
  private restartProject(target: 'arkts' | 'cpp' | 'all'): void {
    mcpLog.info(`[restart] resetting tools + state, re-init (target=${target})`);
    if (target === 'arkts' || target === 'all') {
      this.restartArkts();
    }
    if ((target === 'cpp' || target === 'all') && this.cppEnabled) {
      this.restartCpp();
    }
  }

  /** 重置 ArkTS 侧工具与状态，触发重新 sync/init（参照 setProjectPath 的 ArkTS 分支）。 */
  private restartArkts(): void {
    if (this.arktsCheckTool) {
      this.arktsCheckTool.shutdown().catch((err) =>
        mcpLog.warn('Failed to shutdown ArktsCheckTool during restart:', err),
      );
      this.arktsCheckTool = null;
    }
    this.initRetryCount = 0;
    this.syncSkippedDueToLock = false;
    this.syncSkipStartedAt = 0;
    this.configChangedTriggeredResync = false;
    if (this.initPromise) {
      this.needsReinit = true;
      mcpLog.info('[restart] ArkTS init is running, will reinit after current init completes');
    } else {
      this.projectState = ProjectLifecycle.IDLE;
      this.ensureProjectReady().catch((err) =>
        mcpLog.warn('Failed to re-init ArkTS project during restart:', err),
      );
    }
  }

  /** 重置 C++ 侧工具与状态，触发重新 compileNative + clangd init（参照 setProjectPath 的 C++ 分支）。 */
  private restartCpp(): void {
    this.cppCheckTool = null;
    this.cppLspTool = null;
    if (this.cppLspManager) {
      this.cppLspManager.dispose().catch((err) =>
        mcpLog.warn('Failed to dispose ClangdLspManager during restart:', err),
      );
      this.cppLspManager = null;
    }
    this.cppInitRetryCount = 0;
    this.cppHasNoCppCode = false;
    this.cppSyncSkippedDueToLock = false;
    this.cppSyncSkipStartedAt = 0;
    if (this.cppInitPromise) {
      this.cppNeedsReinit = true;
      mcpLog.info('[restart] C++ init is running, will reinit after current init completes');
    } else {
      this.cppProjectState = CppLifecycle.IDLE_CPP;
      this.ensureCppProjectReady().catch((err) =>
        mcpLog.warn('Failed to re-init C++ project during restart:', err),
      );
    }
  }

  /**
   * Start the MCP server with stdio transport.
   *
   * project_path 优先级：
   *  1. 环境变量 PROJECT_PATH（构造时已解析）
   *  2. MCP 客户端 listRoots 返回的 workspace root
   *  3. 无 project path → LSP 初始化跳过
   */
  async start(): Promise<void> {
    // Phase 1: 协议就绪。socket 探测需 spawn 子进程（异步、结果缓存），
    // 且 restart 是否注册取决于探测结论，故必须在 registerTools 之前完成。
    await this.detectSocketAvailable();
    this.registerTools();
    this.toolRouter.registerToServer(this.server);
    const transport = new StdioServerTransport();
    await this.server.connect(transport); // ← 立刻完成，MCP 连接就绪

    mcpLog.info('devecocli-mcp-server started');
    // 非 debug 模式下，打印日志文件路径
    if (!this.config.debug) {
      const logPath = getMcpLogFilePath();
      if (logPath) {
        mcpLog.info(`Log file: ${logPath}`);
      }
    }

    this.setupStdinCloseHandler();

    // Phase 2: 尝试获取 workspace root（只负责发现路径，不触发初始化）
    if (!this.config.projectPath) {
      const clientRoot = await this.getProjectRootFromClient();
      if (clientRoot) {
        this.workspaceRoot = clientRoot;
        const harmonyRoot = findHarmonyProject(clientRoot);
        if (harmonyRoot) {
          mcpLog.info(`Detected project path from client root: ${harmonyRoot}`);
          this.config.projectPath = harmonyRoot;
        } else {
          mcpLog.warn(`Client root '${clientRoot}' is not a HarmonyOS project`);
        }
      } else if (this.originalProjectPath) {
        mcpLog.warn(`PROJECT_PATH '${this.originalProjectPath}' was provided but no HarmonyOS project was found in it`);
      } else {
        mcpLog.info('project path is empty (no PROJECT_PATH env and client did not provide roots)');
      }
    } else {
      this.workspaceRoot = this.config.projectPath;
    }

    // Phase 3: 后台触发项目初始化（fire-and-forget，不阻塞）
    // ArkTS sync 先行（持 build lock），完成后在 doEnsureProjectReady 内触发 C++ 同步
    // （lock 已释放），避免 ArkTS/C++ 并行抢锁导致 C++ sync 被跳过、clangd 不被拉起
    this.ensureProjectReady().catch(err => {
      mcpLog.warn('Background project init failed:', err);
    });
  }

  /**
   * 从 MCP 客户端获取 workspace root。
   *
   * 参考 Rust 版 lib.rs 中 `get_project_root_from_client` 的实现：
   * 调用 `listRoots()` 获取客户端提供的 workspace roots，取第一个 root 的 URI，
   * 解析为本地文件路径。
   */
  private async getProjectRootFromClient(): Promise<string | null> {
    try {
      const result = await this.server.server.listRoots();
      const firstRoot = result.roots?.[0];
      if (!firstRoot) {
        mcpLog.warn('Client did not provide any roots');
        return null;
      }

      const uri = firstRoot.uri;
      return this.resolveFileUri(uri);
    } catch (err) {
      mcpLog.warn('Failed to list roots from client:', err);
      return null;
    }
  }

  /**
   * 将 URI 解析为本地文件路径。
   *
   * 处理以下格式：
   *  - `file:///C:/Users/project` (Windows) → `C:/Users/project`
   *  - `file:///Users/project` (macOS/Linux) → `/Users/project`
   *  - 非 file:// URI → 原样返回
   */
  private resolveFileUri(uri: string): string | null {
    // 尝试使用 URL API 解析
    try {
      const url = new URL(uri);
      if (url.protocol === 'file:') {
        // URL API 的 pathname 在 Windows 上是 `/C:/Users/project`，
        // 需要去掉前导斜杠
        const pathname = url.pathname;
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) {
          return pathname.substring(1);
        }
        return pathname;
      }
    } catch (err) {
      mcpLog.warn('Failed to parse URI with URL API, falling back to manual parsing:', err);
      // URL 解析失败，走手动解析
    }

    // 手动解析 file:// URI
    if (uri.startsWith('file://')) {
      let filePath = uri.substring('file://'.length);

      // URL 解码（处理 %20 等编码字符）
      filePath = decodeURIComponent(filePath);

      // Windows: file:///C:/Users/project → C:/Users/project
      if (process.platform === 'win32' && filePath.startsWith('/') && /^[A-Za-z]:/.test(filePath.substring(1))) {
        filePath = filePath.substring(1);
      }

      return filePath;
    }

    // 非 file:// URI，原样返回
    return uri;
  }

  /**
   * 监听 stdin close/end 事件，当 MCP 客户端断开连接后自动触发 shutdown 并退出进程。
   */
  private setupStdinCloseHandler(): void {
    let shutdownTriggered = false;

    const triggerShutdown = (): void => {
      if (shutdownTriggered) {
        return;
      }
      shutdownTriggered = true;
      mcpLog.info('stdin closed (MCP client disconnected), shutting down...');

      this.shutdown()
        .then(() => {
          mcpLog.info('shutdown completed, exiting process');
          process.exit(0);
        })
        .catch((err) => {
          mcpLog.error('shutdown failed:', err);
          process.exit(1);
        });
    };

    process.stdin.on('end', triggerShutdown);
    process.stdin.on('close', triggerShutdown);
  }

  /**
   * 统一入口：互斥 + 内部按状态分流。
   * - initPromise 为 null → 无初始化正在进行，可以进入
   * - initPromise 非 null → 已有初始化正在进行，直接返回（幂等）
   * - 内部 doEnsureProjectReady() 根据当前状态决定行为路径
   */
  private async ensureProjectReady(): Promise<void> {
    // 互斥：已有初始化正在进行，直接返回
    if (this.initPromise) {
      return;
    }

    this.initPromise = this.doEnsureProjectReady();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }

    // 完成后检查是否有路径变更待处理（setProjectPath 在初始化运行期间被调用的情况）
    if (this.needsReinit) {
      this.needsReinit = false;
      this.projectState = ProjectLifecycle.IDLE;
      this.ensureProjectReady().catch(err => {
        mcpLog.warn('Failed to re-init project after needsReinit:', err);
      });
    }
  }

  private discoverProject(): boolean {
    const needsDiscovery = (this.projectState === ProjectLifecycle.IDLE || this.projectState === ProjectLifecycle.ERROR) && 
      !this.config.projectPath;
    if (!needsDiscovery) {
      return true;
    }
    this.projectState = ProjectLifecycle.DISCOVERING;
    let found = this.workspaceRoot ? findHarmonyProject(this.workspaceRoot) : null;
    if (!found && this.originalProjectPath) {
      found = findHarmonyProject(this.originalProjectPath);
      if (found) {
        mcpLog.info(`Phase 1 found HarmonyOS project from original config: ${found}`);
      }
    }
    if (!found) {
      this.projectState = ProjectLifecycle.IDLE;
      return false;
    }
    this.config.projectPath = found;
    this.initRetryCount = 0;
    return true;
  }

  private async doEnsureProjectReady(): Promise<void> {
    if (!this.discoverProject()) {
      return;
    }

    this.arktsPipelineStartedAt = Date.now();
    this.arktsInitProgress = {
      phase: 'ohpm',
      detail: 'installing dependencies',
      percent: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (!(await this.ensureProjectSynced())) {
      this.arktsInitProgress = null;
      return;
    }

    // ArkTS sync 完成 → build lock 已释放，触发 C++ 同步（与下方 ArkTS LSP 初始化并行，
    // 确保 MCP server 启动时 clangd 也被拉起，而非等到首次调用 C++ 工具时才惰性触发）
    this.ensureCppProjectReady().catch(err => {
      mcpLog.warn('Background C++ project init failed:', err);
    });

    this.projectState = ProjectLifecycle.INITIALIZING;
    this.arktsInitProgress = {
      phase: 'dep-parse',
      detail: 'parsing dependency map',
      percent: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.arktsCheckTool = this.createArktsCheckTool();
    const initStart = Date.now();
    try {
      await this.arktsCheckTool.initialize();
      this.projectState = ProjectLifecycle.READY;
      this.initRetryCount = 0;
      this.arktsInitProgress = null;
      mcpLog.info('Project fully initialized, check tool is available');
      await this.trackInit('init_arkts', initStart, true, null, this.arktsCheckTool?.aceServerPid ?? null);
    } catch (err) {
      mcpLog.error('LSP initialization failed:', err);
      const errorCode = toTraceErrorCode(err);
      const arktsPid = this.arktsCheckTool?.aceServerPid ?? null;
      this.arktsCheckTool = null;
      this.arktsInitProgress = null;
      this.initRetryCount++;
      this.projectState = ProjectLifecycle.ERROR;
      await this.trackInit('init_arkts', initStart, false, errorCode, arktsPid);
    }
  }

  /** 创建 ArktsCheckTool 并注册进度/配置变化回调 */
  private createArktsCheckTool(): ArktsCheckTool {
    const tool = new ArktsCheckTool(
      this.config.projectPath!,
      this.sdkPath,
      this.arktsLangServerPath,
      this.config.nodeMaxOldSpaceSize,
      this.nodePath,
      this.socketAvailable,
    );
    tool.setOnConfigChanged(() => {
      mcpLog.info('Config files changed, resetting to IDLE state for reinit');
      this.configChangedTriggeredResync = true;
      this.needsReinit = true;
      this.projectState = ProjectLifecycle.IDLE;
    });
    tool.setOnInitProgress((detail, percent) => {
      if (this.arktsInitProgress) {
        this.arktsInitProgress.phase = 'lsp-init';
        this.arktsInitProgress.detail = detail;
        this.arktsInitProgress.percent = percent;
        this.arktsInitProgress.updatedAt = Date.now();
      }
    });
    tool.setOnDepParseProgress((current, total) => {
      if (this.arktsInitProgress) {
        this.arktsInitProgress.phase = 'dep-parse';
        this.arktsInitProgress.detail = `${current}/${total} modules`;
        this.arktsInitProgress.percent = total > 0 ? Math.round((current / total) * 100) : null;
        this.arktsInitProgress.updatedAt = Date.now();
      }
    });
    return tool;
  }

  private async ensureProjectSynced(): Promise<boolean> {
    const projectPath = this.config.projectPath!;

    const syncCheck = checkSyncRequired(projectPath);
    const lockExists = fs.existsSync(path.join(projectPath, 'oh-package-lock.json5'));
    const ohModulesExists =
      fs.existsSync(path.join(projectPath, 'oh_modules')) &&
      fs.readdirSync(path.join(projectPath, 'oh_modules')).length > 0;

    if (lockExists && ohModulesExists) {
      // lock + oh_modules 都在 → ohpm install 跟着 checkSyncRequired 跳过/执行
      if (!syncCheck.required) {
        mcpLog.info(`Sync skipped: ${syncCheck.reason}`);
        return true;
      }
      mcpLog.info(`Sync required: ${syncCheck.reason}`);
      return this.runSync(projectPath, { skipHvigorSync: false });
    }

    // lock 或 oh_modules 缺失 → ohpm install 全流程必须跑，hvigor 由 checkSyncRequired 决定
    const skipHvigor = !syncCheck.required;
    mcpLog.info(
      `Sync check: skipHvigor=${skipHvigor}, ohpm install forced (lock=${lockExists}, ohModules=${ohModulesExists}), reason=${syncCheck.reason}`
    );
    return this.runSync(projectPath, { skipHvigorSync: skipHvigor });
  }

  private async runSync(projectPath: string, options?: { skipHvigorSync?: boolean }): Promise<boolean> {
    this.projectState = ProjectLifecycle.SYNCING;
    mcpLog.info('Starting project sync...');
    const onOhpmLine = (line: string) => {
      if (this.arktsInitProgress) {
        this.arktsInitProgress.phase = 'ohpm';
        this.arktsInitProgress.detail = line;
        this.arktsInitProgress.percent = null;
        this.arktsInitProgress.updatedAt = Date.now();
      }
    };
    const onHvigorLine = (line: string) => {
      if (this.arktsInitProgress) {
        this.arktsInitProgress.phase = 'hvigor';
        this.arktsInitProgress.detail = line;
        this.arktsInitProgress.percent = null;
        this.arktsInitProgress.updatedAt = Date.now();
      }
    };
    const result = await ArktsLspManager.handleSyncProject(
      projectPath,
      this.sdkPath,
      this.nodePath,
      this.ohpmJsPath,
      this.hvigorJsPath,
      options,
      onOhpmLine,
      onHvigorLine,
    );
    return this.handleSyncResult(result);
  }

  private handleSyncResult(result: SyncResult): boolean {
    switch (result.status) {
      case 'success':
        this.syncSkippedDueToLock = false;
        this.syncSkipStartedAt = 0;
        return true;
      case 'skipped': {
        this.syncSkippedDueToLock = true;
        if (this.syncSkipStartedAt === 0) {
          this.syncSkipStartedAt = Date.now();
        }
        const elapsedMs = Date.now() - this.syncSkipStartedAt;
        const elapsedSec = Math.round(elapsedMs / 1000);
        if (elapsedMs >= SYNC_SKIP_TIMEOUT_MS) {
          mcpLog.error(`Sync skipped for ${elapsedSec}s due to lock contention, giving up`);
          this.initRetryCount++;
          this.syncSkipStartedAt = 0;
          this.projectState = ProjectLifecycle.ERROR;
          return false;
        }
        mcpLog.warn(`Sync skipped: ${result.reason}, resetting to IDLE for retry (elapsed ${elapsedSec}s / ${SYNC_SKIP_TIMEOUT_MS / 1000}s)`);
        this.projectState = ProjectLifecycle.IDLE;
        return false;
      }
      case 'failed':
        mcpLog.error(`Project sync failed: ${result.reason}`);
        this.syncSkippedDueToLock = false;
        this.syncSkipStartedAt = 0;
        this.initRetryCount++;
        this.projectState = ProjectLifecycle.ERROR;
        return false;
      default:
        mcpLog.error(`Project sync: unknown status ${(result as { status: string }).status}`);
        this.syncSkippedDueToLock = false;
        this.syncSkipStartedAt = 0;
        this.initRetryCount++;
        this.projectState = ProjectLifecycle.ERROR;
        return false;
    }
  }

  /* ============================================================
   * C++ 项目生命周期（与 ArkTS 状态机并行，独立运转）
   * ============================================================ */

  /**
   * C++ 初始化互斥入口：与 {@link ensureProjectReady} 同构。
   */
  private async ensureCppProjectReady(): Promise<void> {
    // C++ LSP 开关关闭时直接标记就绪，不执行任何初始化（不扫描模块、不 compileNative、不 spawn clangd）
    if (!this.cppEnabled) {
      mcpLog.info('[Cpp] C++ LSP disabled by config, skipping initialization');
      this.cppHasNoCppCode = true;
      this.cppProjectState = CppLifecycle.READY_CPP;
      return;
    }
    if (this.cppInitPromise) {
      return;
    }
    this.cppInitPromise = this.doEnsureCppProjectReady();
    try {
      await this.cppInitPromise;
    } finally {
      this.cppInitPromise = null;
    }
    if (this.cppNeedsReinit) {
      this.cppNeedsReinit = false;
      this.cppProjectState = CppLifecycle.IDLE_CPP;
      this.ensureCppProjectReady().catch((err) => {
        mcpLog.warn('Failed to re-init C++ project after cppNeedsReinit:', err);
      });
    }
  }

  /**
   * C++ 初始化主流程：DISCOVERING_CPP → SYNCING_CPP → INITIALIZING_CPP → READY_CPP/ERROR_CPP
   */
  /**
   * 解析用户自定义 compile_commands.json 所在目录（按"路径模板 + 工程根"缓存）。
   * 缓存键命中时直接返回上次结果；未配置或解析失败返回 null（走默认同步流程）。
   */
  private resolveCppCustomDir(): string | null {
    const key = `${this.config.cppCompileCommandsPath ?? ''}|${this.config.projectPath ?? ''}`;
    if (key !== this.cppCustomDirResolvedFor) {
      this.cppCustomDirResolvedFor = key;
      this.cppCustomCompileCommandsDir = resolveCustomCompileCommandsDir(
        this.config.cppCompileCommandsPath,
        this.config.projectPath,
      );
      if (this.cppCustomCompileCommandsDir) {
        mcpLog.info(`[Cpp] Custom compile_commands dir resolved: ${this.cppCustomCompileCommandsDir}`);
      }
    }
    return this.cppCustomCompileCommandsDir;
  }

  private async doEnsureCppProjectReady(): Promise<void> {
    const projectPath = this.config.projectPath;
    if (!projectPath) {
      mcpLog.info('[Cpp] No project path, skipping C++ init');
      return;
    }

    // 用户自定义 compile_commands.json（DEVECO_CLI_CPP_COMPILE_COMMANDS）：
    // 跳过模块发现 + compileNative 同步，clangd 直接读取该编译数据库。
    // 支持绝对路径 / {workspace} 占位符 / 相对路径，按当前工程根解析并缓存。
    const customDir = this.resolveCppCustomDir();
    if (customDir) {
      mcpLog.info(`[Cpp] Custom compile_commands.json configured, skipping compileNative sync (dir: ${customDir})`);
      this.cppHasNoCppCode = false;
      await this.initCppLsp(projectPath);
      return;
    }

    // Phase 1: DISCOVERING_CPP — 检测 C++ 模块
    this.cppProjectState = CppLifecycle.DISCOVERING_CPP;
    const cppModules = findCppModules(projectPath);
    if (cppModules.length === 0) {
      mcpLog.info('[Cpp] No C++ modules found, C++ tools will return "no C++ code"');
      this.cppHasNoCppCode = true;
      this.cppProjectState = CppLifecycle.READY_CPP;
      this.cppInitRetryCount = 0;
      return;
    }
    this.cppHasNoCppCode = false;
    mcpLog.info(`[Cpp] Found ${cppModules.length} C++ module(s): ${cppModules.map((m) => m.name).join(', ')}`);

    // Phase 2: SYNCING_CPP — compileNative + 合并 compile_commands.json
    // 启动期同步检查：工程未变更时跳过 compileNative（复用上次的 compile_commands.json）
    const cppSyncCheck = checkCppSyncRequired(projectPath);
    const skipCompileNative = !cppSyncCheck.required;
    mcpLog.info(`[Cpp] C++ sync check: skipCompileNative=${skipCompileNative}, reason=${cppSyncCheck.reason}`);
    if (!(await this.runSyncCpp(projectPath, { skipCompileNative }))) {
      return;
    }

    // Phase 3: INITIALIZING_CPP — clangd spawn + initialize（manager 自管 await 就绪）
    await this.initCppLsp(projectPath);
  }

  /** Phase 3：spawn clangd + LSP initialize 握手 + 创建 C++ 工具实例。 */
  private async initCppLsp(projectPath: string): Promise<void> {
    this.cppProjectState = CppLifecycle.INITIALIZING_CPP;
    this.cppLspManager = new ClangdLspManager({
      workspaceRoot: projectPath,
      clangdPath: this.clangdPath ?? '',
      ...(this.cppCustomCompileCommandsDir
        ? { compileCommandsDir: this.cppCustomCompileCommandsDir }
        : {}),
    });
    const initStart = Date.now();
    try {
      await this.cppLspManager.start();
      this.cppCheckTool = new CppCheckTool(this.cppLspManager);
      this.cppLspTool = new ClangdLspTool(this.cppLspManager);
      this.cppProjectState = CppLifecycle.READY_CPP;
      this.cppInitRetryCount = 0;
      mcpLog.info('[Cpp] C++ project fully initialized, C++ tools are available');
      await this.trackInit('init_cpp', initStart, true, null, this.cppLspManager?.clangdPid ?? null);
    } catch (err) {
      mcpLog.error('[Cpp] C++ LSP initialization failed:', err);
      const errorCode = toTraceErrorCode(err);
      const cppPid = this.cppLspManager?.clangdPid ?? null;
      if (this.cppLspManager) {
        this.cppLspManager.dispose().catch(() => {});
      }
      this.cppLspManager = null;
      this.cppCheckTool = null;
      this.cppLspTool = null;
      this.cppInitRetryCount++;
      this.cppProjectState = CppLifecycle.ERROR_CPP;
      await this.trackInit('init_cpp', initStart, false, errorCode, cppPid);
    }
  }

  /**
   * 落盘一条 `devecocli_serve_mcp` 事件（subAction 为 init_arkts / init_cpp）：
   * measurement 含该语言后端初始化耗时 / 成败 / 错误码，event_detail 含 mcp 父进程内存
   * 与对应 LSP 子进程内存（arkts=ace-server pid，cpp=clangd pid，均经 readProcessRss 采样）。
   * 用 §3.1 无被测函数重载。
   */
  private async trackInit(
    subAction: 'init_arkts' | 'init_cpp',
    start: number,
    success: boolean,
    errorCode: string | null,
    lspPid: number | null,
  ): Promise<void> {
    if (!this.config.telemetry) {
      return;
    }
    let lspMemory = 'unknown';
    if (lspPid !== null) {
      const rssKb = await readProcessRss(lspPid);
      if (rssKb !== null) {
        lspMemory = formatBytesMb(Number(rssKb) * 1024);
      }
    }
    const event: McpToolCall = {
      event: EventType.McpToolCall,
      subAction,
      mcpMemory: formatBytesMb(process.memoryUsage().rss),
      lspMemory,
    };
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await this.config.telemetry.track(event, measurement).catch(() => {});
  }

  /**
   * C++ sync 阶段：执行 compileNative + 合并 compile_commands.json。
   * 与 {@link runSync} 同构：处理 success/skipped/failed 三种结果。
   *
   * @param options.skipCompileNative 为 true 时跳过 compileNative + 合并步骤
   *   （由 {@link doEnsureCppProjectReady} 经 {@link checkCppSyncRequired} 判定后传入）。
   */
  private async runSyncCpp(projectPath: string, options?: { skipCompileNative?: boolean }): Promise<boolean> {
    this.cppProjectState = CppLifecycle.SYNCING_CPP;
    mcpLog.info('[Cpp] Starting C++ project sync (compileNative)...');
    // sdkPath 已在启动期固定（env / CLT|Studio 布局），compileNative 使用注入的 node/hvigor。
    const result = await ClangdLspManager.handleSyncCppProject(
      projectPath,
      this.sdkPath,
      this.nodePath,
      this.hvigorJsPath,
      options,
    );
    switch (result.status) {
      case 'success':
        this.cppSyncSkippedDueToLock = false;
        this.cppSyncSkipStartedAt = 0;
        return true;
      case 'skipped': {
        this.cppSyncSkippedDueToLock = true;
        if (this.cppSyncSkipStartedAt === 0) {
          this.cppSyncSkipStartedAt = Date.now();
        }
        const elapsedMs = Date.now() - this.cppSyncSkipStartedAt;
        const elapsedSec = Math.round(elapsedMs / 1000);
        if (elapsedMs >= SYNC_SKIP_TIMEOUT_MS) {
          mcpLog.error(`[Cpp] C++ sync skipped for ${elapsedSec}s due to lock contention, giving up`);
          this.cppInitRetryCount++;
          this.cppSyncSkipStartedAt = 0;
          this.cppProjectState = CppLifecycle.ERROR_CPP;
          return false;
        }
        mcpLog.warn(`[Cpp] C++ sync skipped: ${result.reason}, resetting to IDLE_CPP for retry (elapsed ${elapsedSec}s)`);
        this.cppProjectState = CppLifecycle.IDLE_CPP;
        return false;
      }
      case 'failed':
        mcpLog.error(`[Cpp] C++ project sync failed: ${result.reason}`);
        this.cppSyncSkippedDueToLock = false;
        this.cppSyncSkipStartedAt = 0;
        this.cppInitRetryCount++;
        this.cppProjectState = CppLifecycle.ERROR_CPP;
        return false;
    }
    return false;
  }

  /**
   * Shutdown the server: 关闭所有 LSP 子进程、MCP Server 连接、日志。
   */
  async shutdown(): Promise<void> {
    if (this.arktsCheckTool) {
      await this.arktsCheckTool.shutdown();
    }
    if (this.cppLspManager) {
      await this.cppLspManager.dispose();
    }
    this.cppCheckTool = null;
    this.cppLspTool = null;

    try {
      await this.server.close();
    } catch (err) {
      mcpLog.warn('Failed to close MCP server connection:', err);
    }

    mcpLog.info('devecocli-mcp-server stopped');
    flushMcpLogger();
    disposeMcpLogger();
  }

  /**
   * Get the tool router
   */
  getToolRouter(): ToolRouter {
    return this.toolRouter;
  }

  /**
   * Get the MCP server instance
   */
  getServer(): McpServer {
    return this.server;
  }
}

/**
 * 把入参里的文件按扩展名分桶。注意：这里只做扩展名判断，
 * 不做"文件是否存在 / 是否是普通文件"等检查——这些由各自的 LSP 工具自身负责。
 */
function classifyFiles(files: string[]): {
  etsFiles: string[];
  cppFiles: string[];
  unsupported: string[];
} {
  const etsFiles: string[] = [];
  const cppFiles: string[] = [];
  const unsupported: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.ets') {
      etsFiles.push(file);
    } else if (isSupportedCppFile(file)) {
      cppFiles.push(file);
    } else {
      unsupported.push(file);
    }
  }
  return { etsFiles, cppFiles, unsupported };
}

/**
 * Create a new MCP server
 */
export function createMcpServer(config: McpServerConfig = {}): DevecoCliMcpServer {
  return new DevecoCliMcpServer(config);
}
