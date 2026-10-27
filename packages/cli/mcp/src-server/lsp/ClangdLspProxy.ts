/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LspClient, LspClientConfig } from './core/LspClient.js';
import { RequestCallbackManager } from './core/RequestCallbackManager.js';
import {
    DidChangeTextDocumentParams,
    DidCloseTextDocumentParams,
    DidOpenTextDocumentParams,
    DocumentSymbolParams,
    DefinitionParams,
    HoverParams,
    Position,
    PublishDiagnosticsParams,
    ReferenceParams,
    WorkspaceSymbolParams,
} from './core/LspProtocols.js';
import { LspMessage, LspNotification } from './types.js';
import { JSONRPC_VERSION, LSP_METHOD, LSP_INIT_TIMEOUT_MS } from './constant.js';
import { logger } from './logger.js';
import { toFileUri, normalizePath, toUnixPath } from './utils.js';
import { isRecord } from './common/typeGuards.js';

/** 默认请求超时（ms）。 */
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** publishDiagnostics 等待超时（ms）。 */
const DIAGNOSTIC_TIMEOUT_MS = 30 * 1000;

/** publishDiagnostics push → waiter 模式的 waiter。 */
type DiagnosticWaiter = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
};

export interface ClangdLspProxyConfig {
    /** clangd 可执行文件路径（启动期由 ToolProvider 解析固定后注入）。 */
    clangdPath: string;
    /** 工作区根。 */
    workspaceRoot: string;
    /** compile_commands.json 所在目录（<project>/.idea/.deveco/cxx）。 */
    compileCommandsDir: string;
    /** 日志根目录（仅用于 mcpLog，不传给 clangd）。 */
    logPath: string;
}

/**
 * ClangdLspProxy
 *
 * 进程内单例：直接 spawn clangd 子进程，使用标准 LSP 协议与子进程通信。
 * 与 {@link LspServerProxy} 的差异：
 *  - 不解析模块依赖图，不需要 ace-server 的 modules/initializationOptions
 *  - 不持有 ConfigFileWatcher / DependencyMapWatcher（首版不实现 CxxWatcher）
 *  - clangd 是原生二进制，spawn 参数与 ace-server 不同
 *  - publishDiagnostics 走 push + waiter 模式（clangd 不支持 pull diagnostic）
 *
 * 对外暴露的语言特性方法（hover/definition/...）全部走标准 LSP request/response。
 */
export class ClangdLspProxy {
    private readonly config: ClangdLspProxyConfig;
    private client: LspClient | null = null;
    private clangdProcess: ChildProcess | null = null;
    private nextRequestId = 1;
    private readonly requestCallbacks = new RequestCallbackManager();
    private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter>();
    private lastStartErrorMessage: string | null = null;
    private onMessage: (msg: LspMessage) => void = () => {};
    private disposeOnce: Promise<void> | null = null;

    constructor(config: ClangdLspProxyConfig) {
        this.config = config;
    }

    setOnMessage(callback: (msg: LspMessage) => void): void {
        this.onMessage = callback;
    }

    /** clangd 子进程 pid（未 spawn / 已 dispose 时为 null）。 */
    get clangdPid(): number | null {
        return this.clangdProcess?.pid ?? null;
    }

    consumeStartErrorMessage(): string | null {
        const message = this.lastStartErrorMessage;
        this.lastStartErrorMessage = null;
        return message;
    }

