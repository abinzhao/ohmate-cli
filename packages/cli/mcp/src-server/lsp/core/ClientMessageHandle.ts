/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { LspClient, LspClientConfig } from './LspClient.js';
import { RequestCallbackManager, RequestCallback } from './RequestCallbackManager.js';
import { Diagnostic } from './Diagnostic.js';
import {
    PublishDiagnosticsParams,
    LspDiagnostic,
    DidChangeTextDocumentParams,
    DidOpenTextDocumentParams,
    DidCloseTextDocumentParams,
    LspRequest,
    LspResponse,
    LspNotification,
} from './LspProtocols.js';
import { logger } from '../logger.js';
import { Params } from '../model/Params.js';
import { LspMessage } from '../types.js';
import { CallbackRegistry } from '../common/CallbackRegistry.js';
import { isRecord } from '../common/typeGuards.js';
import { JSONRPC_VERSION, LSP_INIT_TIMEOUT_MS, LSP_METHOD } from '../constant.js';

type MessageCallback = (msg?: LspMessage) => void;

/** 诊断等待的默认超时（ms）。 */
const DIAGNOSTIC_TIMEOUT_MS = 20 * 1000;
/** 请求等待的默认超时（ms）。 */
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** 标准协议退出等待超时（ms）。默认 300；DEVECO_CLI_LSP_STANDARD_EXIT_TIMEOUT_MS 覆盖（<300 按 300）。 */
const DEFAULT_STANDARD_EXIT_TIMEOUT_MS = 300;
const MIN_STANDARD_EXIT_TIMEOUT_MS = 300;

function resolveStandardExitTimeoutMs(): number {
    const raw = process.env.DEVECO_CLI_LSP_STANDARD_EXIT_TIMEOUT_MS;
    if (raw === undefined || raw === '') {
        return DEFAULT_STANDARD_EXIT_TIMEOUT_MS;
    }
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_STANDARD_EXIT_TIMEOUT_MS;
    }
    return Math.max(MIN_STANDARD_EXIT_TIMEOUT_MS, parsed);
}

/**
 * ClientMessageHandle：LSP 服务端消息处理入口（标准 LSP 协议）。
 *
 * 职责：
 *  - 通过 LspClient 与 ace-server 子进程通信（Content-Length 分帧 JSON-RPC）；
 *  - 区分 response / request / notification 并分发；
 *  - 维护诊断 Map（按 uri 聚合 publishDiagnostics）；
 *  - 维护 pending 请求（按 id 匹配 response）。
 */
export class ClientMessageHandle {
    private readonly client: LspClient;
    private nextRequestId = 1;
    private stopOnce: Promise<void> | null = null;
    private readonly callbacks = new CallbackRegistry<string, MessageCallback>();
    private readonly requestCallbacks = new RequestCallbackManager();
    public readonly diagnosticMap = new Map<string, Diagnostic>();
    private initProgressReset: (() => void) | null = null;
    private readonly notificationWaiters = new Map<string, () => void>();

    /** 底层 LspClient（ace-server 子进程）的 pid；未启动为 null。 */
    public get lspPid(): number | null {
        return this.client.pid;
    }

    constructor(config: LspClientConfig) {
        this.client = new LspClient(config);
        this.client.on('message', (raw: string) => this.handleRawMessage(raw));
        this.client.on('error', (error: Error) => this.handleError(error));
    }

    public async start(serverMaxSize: number): Promise<void> {
        await this.client.start(serverMaxSize);
    }

    /**
     * 标准 LSP 关闭流程：shutdown request → exit notification → 等待退出 → 关闭传输层。
     * socket 与 stdio 走同一流程；不 kill server 进程由 {@link LspClient.stop} 保证（socket 仅销毁 TCP）。
     */
    public stop(): Promise<void> {
        if (!this.stopOnce) {
            this.stopOnce = (async () => {
                logger.info('[ClientMessageHandle] Sending shutdown request');
                this.client.sendRequest(LSP_METHOD.SHUTDOWN, null, this.nextRequestId++);
                logger.info('[ClientMessageHandle] Sending exit notification');
                this.client.sendNotification(LSP_METHOD.EXIT, null);
                logger.info('[ClientMessageHandle] Waiting for LSP process to exit');
                await this.client.waitForExitOrTimeout(resolveStandardExitTimeoutMs());
                logger.info('[ClientMessageHandle] LSP exit wait completed, calling stop');
                this.client.stop();
            })();
        }
        return this.stopOnce;
    }

