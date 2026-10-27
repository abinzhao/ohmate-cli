/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { LspServerProxy } from './LspServerProxy.js';
import { ConfigFileWatcher, ConfigChangeEvent, ConfigChangeKind } from './watcher/ConfigFileWatcher.js';
import { DependencyMapWatcher, ReloadEvent } from './watcher/DependencyMapWatcher.js';
import { SourceFileWatcher, SourceChangeEvent } from './watcher/SourceFileWatcher.js';
import { syncProject } from './sync/buildProject.js';
import { ohpmInstallAll } from './sync/ohpmInstall.js';
import { tryWithBuildLock } from '../../../src/utils/build-lock.js';
import { LspMessage, LspRequest, EtsFileItem, OpenFileParam } from './types.js';
import { JSONRPC_VERSION, LSP_METHOD } from './constant.js';
import { ArkTsProxyError } from './ArkTsProxyError.js';
import { ModuleDependencyInfo } from './model/ModuleDependencyInfo.js';
import { logger } from './logger.js';

export interface ModuleSetItem {
    modulePath: string;
    dependencies: Record<string, ModuleDependencyInfo>;
    dynamicDependencies: Record<string, ModuleDependencyInfo>;
}

export type SyncResult =
    | { status: 'success' }
    | { status: 'failed'; reason: string }
    | { status: 'skipped'; reason: string };

export interface ArktsLspManagerConfig {
    sdkPath: string;
    /** DevEco Studio 内 `plugins/openharmony` 目录（含 ace-server/out/index.js） */
    arktsLangServerPath: string;
    workspaceRoot: string;
    indexLogPath: string;
    nodeMaxOldSpaceSize?: number;
    /**
     * 是否使用标准 LSP 协议。
     * true  → ace-server/out/standardIndex/index.js 存在（DevEco >= 26.0.0.610），走标准化协议；
     * false → 该文件不存在（老版本），走 ace-server 私有协议。
     */
    useStandardProtocol: boolean;
    /** 启动期固定 node 可执行文件路径（工具链 bundled node）。 */
    nodePath?: string;
    /** 是否使用 socket 传输（由 server 层 --list-protocols 探测后注入；缺省 = stdio）。 */
    useSocket?: boolean;
}

/**
 * ArktsLspManager
 * - 直接持有 `LspServerProxy`（其内部 spawn 唯一一个 ace-server 子进程）；
 * - 维持 `ConfigFileWatcher` / `DependencyMapWatcher`；
 * - 处理 `arkts/syncProject` 请求（ohpm install + hvigor sync）；
 * - 把 LSP 上行消息通过 `setOnMessage` 注册的回调统一上抛给上层（`ArktsCheckTool`）。
 *
 * 内部通信使用标准 LSP 协议（initialize / initialized / didOpen / publishDiagnostics 等），
 * 对上层暴露的 arkts/* 通知保留为进程内状态信号。
 */
export class ArktsLspManager {
    private readonly config: ArktsLspManagerConfig;
    private lspProxy: LspServerProxy | null = null;
    private configWatcher: ConfigFileWatcher | null = null;
    private depMapWatcher: DependencyMapWatcher | null = null;
    private sourceFileWatcher: SourceFileWatcher | null = null;
    private isInitialized: boolean = false;
    private lastEditorOpenFiles: EtsFileItem[] = [];
    private onMessage: (msg: LspMessage) => void = () => {};
    private onConfigChanged: (() => void) | null = null;
    /** dispose 仅执行一次 */
    private disposeOnce: Promise<void> | null = null;

    /** ace-server 子进程 pid；LSP 未初始化（lspProxy 为空）时为 null。 */
    public get aceServerPid(): number | null {
        return this.lspProxy?.lspPid ?? null;
    }

    constructor(config: ArktsLspManagerConfig) {
        this.config = config;
    }

    setOnMessage(callback: (msg: LspMessage) => void): void {
        this.onMessage = callback;
    }