    /**
     * clangd 启动流程：
     *  1. spawn clangd 子进程
     *  2. 通过 LspClient.attachProcess 接管 stdio（复用 Content-Length 帧解析）
     *  3. send initialize request → 等待 response（capabilities）
     *  4. send initialized notification
     */
    async start(onInitialized?: (success: boolean) => void): Promise<void> {
        let success = false;
        try {
            logger.info(`[ClangdLspProxy] clangdPath: ${this.config.clangdPath}`);
            logger.info(`[ClangdLspProxy] workspaceRoot: ${this.config.workspaceRoot}`);
            logger.info(`[ClangdLspProxy] compileCommandsDir: ${this.config.compileCommandsDir}`);

            this.ensureLogDir();
            this.clangdProcess = this.spawnClangd();

            const clientConfig: LspClientConfig = {
                serverPath: '',
                logPath: this.config.logPath,
                indexingDataLocation: this.config.logPath,
                cwd: this.config.workspaceRoot,
            };
            this.client = new LspClient(clientConfig);
            this.client.on('message', (raw: string) => this.handleRawMessage(raw));
            this.client.on('error', (err: Error) => this.handleError(err));
            // clangd 使用 stderr 作为常规日志通道（--log=info），不应触发 error 事件
            this.client.attachProcess(this.clangdProcess, { stderrAsError: false });

            const initParams = this.buildInitializeParams();
            await this.sendLspRequest(LSP_METHOD.INITIALIZE, initParams, LSP_INIT_TIMEOUT_MS);
            logger.info('[ClangdLspProxy] initialize response received');
            this.sendNotification(LSP_METHOD.INITIALIZED, {});
            success = true;
        } catch (e) {
            this.lastStartErrorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[ClangdLspProxy] initialization failed: ${this.lastStartErrorMessage}`);
            await this.dispose();
        }
        onInitialized?.(success);
    }

    /* ========== 标准语言特性请求（返回 Promise） ========== */

    /** textDocument/hover。 */
    async hover(params: HoverParams): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.HOVER, params);
    }

    /** textDocument/definition。 */
    async definition(params: DefinitionParams): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.DEFINITION, params);
    }

    /** textDocument/declaration。 */
    async declaration(params: { textDocument: { uri: string }; position: Position }): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.DECLARATION, params);
    }

    /** textDocument/references。 */
    async references(params: ReferenceParams): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.REFERENCES, params);
    }

    /** textDocument/implementation。 */
    async implementation(params: { textDocument: { uri: string }; position: Position }): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.IMPLEMENTATION, params);
    }

    /** textDocument/documentSymbol。 */
    async documentSymbol(params: DocumentSymbolParams): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.DOCUMENT_SYMBOL, params);
    }

    /** workspace/symbol。 */
    async workspaceSymbol(params: WorkspaceSymbolParams): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.WORKSPACE_SYMBOL, params);
    }

    /** textDocument/prepareCallHierarchy。 */
    async prepareCallHierarchy(params: { textDocument: { uri: string }; position: Position }): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.PREPARE_CALL_HIERARCHY, params);
    }

    /** callHierarchy/incomingCalls。 */
    async incomingCalls(params: { item: unknown }): Promise<unknown> {
        return this.sendLspRequest(LSP_METHOD.INCOMING_CALLS, params);
    }

    /**
     * 通用语言特性请求：直接发 LSP request 并 await response。
     * 由调用方保证 method 名称和 params 结构正确。
     */
    async sendFeatureRequest(method: string, params: unknown): Promise<unknown> {
        return this.sendLspRequest(method, params);
    }

    /* ========== 文档同步 ========== */

    /** textDocument/didOpen。 */
    sendDidOpen(params: DidOpenTextDocumentParams): void {
        this.sendNotification(LSP_METHOD.DID_OPEN, params);
    }

    /** textDocument/didChange。 */
    sendDidChange(params: DidChangeTextDocumentParams): void {
        this.sendNotification(LSP_METHOD.DID_CHANGE, params);
    }

    /** textDocument/didClose。 */
    sendDidClose(params: DidCloseTextDocumentParams): void {
        this.sendNotification(LSP_METHOD.DID_CLOSE, params);
    }

    /** 通用 notification 发送（用于 workspace/didChangeWatchedFiles 等）。 */
    sendNotification(method: string, params: unknown): void {
        if (!this.client) {
            logger.warn('[ClangdLspProxy] sendNotification before ready, dropped');
            return;
        }
        this.client.sendNotification(method, params);
    }

    /* ========== 诊断（push → waiter） ========== */

    /**
     * 注册诊断回调：文件被打开后，收到 publishDiagnostics 时 resolve waiter。
     * 调用方通过 await 返回的 Promise 拿到诊断结果。
     */
    registerDiagnosticCallback(uri: string): Promise<unknown> {
        const canonical = this.normalizeClangdUri(uri);
        if (this.diagnosticWaiters.has(canonical)) {
            logger.warn(`[ClangdLspProxy] overwrite existing diagnostic waiter for ${canonical}`);
            const existing = this.diagnosticWaiters.get(canonical)!;
            clearTimeout(existing.timer);
            this.diagnosticWaiters.delete(canonical);
        }
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.diagnosticWaiters.delete(canonical)) {
                    reject(new Error(`Wait for clangd diagnostics timeout, uri: ${canonical}`));
                }
            }, DIAGNOSTIC_TIMEOUT_MS);
            this.diagnosticWaiters.set(canonical, { resolve, reject, timer });
        });
    }

    /* ========== 生命周期 ========== */

    async dispose(): Promise<void> {
        if (!this.disposeOnce) {
            this.disposeOnce = this.performDispose();
        }
        return this.disposeOnce;
    }

    private async performDispose(): Promise<void> {
        // 清理所有 pending waiter / request
        this.requestCallbacks.rejectAll(new Error('ClangdLspProxy disposing'));
        for (const [, waiter] of this.diagnosticWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('ClangdLspProxy disposing'));
        }
        this.diagnosticWaiters.clear();

        // 优雅关闭 clangd：shutdown request + exit notification
        if (this.client && this.clangdProcess) {
            try {
                await this.sendLspRequest(LSP_METHOD.SHUTDOWN, null, 3000).catch((e) => {
                    logger.warn(`[ClangdLspProxy] shutdown request failed: ${e}`);
                });
                this.sendNotification(LSP_METHOD.EXIT, null);
                await this.client.waitForExitOrTimeout(300);
            } catch (e) {
                logger.warn(`[ClangdLspProxy] dispose error: ${e}`);
            }
        }

        if (this.clangdProcess) {
            try {
                if (this.clangdProcess.exitCode === null && this.clangdProcess.signalCode === null) {
                    this.clangdProcess.kill();
                }
            } catch {
                // 进程可能已自行退出
            }
            this.clangdProcess = null;
        }
        this.client = null;
    }

    /** 内部：spawn clangd 子进程。 */
    private spawnClangd(): ChildProcess {
        const args = [
            `--compile-commands-dir=${toUnixPath(this.config.compileCommandsDir)}`,
            '--log=info',
            '--pch-storage=memory',
            '--limit-results=100',
        ];
        logger.info(`[ClangdLspProxy] spawn: ${this.config.clangdPath} ${args.join(' ')}`);
        const child = spawn(this.config.clangdPath, args, {
            cwd: this.config.workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        if (!child.stdin || !child.stdout || !child.stderr) {
            throw new Error('Failed to spawn clangd: stdio not available');
        }
        return child;
    }

    /** 内部：构造标准 LSP initialize 参数（最小 capabilities）。 */
    private buildInitializeParams(): unknown {
        const normalizedRoot = normalizePath(this.config.workspaceRoot);
        const rootUri = toFileUri(normalizedRoot);
        const workspaceName = path.basename(normalizedRoot) || 'workspace';
        return {
            processId: process.pid,
            clientInfo: {
                name: 'devecocli-mcp-server',
                version: (process.env.npm_package_version as string | undefined) ?? '0.0.1',
            },
            rootPath: normalizedRoot,
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: workspaceName }],
            capabilities: this.buildClientCapabilities(),
            initializationOptions: null,
        };
    }

    /** 内部：构造 LSP client capabilities（textDocument + workspace）。 */
    private buildClientCapabilities(): unknown {
        return {
            textDocument: {
                synchronization: {
                    didOpen: true,
                    didChange: true,
                    didClose: true,
                    willSave: false,
                    save: false,
                },
                publishDiagnostics: {
                    relatedInformation: true,
                    versionSupport: false,
                    tagSupport: { valueSet: [1, 2] },
                },
                hover: { contentFormat: ['markdown', 'plaintext'] },
                completion: {
                    contextSupport: false,
                    completionItemKind: { valueSet: [] },
                },
                signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
                references: {},
                declaration: { linkSupport: true },
                definition: { linkSupport: true },
                implementation: { linkSupport: true },
                documentSymbol: {
                    hierarchicalDocumentSymbolSupport: true,
                    symbolKind: { valueSet: [] },
                },
                callHierarchy: { dynamicRegistration: false },
            },
            workspace: {
                symbol: {
                    symbolKind: { valueSet: [] },
                },
                configuration: false,
                didChangeWatchedFiles: { dynamicRegistration: false },
            },
        };
    }

    /* ========== 消息分发 ========== */

    /** 内部：发送 LSP request 并 await response。 */
    private sendLspRequest(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
        if (!this.client) {
            return Promise.reject(new Error('[ClangdLspProxy] client not ready'));
        }
        const id = this.nextRequestId++;
        const promise = this.requestCallbacks.registerPending(id, method, timeoutMs);
        this.client.sendRequest(method, params, id);
        return promise;
    }

    private handleRawMessage(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[ClangdLspProxy] JSON parse error: ${errorMessage}, raw: ${raw.slice(0, 200)}`);
            return;
        }