    /* ---------- 广播注册 ---------- */

    public setBroadcastToClients(callback: (msg: LspMessage) => void): void {
        this.callbacks.unregister(LSP_METHOD.BROADCAST);
        this.callbacks.register(LSP_METHOD.BROADCAST, callback as MessageCallback);
    }

    public broadcastToClients(msg: LspMessage): void {
        this.callbacks.invoke(LSP_METHOD.BROADCAST, msg);
    }

    /* ---------- 初始化 ---------- */

    /**
     * 标准 LSP initialize request → response。
     * 调用方 await 此 Promise 即可拿到 server capabilities。
     */
    public async sendInitialize(param: Params): Promise<unknown> {
        const id = this.nextRequestId++;
        const promise = this.requestCallbacks.registerPending(id, LSP_METHOD.INITIALIZE, LSP_INIT_TIMEOUT_MS);
        this.client.sendRequest(LSP_METHOD.INITIALIZE, param, id);
        return promise;
    }

    /**
     * 标准 LSP initialize，带进度重置超时：初始化期间收到任何 server 通知都会重置计时器，
     * 收到 initialize response 时 resolve。与老协议 {@link LspServerProxy.withResettableTimeout} 行为对齐。
     * 内部 registerPending 用 0（无硬超时），超时完全由本方法的 resettable 计时器接管。
     */
    public sendInitializeResettable(param: Params, timeoutMs: number): Promise<void> {
        const id = this.nextRequestId++;
        const responsePromise = this.requestCallbacks.registerPending(id, LSP_METHOD.INITIALIZE, 0);
        this.client.sendRequest(LSP_METHOD.INITIALIZE, param, id);
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;
            const schedule = () => {
                timer = setTimeout(() => {
                    this.initProgressReset = null;
                    reject(new Error(`LSP initialization timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            };
            const reset = () => {
                clearTimeout(timer);
                schedule();
            };
            this.initProgressReset = reset;
            schedule();
            responsePromise.then(
                () => {
                    clearTimeout(timer);
                    this.initProgressReset = null;
                    resolve();
                },
                (err: Error) => {
                    clearTimeout(timer);
                    this.initProgressReset = null;
                    reject(err);
                },
            );
        });
    }

    /** 发送 initialized notification（无返回值）。 */
    public sendInitialized(): void {
        this.client.sendNotification(LSP_METHOD.INITIALIZED, {});
    }

    /**
     * socket 模式初始化：发 initialize request 并同时等待指定 notification（如
     * aceProject/onModuleInitFinish）。waiter 在发 request 前注册，避免通知早到被丢弃。
     * 收到 initialize response 时调用 onInitialized（发送 initialized 通知）；
     * response 与 notification 都到达后 resolve，任一超时则 reject。
     */
    public sendInitializeAndWaitForNotification(
        param: Params,
        notificationMethod: string,
        timeoutMs: number,
        onInitialized: () => void,
        onProgress?: () => void,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const state = { initializeResolved: false, notificationResolved: false };
            const timer = this.startInitTimer(notificationMethod, timeoutMs, reject);
            this.initProgressReset = () => {
                timer.reset();
                onProgress?.();
            };
            const maybeResolve = () => {
                if (state.initializeResolved && state.notificationResolved) {
                    timer.clear();
                    resolve();
                }
            };
            this.notificationWaiters.set(notificationMethod, () => {
                state.notificationResolved = true;
                maybeResolve();
            });
            const id = this.nextRequestId++;
            this.client.sendRequest(LSP_METHOD.INITIALIZE, param, id);
            this.requestCallbacks.registerPending(id, LSP_METHOD.INITIALIZE, 0).then(
                () => {
                    state.initializeResolved = true;
                    try {
                        onInitialized();
                    } catch (err) {
                        // onInitialized 抛错时不能让外层 promise 悬空（否则只能等 armInitTimer 兜底），
                        // 也不能让 .then 的 onFulfilled 抛出形成 unhandled rejection。
                        timer.clear();
                        reject(err instanceof Error ? err : new Error(String(err)));
                        return;
                    }
                    maybeResolve();
                },
                (err: Error) => {
                    timer.clear();
                    reject(err);
                },
            );
        });
    }

    /** 启动初始化超时计时器：reset 重置计时，clear 清理并注销 notification waiter。 */
    private startInitTimer(
        notificationMethod: string,
        timeoutMs: number,
        reject: (err: Error) => void,
    ): { reset: () => void; clear: () => void } {
        let timer: ReturnType<typeof setTimeout>;
        const clear = () => {
            clearTimeout(timer);
            this.initProgressReset = null;
            this.notificationWaiters.delete(notificationMethod);
        };
        const schedule = () => {
            timer = setTimeout(() => {
                clear();
                reject(new Error(`LSP initialization timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        };
        const reset = () => {
            clearTimeout(timer);
            schedule();
        };
        schedule();
        return { reset, clear };
    }

    /* ---------- 文档同步 ---------- */

    public sendDidOpen(params: DidOpenTextDocumentParams): void {
        const uri = params.textDocument.uri;
        if (!this.diagnosticMap.has(uri)) {
            this.diagnosticMap.set(uri, new Diagnostic(uri));
            this.registerDiagnosticTimeout(uri);
        }
        this.client.sendNotification(LSP_METHOD.DID_OPEN, params);
    }

    public sendDidChange(params: DidChangeTextDocumentParams): void {
        const uri = params.textDocument.uri;
        const diagnostic = this.diagnosticMap.get(uri);
        if (diagnostic) {
            diagnostic.clear();
            this.registerDiagnosticTimeout(uri);
        }
        this.client.sendNotification(LSP_METHOD.DID_CHANGE, params);
    }

    public closeFile(params: DidCloseTextDocumentParams): void {
        this.cleanupDiagnosticState(params.textDocument.uri);
        this.client.sendNotification(LSP_METHOD.DID_CLOSE, params);
    }

    /* ---------- 语言特性请求 ---------- */

    /**
     * 发送标准 LSP request（hover / definition / references 等），
     * 返回 Promise，在收到对应 id 的 response 时 resolve。
     */
    public sendLspRequest(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
        const id = this.nextRequestId++;
        const promise = this.requestCallbacks.registerPending(id, method, timeoutMs);
        this.client.sendRequest(method, params, id);
        return promise;
    }

    /* ---------- 旧式 uri 回调（诊断等） ---------- */

    public registerRequestCallback(key: string | number, callback: RequestCallback): void {
        this.requestCallbacks.register(key, callback);
    }

    /* ---------- workspace ---------- */

    public onDidChangeWatchedFiles(changes: Array<{ uri: string; type: number }>): void {
        if (changes.length === 0) {
            return;
        }
        this.client.sendNotification(LSP_METHOD.WORKSPACE_DID_CHANGE_WATCHED_FILES, { changes });
    }

    public sendDidChangeConfiguration(params: unknown): void {
        this.client.sendNotification(LSP_METHOD.WORKSPACE_DID_CHANGE_CONFIGURATION, { settings: params });
    }

    /** 通用通知发送（用于 didCreateFiles/didDeleteFiles 等无特殊处理的通知）。 */
    public sendNotification(method: string, params: unknown): void {
        this.client.sendNotification(method, params);
    }

    /* ---------- 诊断查询 ---------- */

    public getDiagnosticMessages(uri: string): LspDiagnostic[] {
        const diagnostic = this.diagnosticMap.get(uri);
        return diagnostic ? diagnostic.get() : [];
    }

    public clearDiagnostic(uri: string): void {
        this.diagnosticMap.get(uri)?.clear();
    }

    /* ========== 消息分发 ========== */

    private handleRawMessage(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[LSP] JSON parse error: ${errorMessage}, raw: ${raw}`);
            return;
        }

        if ('id' in msg && ('result' in msg || 'error' in msg)) {
            this.handleResponse(msg as unknown as LspResponse);
        } else if ('method' in msg) {
            this.handleNotificationOrRequest(msg as unknown as LspNotification & Partial<LspRequest>);
        } else {
            logger.warn(`[LSP] Unrecognized message: ${JSON.stringify(msg).slice(0, 200)}`);
        }
    }

    /** 处理标准 LSP response（匹配 pending request id）。 */
    private handleResponse(msg: LspResponse): void {
        const id = msg.id;
        if (id === undefined) {
            return;
        }
        const key = typeof id === 'string' ? id : id;
        if (msg.error) {
            const err = new Error(`LSP error ${msg.error.code}: ${msg.error.message}`);
            this.requestCallbacks.rejectPending(key, err);
        } else {
            this.requestCallbacks.resolvePending(key, msg.result);
        }
    }

    /** 处理 S→C notification 或 S→C request。 */
    private handleNotificationOrRequest(msg: LspNotification & Partial<LspRequest>): void {
        const method = msg.method;
        if (!method) {
            return;
        }
        this.initProgressReset?.();
        const waiter = this.notificationWaiters.get(method);
        if (waiter) {
            this.notificationWaiters.delete(method);
            waiter();
            return;
        }
        switch (method) {
            case LSP_METHOD.PUBLISH_DIAGNOSTICS:
                this.handlePublishDiagnostics(msg.params as PublishDiagnosticsParams);
                break;
            case LSP_METHOD.PROGRESS:
                this.handleProgress(msg.params);
                break;
            case LSP_METHOD.WINDOW_SHOW_MESSAGE:
                logger.debug(`[LSP] window/showMessage: ${JSON.stringify(msg.params)}`);
                break;
            case LSP_METHOD.WINDOW_LOG_MESSAGE:
                logger.debug(`[LSP] window/logMessage: ${JSON.stringify(msg.params)}`);
                break;
            default:
                // 其他未识别通知上抛给上层
                this.broadcastToClients(msg as unknown as LspMessage);
        }
    }

    private handlePublishDiagnostics(params: PublishDiagnosticsParams): void {
        if (!params || !params.uri) {
            return;
        }
        const uri = params.uri;
        const diagnostic = this.diagnosticMap.get(uri);
        if (!diagnostic) {
            return;
        }
        const diagnostics = params.diagnostics || [];
        this.normalizeDiagnostics(diagnostics);
        diagnostic.set(diagnostics);
        this.finalizeDiagnostic(uri, diagnostics);
    }

    private normalizeDiagnostics(diagnostics: LspDiagnostic[]): void {
        for (const diag of diagnostics) {
            if (diag.severity !== undefined) {
                // 标准 LSP severity 是数字 (1-4)，保留原值
                // 如需人类可读字符串可附加 severityStr
                const map: Record<number, string> = {
                    1: 'Error',
                    2: 'Warning',
                    3: 'Information',
                    4: 'Hint',
                };
                (diag as LspDiagnostic & { severityStr?: string }).severityStr =
                    map[diag.severity as number] || 'Unknown';
            }
            // LSP 规范 position.line 是 0-based，这里保持原值不再 +1
        }
    }

    private handleProgress(params: unknown): void {
        if (!isRecord(params)) {
            return;
        }
        // $/progress 通知，转发给上层
        this.broadcastToClients({
            jsonrpc: JSONRPC_VERSION,
            method: LSP_METHOD.PROGRESS,
            params,
        });
    }

    /* ========== 诊断超时/完成 ========== */

    private registerDiagnosticTimeout(uri: string): void {
        this.requestCallbacks.registerTimeout(uri, LSP_METHOD.PUBLISH_DIAGNOSTICS, DIAGNOSTIC_TIMEOUT_MS, () => {
            const diagnostic = this.diagnosticMap.get(uri);
            const diagnostics = diagnostic ? diagnostic.get() : [];
            this.finalizeDiagnostic(
                uri,
                diagnostics,
                diagnostics.length > 0
                    ? undefined
                    : `received no diagnostics within ${DIAGNOSTIC_TIMEOUT_MS}ms, uri: ${uri}`,
            );
        });
    }

    private finalizeDiagnostic(uri: string, diagnostics: LspDiagnostic[], errorMessage?: string): void {
        const payload = {
            uri,
            diagnostics,
            ...(errorMessage ? { errorMessage } : {}),
        };
        this.requestCallbacks.emit(uri, LSP_METHOD.PUBLISH_DIAGNOSTICS, payload);
        this.diagnosticMap.get(uri)?.clear();
    }

    /* ========== 错误处理 ========== */

    private handleError(error: Error): void {
        const pendingUris = Array.from(this.diagnosticMap.keys()).filter((uri) =>
            this.requestCallbacks.hasCallback(uri),
        );
        if (pendingUris.length > 0) {
            const errorDiag: LspDiagnostic = {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                severity: 1,
                message: error.message,
            };
            for (const uri of pendingUris) {
                this.finalizeDiagnostic(uri, [errorDiag]);
            }
            return;
        }
        this.broadcastToClients({
            jsonrpc: JSONRPC_VERSION,
            method: LSP_METHOD.ARKTS_ERROR,
            params: { message: error.message },
        });
    }

    /* ========== 清理 ========== */

    private cleanupDiagnosticState(uri: string): void {
        this.requestCallbacks.clear(uri);
        this.diagnosticMap.delete(uri);
    }
}
