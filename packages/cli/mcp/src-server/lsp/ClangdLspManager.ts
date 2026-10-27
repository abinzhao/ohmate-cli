/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ClangdLspProxy } from './ClangdLspProxy.js';
import { tryWithBuildLock } from '../../../src/utils/build-lock.js';
import { initializeCppProject, findCppModules } from './sync/cpp-compile.js';
import {
    findHarmonyProject,
    compileCommandsPath,
    getMcpLogDirectory,
    normalizePath,
} from '../utils/common.js';
import { initializeLogger, logger } from './logger.js';
import type { LspMessage } from './types.js';
import { JSONRPC_VERSION, LSP_METHOD, LSP_INIT_TIMEOUT_MS } from './constant.js';
import * as path from 'path';
import * as fs from 'fs';

export interface ClangdLspManagerConfig {
    /** 工程根路径（可为原始配置路径，start() 内部会解析为真实 harmony root）。 */
    workspaceRoot: string;
    /** 启动期由 ToolProvider 解析固定的 clangd 可执行文件路径。 */
    clangdPath: string;
    /** 日志根目录；缺省时由 start() 在 mcp 日志目录下生成。 */
    logPath?: string;
    /**
     * compile_commands.json 所在目录覆盖（用户自定义编译数据库场景）。
     * 缺省时使用 <project>/.idea/.deveco/cxx。
     */
    compileCommandsDir?: string;
}

export type CppSyncResult =
    | { status: 'success' }
    | { status: 'failed'; reason: string }
    | { status: 'skipped'; reason: string };

/**
 * ClangdLspManager — C++ LSP 后端。
 *
 * 自管生命周期：`start()` 内部完成工程解析 / 日志初始化 / spawn clangd / LSP initialize 握手，
 * 返回的 Promise 在 clangd 就绪时 resolve、失败或超时时 reject。上层（`DevecoCliMcpServer`）
 * 持有本实例，`CppCheckTool` 与 `ClangdLspTool` 作为无状态适配器复用同一实例。
 *
 * - 直接持有 {@link ClangdLspProxy}（其内部 spawn clangd 子进程）；
 * - 不持有 ConfigFileWatcher / DependencyMapWatcher（首版不实现 CxxWatcher）；
 * - `handleSyncCppProject` 执行 compileNative + 合并 compile_commands.json。
 */
export class ClangdLspManager {
    private readonly config: ClangdLspManagerConfig;
    private proxy: ClangdLspProxy | null = null;
    private isInitialized: boolean = false;
    private onMessage: (msg: LspMessage) => void = () => {};
    /** dispose 仅执行一次 */
    private disposeOnce: Promise<void> | null = null;

    /** start() 协调：await 就绪 / 失败 / 超时 */
    private initPromise: Promise<void> | null = null;
    private initDeadlineTimer: NodeJS.Timeout | null = null;
    private initResolve: (() => void) | null = null;
    private initReject: ((err: Error) => void) | null = null;

    /** start() 解析出的真实 harmony root（供 tool 层做相对路径解析）。 */
    private resolvedRoot: string = '';

    constructor(config: ClangdLspManagerConfig) {
        this.config = config;
    }

    setOnMessage(callback: (msg: LspMessage) => void): void {
        this.onMessage = callback;
    }

    /** 是否已就绪。 */
    get ready(): boolean {
        return this.isInitialized && this.proxy !== null;
    }

    /** clangd 子进程 pid（未启动 / 已 dispose 时为 null）。 */
    get clangdPid(): number | null {
        return this.proxy?.clangdPid ?? null;
    }

    /** start() 解析出的真实 harmony root（start 之前为空）。 */
    get projectRoot(): string {
        return this.resolvedRoot;
    }

    /**
     * 启动 clangd 并 await 就绪：resolve=就绪，reject=失败/超时。
     * 已就绪则立即返回；已在启动中则复用 in-flight Promise。
     */
    async start(): Promise<void> {
        if (this.isInitialized) {
            return;
        }
        if (this.initPromise) {
            await this.initPromise;
            return;
        }
        this.initPromise = this.doStart();
        try {
            await this.initPromise;
        } catch (e) {
            // 失败后清空，允许后续重试（上层会重建实例）
            this.initPromise = null;
            throw e;
        }
    }

    /** 上行通知（如 textDocument/didOpen / didChange / didClose） */
    sendNotification(msg: LspMessage): void {
        if (!this.proxy) {
            logger.warn('[ClangdLspManager] sendNotification before LSP ready, dropped');
            return;
        }
        this.dispatchNotification(msg);
    }

    /** 上行请求（hover / definition / references）— 通过 sendFeatureRequest await 结果。 */
    async sendFeatureRequest(method: string, params: unknown): Promise<unknown> {
        if (!this.proxy) {
            throw new Error('[ClangdLspManager] LSP not ready');
        }
        return this.proxy.sendFeatureRequest(method, params);
    }