        if ('id' in msg && ('result' in msg || 'error' in msg)) {
            this.handleResponse(msg);
        } else if ('method' in msg) {
            this.handleNotification(msg);
        } else {
            logger.warn(`[ClangdLspProxy] unrecognized message: ${JSON.stringify(msg).slice(0, 200)}`);
        }
    }

    private handleResponse(msg: Record<string, unknown>): void {
        const id = msg.id;
        if (id === undefined || id === null) {
            return;
        }
        if (typeof id !== 'string' && typeof id !== 'number') {
            return;
        }
        const key: string | number = id;
        if (msg.error !== undefined && msg.error !== null) {
            const err = msg.error as { code?: number; message?: string; data?: unknown };
            logger.warn(`[ClangdLspProxy] LSP error id=${key}: code=${err.code ?? -1} message=${err.message ?? 'unknown'}`);
            this.requestCallbacks.rejectPending(
                key,
                new Error(`LSP error ${err.code ?? -1}: ${err.message ?? 'unknown'}`),
            );
        } else {
            this.requestCallbacks.resolvePending(key, msg.result);
        }
    }

    private handleNotification(msg: Record<string, unknown>): void {
        const method = msg.method as string | undefined;
        if (!method) {
            return;
        }
        switch (method) {
            case LSP_METHOD.PUBLISH_DIAGNOSTICS:
                this.handlePublishDiagnostics(msg.params as PublishDiagnosticsParams | undefined);
                break;
            case LSP_METHOD.PROGRESS:
                this.onMessage({ jsonrpc: JSONRPC_VERSION, method: LSP_METHOD.PROGRESS, params: msg.params });
                break;
            case LSP_METHOD.WINDOW_SHOW_MESSAGE:
                logger.info(`[ClangdLspProxy] window/showMessage: ${JSON.stringify(msg.params)}`);
                break;
            case LSP_METHOD.WINDOW_LOG_MESSAGE:
                logger.info(`[ClangdLspProxy] window/logMessage: ${JSON.stringify(msg.params)}`);
                break;
            default:
                // 其他未识别通知上抛给上层
                this.onMessage({ jsonrpc: JSONRPC_VERSION, method, params: msg.params });
        }
    }

    private handlePublishDiagnostics(params: PublishDiagnosticsParams | undefined): void {
        if (!params || !params.uri) {
            return;
        }
        const canonical = this.normalizeClangdUri(params.uri);
        let waiter = this.diagnosticWaiters.get(canonical);
        // URI 不匹配时，若只有一个 pending waiter（check 串行），回退到它
        if (!waiter && this.diagnosticWaiters.size === 1) {
            const fallbackKey = this.diagnosticWaiters.keys().next().value as string;
            waiter = this.diagnosticWaiters.get(fallbackKey);
            if (waiter) {
                this.diagnosticWaiters.delete(fallbackKey);
            }
        } else if (waiter) {
            this.diagnosticWaiters.delete(canonical);
        }
        if (!waiter) {
            return;
        }
        clearTimeout(waiter.timer);
        const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
        const count = diagnostics.length;
        logger.info(`[ClangdLspProxy] diagnostics received uri=${canonical} count=${count}`);
        waiter.resolve(diagnostics);
    }

    private handleError(err: Error): void {
        // 通知所有 pending waiter / request 失败
        for (const [, waiter] of this.diagnosticWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
        }
        this.diagnosticWaiters.clear();
        this.requestCallbacks.rejectAll(err);
        this.onMessage({
            jsonrpc: JSONRPC_VERSION,
            method: LSP_METHOD.CPP_ERROR,
            params: { message: err.message },
        });
    }

    /* ========== 工具 ========== */

    private ensureLogDir(): void {
        if (!this.config.logPath) {
            return;
        }
        try {
            if (!fs.existsSync(this.config.logPath)) {
                fs.mkdirSync(this.config.logPath, { recursive: true });
            }
        } catch {
            // ignore
        }
    }

    /**
     * clangd 上报的 publishDiagnostics URI 在不同平台 / 不同路径前缀下可能与我们计算的
     * `toFileUri` 不完全一致（例如盘符大小写、`%3A` vs `:`），此处尽量规范化。
     * 与现有 cpp-check.ts `normalizeClangdUri` 行为一致。
     */
    private normalizeClangdUri(uri: string): string {
        try {
            const url = new URL(uri);
            if (url.protocol === 'file:') {
                let p = decodeURIComponent(url.pathname);
                if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
                    p = p.slice(1);
                }
                return toFileUri(p);
            }
        } catch {
            // ignore
        }
        return uri;
    }
}

/** 上行通知 helper（供 ArktsLspManager-style 调用方使用）。 */
export function buildLspNotification(method: string, params: unknown): LspNotification {
    return { jsonrpc: JSONRPC_VERSION, method, params };
}

/** 类型守卫：判断 params 是否含 textDocument.uri 字段。 */
export function hasTextDocumentUri(params: unknown): params is { textDocument: { uri: string } } {
    if (!isRecord(params)) {
        return false;
    }
    const td = params.textDocument;
    return isRecord(td) && typeof td.uri === 'string';
}