    /**
     * 启动配置监听 + 拉起 LSP。该函数会立即返回；真正的"初始化完成"信号通过 onMessage 上抛
     * `arkts/initialized`（成功）或 `arkts/initializationFailed`（失败）。
     */
    async start(editorOpenFiles: EtsFileItem[] = [], onDepParseProgress?: (current: number, total: number) => void): Promise<void> {
        this.lastEditorOpenFiles = editorOpenFiles;
        try {
            this.startConfigWatcher();
            this.startLspProxy(editorOpenFiles, onDepParseProgress);
        } catch (err) {
            logger.error(
                `[ArktsLspManager] start() synchronous failure: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            throw err;
        }
    }

    /** 上行通知（如 textDocument/didOpen / didChange / didClose） */
    sendNotification(msg: LspMessage): void {
        if (!this.lspProxy) {
            logger.warn('[ArktsLspManager] sendNotification before LSP ready, dropped');
            return;
        }
        this.lspProxy.sendNotification(msg);
    }

    /** 上行请求（hover / definition / references） */
    sendRequest(msg: LspRequest): void {
        if (!this.lspProxy) {
            logger.warn('[ArktsLspManager] sendRequest before LSP ready, dropped');
            return;
        }
        this.lspProxy.sendRequest(msg);
    }

    /** textDocument/diagnostic — 标准 LSP 拉取式诊断请求，返回 Promise<unknown>。 */
    async diagnostic(params: { textDocument: { uri: string } }): Promise<unknown> {
        if (!this.lspProxy) {
            throw new Error('[ArktsLspManager] diagnostic before LSP ready');
        }
        return this.lspProxy.diagnostic(params);
    }

    /**
     * 通用语言特性请求（async）：直接发 LSP request 并 await response。
     * 供 hover / definition / references / completion 等调用，
     * 由调用方保证 method 和 params 正确。
     */
    async sendFeatureRequest(method: string, params: unknown): Promise<unknown> {
        if (!this.useStandardProtocol) {
            throw new Error(
                `Language feature '${method}' is not supported on the installed DevEco Studio. ` +
                    'The standard LSP protocol entry (plugins/openharmony/ace-server/out/standardIndex/index.js) was not found. ' +
                    'Please upgrade DevEco Studio to version 26.0.0.610 or later to use this tool.',
            );
        }
        if (!this.lspProxy) {
            throw new Error('LSP not ready');
        }
        return this.lspProxy.sendFeatureRequest(method, params);
    }

    /** 是否使用标准 LSP 协议（false=老版本 ace-server 私有协议）。 */
    get useStandardProtocol(): boolean {
        return this.config.useStandardProtocol;
    }

    /** 老版本：onAsyncOpenFile（ace-server 私有 didOpen）。仅 legacy 模式调用。 */
    onAsyncOpenFile(param: OpenFileParam): void {
        this.lspProxy?.onAsyncOpenFile(param);
    }

    /** 老版本：closeFile(uri, isManual)。仅 legacy 模式调用。 */
    closeFileLegacy(uri: string, isManual: boolean): void {
        this.lspProxy?.closeFileLegacy(uri, isManual);
    }

    /** 注册 publishDiagnostics 回调（按 uri 匹配），standard/legacy 共用。 */
    registerDiagnosticCallback(uri: string): void {
        this.lspProxy?.registerDiagnosticCallback(uri);
    }

    /**
     * 处理 `arkts/syncProject`：原子性尝试获取构建锁后执行 ohpm install + hvigor sync。
     * 模型重载由 DependencyMapWatcher 自动触发。
     *
     * 锁策略：
     * - 原子性尝试获取锁（无重试），若其他进程已持有构建锁则返回 skipped
     * - 消除 isBuildLocked + withBuildLock 之间的 TOCTOU 竞态
     *
     * options.skipHvigorSync：仅跳过 hvigor --sync（build init），ohpm install 照常执行。
     * 用于配置未变更的场景——依赖仍可能被外部清理，故 ohpm 不可省略。
     */
    static async handleSyncProject(
        workspaceRoot: string,
        sdkPath?: string,
        nodePath?: string,
        ohpmJsPath?: string,
        hvigorJsPath?: string,
        options?: { skipHvigorSync?: boolean },
        onOhpmLine?: (line: string) => void,
        onHvigorLine?: (line: string) => void,
    ): Promise<SyncResult> {
        logger.info('[ArktsLspManager] Received arkts/syncProject');
        if (!workspaceRoot || !sdkPath) {
            logger.error('[ArktsLspManager] handleSyncProject: workspaceRoot or sdkPath is empty');
            return { status: 'failed', reason: 'workspaceRoot or sdkPath is empty' };
        }
        const skipHvigor = options?.skipHvigorSync === true;
        const result = await tryWithBuildLock(
            workspaceRoot,
            async () => {
                const installSuccess = await ohpmInstallAll(workspaceRoot, sdkPath, nodePath ?? '', ohpmJsPath ?? '', onOhpmLine);
                if (!installSuccess) {
                    logger.error('[ArktsLspManager] ohpm install failed');
                    return { status: 'failed' as const, reason: 'ohpm install failed' };
                }
                if (skipHvigor) {
                    logger.info('[ArktsLspManager] hvigor sync skipped (config up-to-date)');
                    return { status: 'success' as const };
                }
                const success = await syncProject(workspaceRoot, sdkPath, nodePath ?? '', hvigorJsPath ?? '', onHvigorLine);
                if (success) {
                    logger.info('[ArktsLspManager] syncProject completed successfully');
                    return { status: 'success' as const };
                } else {
                    logger.error('[ArktsLspManager] syncProject failed');
                    return { status: 'failed' as const, reason: 'hvigor sync failed' };
                }
            },
        );
        if (!result.acquired) {
            logger.info('[ArktsLspManager] Build lock held by another process, skipping sync');
            return { status: 'skipped', reason: 'build lock held by another process' };
        }
        return result.result;
    }

    async dispose(): Promise<void> {
        if (!this.disposeOnce) {
            this.disposeOnce = this.performDispose();
        }
        return this.disposeOnce;
    }

    private async performDispose(): Promise<void> {
        try {
            this.configWatcher?.stop();
        } catch (e) {
            logger.warn(`[ArktsLspManager] configWatcher stop error: ${e}`);
        }
        try {
            this.depMapWatcher?.stop();
        } catch (e) {
            logger.warn(`[ArktsLspManager] depMapWatcher stop error: ${e}`);
        }
        try {
            this.sourceFileWatcher?.stop();
        } catch (e) {
            logger.warn(`[ArktsLspManager] sourceFileWatcher stop error: ${e}`);
        }
        this.configWatcher = null;
        this.depMapWatcher = null;
        this.sourceFileWatcher = null;
        if (this.lspProxy) {
            try {
                await this.lspProxy.dispose();
            } catch (e) {
                logger.warn(`[ArktsLspManager] lspProxy dispose error: ${e}`);
            }
            this.lspProxy = null;
        }
        this.isInitialized = false;
    }

    // ---------- LSP startup ----------

    private startLspProxy(editorOpenFiles: EtsFileItem[], onDepParseProgress?: (current: number, total: number) => void): void {
        const proxy = new LspServerProxy(
            this.config.sdkPath,
            this.config.arktsLangServerPath,
            this.config.workspaceRoot,
            this.config.indexLogPath,
            this.config.nodeMaxOldSpaceSize,
            this.config.useStandardProtocol,
            this.config.nodePath,
            this.config.useSocket ?? false,
        );
        proxy.setOnMessage((msg) => this.handleLspMessage(msg));
        proxy.start(editorOpenFiles, (success) => this.handleLspInitialized(success), onDepParseProgress);
        this.lspProxy = proxy;
    }

    private handleLspInitialized = (success: boolean): void => {
        this.isInitialized = success;
        if (success) {
            logger.info('[ArktsLspManager] LSP initialized');
            this.startDependencyMapWatcher();
            this.startSourceFileWatcher();
            this.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_INITIALIZED,
                params: {},
            });
        } else {
            const errorMessage = this.lspProxy?.consumeStartErrorMessage();
            logger.error(`[ArktsLspManager] LSP initialization failed: ${errorMessage}`);
            const proxyError = errorMessage ? ArkTsProxyError.uninitialized(errorMessage) : ArkTsProxyError.unknown();
            this.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_INITIALIZATION_FAILED,
                params: proxyError.toJsonRpcErrorParams(),
            });
            this.lspProxy = null;
        }
    };

    private handleLspMessage(msg: LspMessage): void {
        // LSP 上行消息直接抛给上层。上层（ArktsCheckTool）按 method 自行解析。
        this.onMessage(msg);
    }

    /**
     * 首次 LSP 初始化失败时会把 `lspProxy` 置空；用户 sync 生成依赖图后应再拉起 ace-server，
     * 否则后续 LSP 调用永远没有响应。
     */
    private maybeRetryLspAfterSuccessfulSync(): void {
        if (this.isInitialized || this.lspProxy !== null) {
            return;
        }
        logger.info('[ArktsLspManager] Retrying LSP startup after successful sync');
        this.onMessage({
            jsonrpc: JSONRPC_VERSION,
            method: LSP_METHOD.ARKTS_REINITIALIZING,
            params: {},
        });
        this.startLspProxy(this.lastEditorOpenFiles);
    }

    // ---------- watchers ----------

    private startConfigWatcher(): void {
        if (this.configWatcher) {
            return;
        }
        this.configWatcher = new ConfigFileWatcher(this.config.workspaceRoot);
        this.configWatcher.on('configChanged', (event: ConfigChangeEvent) => this.handleConfigChanged(event));
        this.configWatcher.start();
    }

    private startDependencyMapWatcher(): void {
        if (this.depMapWatcher) {
            return;
        }
        this.depMapWatcher = new DependencyMapWatcher(this.config.workspaceRoot);
        this.depMapWatcher.on('reload', (event: ReloadEvent) => {
            if (!this.lspProxy) {
                logger.warn('[ArktsLspManager] LspServerProxy not initialized, skip reload');
                return;
            }
            const depsOnly = this.lspProxy.reloadDependenciesOnly(event);
            const moduleSet: ModuleSetItem[] = depsOnly.map((d) => ({
                modulePath: d.modulePath ?? '',
                dependencies: d.dependencies ?? {},
                dynamicDependencies: d.dynamicDependencies ?? {},
            }));
            this.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_SYNC_COMPLETED,
                params: { success: true, moduleSet },
            });
        });
        this.depMapWatcher.start();
    }

    /**
     * 启动源文件（.ets）监听。
     *
     * 检测到 src/main/ets 下 .ets 的 Created/Changed/Deleted 后，转成
     * `workspace/didChangeWatchedFiles` 通知发给 ace-server，让其失效跨文件缓存、
     * 下次诊断时重读被引用文件。send 链由 LspServerProxy 按 useStandardProtocol
     * 自动适配标准/私有/socket 三模式。
     */
    private startSourceFileWatcher(): void {
        if (this.sourceFileWatcher) {
            return;
        }
        this.sourceFileWatcher = new SourceFileWatcher(this.config.workspaceRoot);
        this.sourceFileWatcher.on('sourceChanged', (event: SourceChangeEvent) => {
            if (!this.lspProxy) {
                logger.warn('[ArktsLspManager] LspServerProxy not initialized, skip didChangeWatchedFiles');
                return;
            }
            this.sendNotification({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.WORKSPACE_DID_CHANGE_WATCHED_FILES,
                params: { changes: event.changes },
            });
            logger.info(
                `[ArktsLspManager] Notified didChangeWatchedFiles: ${event.changes.length} change(s)`,
            );
        });
        this.sourceFileWatcher.start();
    }

    /**
     * 注册配置文件变化回调。
     * 当 ConfigFileWatcher 检测到 oh-package.json5 或 build-profile.json5 变化时调用，
     * 由 server 层设置 needsResync 标志位，在下次 check 时触发重新 sync。
     */
    setOnConfigChanged(callback: () => void): void {
        this.onConfigChanged = callback;
    }

    private handleConfigChanged(event: ConfigChangeEvent): void {
        logger.info(`[ArktsLspManager] Config file changed: ${event.filePath}, notifying server`);
        // 模块结构变化（增删/重命名/移动）时让 SourceFileWatcher 重发现 sourceDirs 并增删 watcher；
        // build-profile 的单一 owner 是 ConfigFileWatcher，SourceFileWatcher 不再自监听。
        if (event.kind !== ConfigChangeKind.OhPackageChanged) {
            this.sourceFileWatcher?.refreshSourceDirs();
        }
        this.onConfigChanged?.();
    }
}