    /** 注册 publishDiagnostics 回调（按 uri 匹配）。返回 Promise 等待诊断结果。 */
    registerDiagnosticCallback(uri: string): Promise<unknown> {
        if (!this.proxy) {
            return Promise.reject(new Error('[ClangdLspManager] LSP not ready'));
        }
        return this.proxy.registerDiagnosticCallback(uri);
    }

    /**
     * 处理 `cpp/syncProject`：原子性尝试获取构建锁后执行 compileNative + 合并 compile_commands.json。
     *
     * 锁策略与 {@link ArktsLspManager.handleSyncProject} 一致：
     * - 原子性尝试获取锁（无重试），若其他进程已持有构建锁则返回 skipped
     * - 消除 isBuildLocked + withBuildLock 之间的 TOCTOU 竞态
     *
     * @param options.skipCompileNative 为 true 时跳过 compileNative + 合并步骤
     *   （由启动期 {@link checkCppSyncRequired} 判定工程未变更时设置，
     *    复用上一次生成的 compile_commands.json）。
     */
    static async handleSyncCppProject(
        workspaceRoot: string,
        sdkPath: string,
        nodePath: string,
        hvigorJsPath: string,
        options?: { skipCompileNative?: boolean },
    ): Promise<CppSyncResult> {
        logger.info('[ClangdLspManager] Received cpp/syncProject');
        if (!workspaceRoot || !sdkPath) {
            logger.error('[ClangdLspManager] handleSyncCppProject: workspaceRoot or sdkPath is empty');
            return { status: 'failed', reason: 'workspaceRoot or sdkPath is empty' };
        }

        // 快速检测：无 C++ 模块时直接 success（不获取锁，不执行 compileNative）
        const cppModules = findCppModules(workspaceRoot);
        if (cppModules.length === 0) {
            logger.info('[ClangdLspManager] No C++ modules found, skipping compileNative');
            return { status: 'success' };
        }

        const skipCompileNative = options?.skipCompileNative === true;

        const result = await tryWithBuildLock(
            workspaceRoot,
            skipCompileNative
                ? async () => {
                    logger.info('[ClangdLspManager] compileNative skipped (C++ project up-to-date)');
                    return { status: 'success' as const };
                }
                : async () => ClangdLspManager.executeCompileNative(workspaceRoot, sdkPath, nodePath, hvigorJsPath),
        );
        if (!result.acquired) {
            logger.info('[ClangdLspManager] Build lock held by another process, skipping sync');
            return { status: 'skipped', reason: 'build lock held by another process' };
        }
        return result.result;
    }

    /** 执行 compileNative + 合并 compile_commands.json，返回成功/失败结果。 */
    private static async executeCompileNative(
        workspaceRoot: string,
        sdkPath: string,
        nodePath: string,
        hvigorJsPath: string,
    ): Promise<CppSyncResult> {
        try {
            await initializeCppProject(workspaceRoot, sdkPath, nodePath, hvigorJsPath);
            logger.info('[ClangdLspManager] compileNative + merge compile_commands completed');
            return { status: 'success' as const };
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            logger.error(`[ClangdLspManager] compileNative failed: ${reason}`);
            return { status: 'failed' as const, reason };
        }
    }

    async dispose(): Promise<void> {
        if (!this.disposeOnce) {
            this.disposeOnce = this.performDispose();
        }
        return this.disposeOnce;
    }

    // ---------- 内部实现 ----------

    /** start() 主流程：构造 Promise + 超时，触发 startProxy（fire-and-forget）。 */
    private doStart(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.initResolve = resolve;
            this.initReject = reject;
            this.armInitTimer(LSP_INIT_TIMEOUT_MS);
            try {
                this.startProxy();
            } catch (e) {
                this.failInit(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    /**
     * 解析工程 / 日志 / clangd 路径，创建 ClangdLspProxy 并 fire-and-forget 启动。
     * 成功/失败由 {@link handleProxyInitialized} 回调 → resolve/reject。
     */
    private startProxy(): void {
        // 1. 解析真实 harmony root
        const harmonyRoot = findHarmonyProject(this.config.workspaceRoot);
        this.resolvedRoot = harmonyRoot ? normalizePath(harmonyRoot) : normalizePath(this.config.workspaceRoot);

        // 2. 日志路径 + 初始化 logger
        const logPath = this.config.logPath ?? this.getLogPath();
        initializeLogger(logPath);

        // 3. clangd 路径由启动期 ToolProvider 解析固定并注入
        const clangdPath = this.config.clangdPath;
        if (!clangdPath) {
            const errMsg = 'clangd not found (install DevEco Studio / CLT)';
            logger.error(`[ClangdLspManager] ${errMsg}`);
            this.failInit(new Error(errMsg));
            return;
        }

        const compileCommandsDir =
            this.config.compileCommandsDir ?? path.dirname(compileCommandsPath(this.resolvedRoot));

        // 确保 compile_commands.json 所在目录存在（clangd 启动时不会自动创建）
        try {
            fs.mkdirSync(compileCommandsDir, { recursive: true });
        } catch (e) {
            logger.warn(`[ClangdLspManager] Failed to create compile_commands dir: ${e}`);
        }

        logger.info(`[ClangdLspManager] clangdPath: ${clangdPath}`);
        logger.info(`[ClangdLspManager] workspaceRoot: ${this.resolvedRoot}`);
        logger.info(`[ClangdLspManager] compileCommandsDir: ${compileCommandsDir}`);

        const proxy = new ClangdLspProxy({
            clangdPath,
            workspaceRoot: this.resolvedRoot,
            compileCommandsDir,
            logPath,
        });
        proxy.setOnMessage((msg) => this.handleLspMessage(msg));
        this.proxy = proxy;

        proxy.start((success) => this.handleProxyInitialized(success)).catch((err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err));
            this.handleProxyInitialized(false, e.message);
        });
    }

    /** proxy.start 回调：成功 → resolve start()；失败 → reject。 */
    private handleProxyInitialized = (success: boolean, errorMessage?: string): void => {
        this.clearInitTimer();
        if (success) {
            this.isInitialized = true;
            logger.info('[ClangdLspManager] clangd initialized');
            const resolve = this.initResolve;
            this.clearInitHandlers();
            resolve?.();
        } else {
            const message = errorMessage ?? this.proxy?.consumeStartErrorMessage() ?? 'unknown error';
            logger.error(`[ClangdLspManager] clangd initialization failed: ${message}`);
            this.isInitialized = false;
            this.proxy = null; // proxy.start 失败时已自行 dispose
            const reject = this.initReject;
            this.clearInitHandlers();
            reject?.(new Error(`C++ LSP initialize failed: ${message}`));
        }
    };

    /** LSP 上行消息（progress / 未识别通知）转发给上层观察者；init 信号由本类内部消化。 */
    private handleLspMessage(msg: LspMessage): void {
        this.onMessage(msg);
    }

    /** 把上层 LspMessage 转发到 proxy 的对应方法。 */
    private dispatchNotification(msg: LspMessage): void {
        if (!this.proxy) {
            return;
        }
        const record = msg as unknown as Record<string, unknown>;
        const method = record.method as string | undefined;
        if (!method) {
            logger.warn('[ClangdLspManager] dispatchNotification: missing method');
            return;
        }
        const params = record.params;
        switch (method) {
            case LSP_METHOD.DID_OPEN:
                this.proxy.sendDidOpen(params as Parameters<typeof this.proxy.sendDidOpen>[0]);
                break;
            case LSP_METHOD.DID_CHANGE:
                this.proxy.sendDidChange(params as Parameters<typeof this.proxy.sendDidChange>[0]);
                break;
            case LSP_METHOD.DID_CLOSE:
                this.proxy.sendDidClose(params as Parameters<typeof this.proxy.sendDidClose>[0]);
                break;
            default:
                this.proxy.sendNotification(method, params);
        }
    }

    private armInitTimer(ms: number): void {
        this.clearInitTimer();
        this.initDeadlineTimer = setTimeout(() => {
            this.failInit(new Error('C++ LSP initialize timeout'));
        }, ms);
    }

    private clearInitTimer(): void {
        if (this.initDeadlineTimer) {
            clearTimeout(this.initDeadlineTimer);
            this.initDeadlineTimer = null;
        }
    }

    private clearInitHandlers(): void {
        this.clearInitTimer();
        this.initResolve = null;
        this.initReject = null;
    }

    private failInit(err: Error): void {
        const reject = this.initReject;
        this.clearInitHandlers();
        reject?.(err);
    }

    private async performDispose(): Promise<void> {
        // 先 reject 可能 pending 的 start()
        const reject = this.initReject;
        this.clearInitHandlers();
        reject?.(new Error('ClangdLspManager disposing'));

        if (this.proxy) {
            try {
                await this.proxy.dispose();
            } catch (e) {
                logger.warn(`[ClangdLspManager] proxy dispose error: ${e}`);
            }
            this.proxy = null;
        }
        this.isInitialized = false;
        this.initPromise = null;
    }

    /** 在 mcp 日志目录下生成 CppCheck 专属日志子目录。 */
    private getLogPath(): string {
        try {
            const baseLogDir = path.join(getMcpLogDirectory(), 'CppCheck');
            const nanoTime = `${Date.now()}${process.hrtime.bigint() % 1000000n}`;
            const logPath = path.join(baseLogDir, 'lsp-log', nanoTime);
            fs.mkdirSync(logPath, { recursive: true });
            return normalizePath(logPath);
        } catch {
            return 'auto';
        }
    }
}

/** 上行通知 helper（供 ArktsLspManager-style 调用方使用）。 */
export function buildLspNotification(method: string, params: unknown): { jsonrpc: string; method: string; params: unknown } {
    return { jsonrpc: JSONRPC_VERSION, method, params };
}
