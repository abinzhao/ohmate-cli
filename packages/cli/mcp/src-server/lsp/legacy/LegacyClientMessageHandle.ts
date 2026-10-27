/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { LspClient, LspClientConfig } from '../core/LspClient.js';
import { RequestCallbackManager } from '../core/RequestCallbackManager.js';
import { LegacyDiagnostic } from './LegacyDiagnostic.js';
import { PublishDiagnosticsParams, LspDiagnostic, Range } from '../core/LspProtocols.js';
import { DidChangeParam } from './legacy-types.js';
import { logger } from '../logger.js';
import { Params } from '../model/Params.js';
import { toFileUri } from '../utils.js';
import { EtsFileItem, OpenFileParam, LspMessage } from '../types.js';
import { CallbackRegistry } from '../common/CallbackRegistry.js';
import { isRecord } from '../common/typeGuards.js';
import { JSONRPC_VERSION } from '../constant.js';
import { LEGACY_LSP_METHOD, LEGACY_LSP_SEND_LABEL, LEGACY_EXPECTED_DIAGNOSTIC_TYPES } from './legacy-constant.js';

/** 生命周期无参或广播带参：(msg?: LspMessage) => void，统一用 CallbackRegistry 注册/触发 */
type MessageCallback = (msg?: LspMessage) => void;
type DiagnosticResultPayload = {
    uri: string;
    diagnostics: string[];
    errorMessage?: string;
};

type TextDocumentUriParams = {
    textDocument: { uri: string };
    requestId?: unknown;
} & Record<string, unknown>;

type WatchedFileChange = {
    uri: string;
    type: number;
};

function hasTextDocumentUri(params: unknown): params is TextDocumentUriParams {
    if (!isRecord(params)) {
        return false;
    }
    const textDocument = params.textDocument;
    return isRecord(textDocument) && typeof textDocument.uri === 'string';
}

function isWatchedFileChange(value: unknown): value is WatchedFileChange {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.uri === 'string' && typeof value.type === 'number';
}

/** 格式化 ProgressUpdate 的 params 为可读进度，缺字段时回退原始 JSON。 */
function formatIndexingProgress(params: unknown): string {
    if (
        isRecord(params) &&
        typeof params.moduleName === 'string' &&
        typeof params.current === 'number' &&
        typeof params.total === 'number'
    ) {
        return `indexing module '${params.moduleName}', ${params.current} of total ${params.total} modules`;
    }
    return `params=${JSON.stringify(params ?? null)}`;
}

/**
 * LegacyClientMessageHandle：LSP 服务端消息处理入口
 */
export class LegacyClientMessageHandle {
    private readonly client: LspClient;
    private isInitialized = false;
    private stopOnce: Promise<void> | null = null;
    private readonly callbacks = new CallbackRegistry<string, MessageCallback>();
    private readonly requestCallbacks = new RequestCallbackManager();
    public readonly diagnosticMap = new Map<string, LegacyDiagnostic>();
    private static readonly DIAGNOSTIC_TIMEOUT_MS = 20 * 1000;

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
     * 发送 LSP exit；子进程通常在收到 notify 后自行退出（不是靠父进程 SIGKILL）。
     */
    public stop(): Promise<void> {
        if (!this.stopOnce) {
            this.stopOnce = (async () => {
                logger.info('[LegacyClientMessageHandle] Sending exit notification to LSP');
                this.client.sendRaw(
                    JSON.stringify({
                        jsonrpc: JSONRPC_VERSION,
                        method: LEGACY_LSP_METHOD.EXIT,
                        params: {},
                    }),
                    LEGACY_LSP_SEND_LABEL.EXIT,
                );
                logger.info('[LegacyClientMessageHandle] Waiting for LSP process to exit');
                await this.client.waitForExitOrTimeout(300);
                logger.info('[LegacyClientMessageHandle] LSP exit wait completed, calling stop');
                this.client.stop();
            })();
        }
        return this.stopOnce;
    }

    /** 注册“广播给所有客户端”的回调，invoke 时传入 LspMessage。多次调用会覆盖。 */
    public setBroadcastToClients(callback: (msg: LspMessage) => void): void {
        this.callbacks.unregister(LEGACY_LSP_METHOD.BROADCAST);
        this.callbacks.register(LEGACY_LSP_METHOD.BROADCAST, callback as MessageCallback);
    }

    /** 触发已注册的广播回调，将 msg 发给所有客户端。 */
    public broadcastToClients(msg: LspMessage): void {
        this.callbacks.invoke(LEGACY_LSP_METHOD.BROADCAST, msg);
    }

    /** 初始化完成时（收到 aceProject/onModuleInitFinish）。若已初始化则立即执行。 */
    public onInitializationCompleted(callback: () => void): void {
        if (this.isInitialized) {
            callback();
        } else {
            this.callbacks.register(LEGACY_LSP_METHOD.MODULE_INIT_FINISH, callback as MessageCallback);
        }
    }

    /** 收到 aceProject/onIndexingProgressUpdate 时调用。 */
    public onIndexingProgressUpdate(callback: () => void): void {
        this.callbacks.register(LEGACY_LSP_METHOD.INDEXING_PROGRESS_UPDATE, callback as MessageCallback);
    }

    /** 按 key（uri 或 requestId）注册异步完成回调，完成或超时时会调用 (method, payload)。 */
    public registerRequestCallback(key: string | number, callback: (method: string, payload: unknown) => void): void {
        this.requestCallbacks.register(key, callback);
    }

    public sendInitialize(param: Params, id?: number | string): void {
        this.client.send('initialize', param, id);
    }

    public sendInitialized(editorOpenFiles: EtsFileItem[]): void {
        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: LEGACY_LSP_METHOD.INITIALIZED,
                params: { editors: editorOpenFiles },
            }),
            LEGACY_LSP_SEND_LABEL.INITIALIZED,
        );
        this.client.sendRaw(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 0, result: {} }), LEGACY_LSP_SEND_LABEL.EMPTY);
    }

    /**
     * 通用：向 LSP 发送带 requestId 的异步请求，用于 hover、definition 等按 requestId 回包的能力。
     */
    public sendAsyncRequest(serverMethod: string, params: unknown, requestId: number, logLabel?: string): void {
        if (!isRecord(params)) {
            logger.warn(`[LSP] sendAsyncRequest invalid params, method=${serverMethod}`);
            return;
        }
        if (!hasTextDocumentUri(params)) {
            logger.warn(
                `[LSP] sendAsyncRequest missing textDocument.uri, method=${serverMethod}, params=${JSON.stringify(
                    params,
                )}`,
            );
            return;
        }
        if (typeof requestId !== 'number') {
            logger.warn(
                `[LSP] sendAsyncRequest invalid requestId, method=${serverMethod}, requestId=${String(requestId)}`,
            );
            return;
        }

        const filePath = params.textDocument.uri;
        const uri = toFileUri(filePath);
        params.textDocument.uri = uri;
        delete params.requestId;
        const label = logLabel ?? serverMethod;
        logger.info(`[LSP] sendAsyncRequest ${label}, filePath: ${filePath}`);
        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: serverMethod,
                params: { params, requestId },
            }),
            label,
        );
    }

    public onDidChangeWatchedFiles(params: unknown[]): void {
        logger.info(`[LSP] onDidChangeWatchedFiles, params=${JSON.stringify(params)}`);
        if (params.length === 0) {
            return;
        }
        const validParams: WatchedFileChange[] = [];
        for (const param of params) {
            // 校验 uri 和 type 是否存在
            if (!isWatchedFileChange(param)) {
                logger.warn(
                    `[LSP] onDidChangeWatchedFiles, param is missing 'uri' or 'type': ${JSON.stringify(param)}`,
                );
                continue;
            }
            // 透传 URI（SourceFileWatcher 经 common.ts::toFileUri 产出，file:///D:/...，冒号不编码）。
            // 无需在此重编码成 %3A：server 侧 getFileFsPath = URI.parse(uri).fsPath 会 decode %3A→:，
            // 故 `:` 与 `%3A` 两种 URI 都归一到同一 fs path，不存在缓存键失配（Windows legacy 亦然）。
            validParams.push(param);
        }
        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: LEGACY_LSP_METHOD.WORKSPACE_DID_CHANGE_WATCHED_FILES,
                params: { changes: validParams },
            }),
            LEGACY_LSP_METHOD.WORKSPACE_DID_CHANGE_WATCHED_FILES,
        );
    }

    public sendModuleDependencyUpdate(params: unknown): void {
        if (!isRecord(params) || !Array.isArray(params.moduleSet) || params.moduleSet.length === 0) {
            logger.warn('[LSP] sendModuleDependencyUpdate, moduleSet is empty or null');
            return;
        }
        const moduleSet = params.moduleSet;
        logger.info(`[LSP] sending module dependency updated, count: ${moduleSet.length}`);
        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: LEGACY_LSP_METHOD.ON_DID_CHANGE_PACKAGE_DEPENDENCIES,
                params: { params },
            }),
            LEGACY_LSP_SEND_LABEL.ON_DID_CHANGE_PACKAGE_DEPENDENCIES,
        );
    }

    public onAsyncOpenFile(param: OpenFileParam): void {
        const filePath = param.textDocument.uri;
        const ext = filePath.split('.').pop() || '';
        if (ext !== 'ets' && ext !== 'ts') {
            return;
        }
        const uri = toFileUri(filePath);
        param.textDocument.uri = uri;
        logger.info(`[LSP] onAsyncOpenFile, uri: ${uri}`);

        let diagnostic = this.diagnosticMap.get(uri);
        if (!diagnostic) {
            diagnostic = new LegacyDiagnostic(uri);
            this.diagnosticMap.set(uri, diagnostic);
            this.registerDiagnosticTimeout(uri, LEGACY_LSP_METHOD.PUBLISH_DIAGNOSTICS);
        }
        if (param.isFromEditor) {
            diagnostic.isFromEditor = true;
        }

        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: LEGACY_LSP_METHOD.ON_ASYNC_DID_OPEN,
                params: {
                    params: {
                        editorFiles: param.editorFiles,
                        textDocument: param.textDocument,
                    },
                },
            }),
            LEGACY_LSP_SEND_LABEL.ON_ASYNC_DID_OPEN,
        );
    }

    public onAsyncDidChange(param: DidChangeParam): void {
        const uri = toFileUri(param.uri);
        const diagnostic = this.diagnosticMap.get(uri);
        if (diagnostic) {
            diagnostic.clear();
            this.registerDiagnosticTimeout(uri, LEGACY_LSP_METHOD.PUBLISH_DIAGNOSTICS);
        }
        logger.info(`[LSP] onAsyncDidChange, uri: ${uri}`);
        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: LEGACY_LSP_METHOD.ON_ASYNC_DID_CHANGE,
                params: {
                    editorFiles: [param.uri],
                    params: {
                        textDocument: {
                            uri,
                            version: param.version === 0 ? null : param.version,
                        },
                        contentChanges: param.contentChanges,
                    },
                },
            }),
            LEGACY_LSP_SEND_LABEL.ON_ASYNC_DID_CHANGE,
        );
    }

    public closeFile(filePath: string, isManual: boolean): void {
        const uri = toFileUri(filePath);
        logger.info(`[LSP] didClose, uri: ${uri}`);
        const diagnostic = this.diagnosticMap.get(uri);
        if (!isManual && (!diagnostic || diagnostic.isFromEditor)) {
            logger.info(`[LSP] closeFile skip, !diagnostic: ${!diagnostic}, isFromEditor: ${diagnostic?.isFromEditor}`);
            return;
        }
        this.cleanupDiagnosticState(uri);
        this.client.sendRaw(
            JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: LEGACY_LSP_METHOD.DID_CLOSE,
                params: { textDocument: { uri } },
            }),
            LEGACY_LSP_SEND_LABEL.DID_CLOSE,
        );
    }

    public getDiagnosticMessage(checkFilePath: string): string[] {
        const uri = toFileUri(checkFilePath);
        const diagnostic = this.diagnosticMap.get(uri);
        return diagnostic ? diagnostic.getMessages() : [];
    }

    public clear(uri: string): void {
        this.diagnosticMap.get(uri)?.clear();
    }

    private handleRawMessage(raw: string): void {
        try {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            this.handleLspMessage(msg);
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[LSP] JSON parse error: ${errorMessage}, raw: ${raw}`);
        }
    }

    private handleError(error: Error): void {
        const pendingUris = this.getPendingDiagnosticUris();
        if (pendingUris.length > 0) {
            // 诊断期间异常时，仅触发仍在等待回调的 uri，避免误伤非诊断场景。
            const errorDiagnostic = JSON.stringify({
                message: error.message,
                severity: 'Error',
                severityStr: 'Error',
            });
            for (const uri of pendingUris) {
                this.finalizeDiagnostic(uri, LEGACY_LSP_METHOD.PUBLISH_DIAGNOSTICS, [errorDiagnostic]);
            }
            return;
        }
        this.broadcastToClients({
            jsonrpc: JSONRPC_VERSION,
            method: LEGACY_LSP_METHOD.ARKTS_ERROR,
            params: { message: error.message },
        });
    }

    private handleLspMessage(msg: Record<string, unknown>): void {
        const method = msg.method as string | undefined;
        if (method === undefined) {
            return;
        }

        if (!this.isInitialized && this.handlePreInitMessage(method, msg)) {
            return;
        }

        this.handlePostInitMessage(method, msg);
    }

    private handlePreInitMessage(method: string, msg: Record<string, unknown>): boolean {
        switch (method) {
            case LEGACY_LSP_METHOD.MODULE_INIT_FINISH:
                logger.info('[LSP] handleLspMessage, receive onModuleInitFinish');
                this.isInitialized = true;
                this.callbacks.invokeOnce(LEGACY_LSP_METHOD.MODULE_INIT_FINISH);
                this.callbacks.unregister(LEGACY_LSP_METHOD.INDEXING_PROGRESS_UPDATE);
                this.client.emit('initialized_done');
                return true;
            case LEGACY_LSP_METHOD.INDEXING_PROGRESS_UPDATE:
                logger.info(
                    `[LSP] onIndexingProgressUpdate: ${formatIndexingProgress(msg.params)}`,
                );
                this.callbacks.invoke(LEGACY_LSP_METHOD.INDEXING_PROGRESS_UPDATE);
                return true;
            default:
                return false;
        }
    }

    private handlePostInitMessage(method: string, msg: Record<string, unknown>): void {
        switch (method) {
            case LEGACY_LSP_METHOD.ON_FORCE_OPEN_FILE:
                this.handleOnForceOpenFile(msg);
                return;
            case LEGACY_LSP_METHOD.ON_PACKAGE_CHANGE_FINISH:
                logger.info('[LSP] handleLspMessage, receive onPackageChangeFinish');
                this.handlePackageChangeFinish(msg);
                return;
            case LEGACY_LSP_METHOD.PUBLISH_DIAGNOSTICS:
                this.handlePublishDiagnostics(msg);
                return;
            case LEGACY_LSP_METHOD.ON_ASYNC_HOVER:
                this.handleAsyncResponse(msg, LEGACY_LSP_METHOD.HOVER);
                return;
            case LEGACY_LSP_METHOD.ON_ASYNC_DEFINITION:
                this.handleAsyncResponse(msg, LEGACY_LSP_METHOD.TEXT_DOCUMENT_ON_ASYNC_DEFINITION);
                return;
            case LEGACY_LSP_METHOD.ON_ASYNC_FIND_USAGES:
                this.handleAsyncResponse(msg, LEGACY_LSP_METHOD.REFERENCES);
                return;
            default:
                logger.warn(
                    `[LSP] handleLspMessage: no handler for notification, ignoring, method: ${method}, initialized: ${this.isInitialized}`,
                );
        }
    }

    private handleOnForceOpenFile(msg: Record<string, unknown>): void {
        logger.info('[LSP] handleLspMessage, receive onForceOpenFile');
        const params = msg.params;
        if (isRecord(params) && isRecord(params.result) && typeof params.result.uri === 'string') {
            this.handleForceOpenFile(params.result.uri);
        }
    }

    private handlePublishDiagnostics(msg: Record<string, unknown>): void {
        logger.info('[LSP] handleLspMessage, receive publishDiagnostics');
        const params = msg.params as PublishDiagnosticsParams;
        if (params) {
            this.parseDiagnostics(params);
        }
    }

    private handlePackageChangeFinish(msg: Record<string, unknown>): void {
        const params = msg.params;
        const failMsg: LspMessage = {
            jsonrpc: JSONRPC_VERSION,
            method: LEGACY_LSP_METHOD.ON_PACKAGE_CHANGE_FINISH,
            params: [false],
        };
        if (!params || !Array.isArray(params)) {
            logger.warn('[LSP] aceProject/onPackageChangeFinish params invalid');
            this.broadcastToClients(failMsg);
            return;
        }
        const success = params.length > 0 && params[0] === true;
        if (!success) {
            logger.warn('[LSP] aceProject/onPackageChangeFinish: package request failed');
            this.broadcastToClients(failMsg);
            return;
        }
        logger.info('[LSP] aceProject/onPackageChangeFinish: success');
        this.broadcastToClients(msg as unknown as LspMessage);
    }

    private handleAsyncResponse(msg: Record<string, unknown>, method: string): void {
        logger.info(`[LSP] handleAsyncResponse， method: ${method}`);
        const params = msg.params;
        if (!isRecord(params)) {
            logger.warn('[LSP] aceProject/onAsyncHover message invalid');
            return;
        }
        const requestId = params.requestId;
        if (typeof requestId !== 'number') {
            logger.warn(`[LSP] ${method} requestId invalid`);
            return;
        }
        this.requestCallbacks.emit(requestId, method, params);
    }

    private handleForceOpenFile(uri: string): void {
        if (!uri) {
            logger.warn('[LSP] handleForceOpenFile, uri is empty');
            return;
        }
        this.requestCallbacks.emit(uri, LEGACY_LSP_METHOD.DID_OPEN, []);
        this.clear(uri);
    }

    private parseDiagnostics(params: PublishDiagnosticsParams): void {
        const uriStr = params.uri;
        if (!uriStr) {
            logger.info('[LSP] publishDiagnostics uri is null');
            return;
        }
        const version = params.version ?? -1;
        if (version === -1) {
            return;
        }

        const diagnostic = this.diagnosticMap.get(uriStr);
        if (!diagnostic) {
            logger.info(`[LSP] Diagnostic cleared for uri: ${uriStr}`);
            return;
        }

        const diagnosticsArray = params.diagnostics || [];
        if (diagnosticsArray.length !== 0) {
            diagnosticsArray.forEach((diag: LspDiagnostic) => {
                this.normalizeDiagnostic(diag);
                diagnostic.addMessage(version, JSON.stringify(diag));
            });
        } else {
            diagnostic.setReceivedType(version);
        }

        if (diagnostic.hasReceivedAllTypes(LEGACY_EXPECTED_DIAGNOSTIC_TYPES)) {
            this.finalizeDiagnostic(uriStr, LEGACY_LSP_METHOD.PUBLISH_DIAGNOSTICS, diagnostic.getMessages());
        }
    }

    private normalizeDiagnostic(diag: LspDiagnostic): void {
        const d = diag as unknown as { source?: unknown; severity?: number | string; severityStr?: string };
        delete d.source;
        if (d.severity !== undefined) {
            const severity = typeof d.severity === 'number' ? d.severity : parseInt(d.severity as string);
            const map: Record<number, string> = {
                1: 'Error',
                2: 'Warning',
                3: 'Information',
                4: 'Hint',
            };
            const severityStr = map[severity] || 'Unknown';
            d.severityStr = severityStr;
            d.severity = severityStr;
        }
        if (diag.range) {
            this.adjustPositionLine(diag.range, 'start');
            this.adjustPositionLine(diag.range, 'end');
        }
    }

    private adjustPositionLine(range: Range, key: 'start' | 'end'): void {
        const pos = range[key];
        if (pos && typeof pos.line === 'number') {
            pos.line = pos.line + 1;
        }
    }

    /*
     * @param {uri}: 注册超时的文件地址
     * @param {method}: 超时后发送请求
     *
     */
    private registerDiagnosticTimeout(uri: string, method: string): void {
        this.requestCallbacks.registerTimeout(uri, method, LegacyClientMessageHandle.DIAGNOSTIC_TIMEOUT_MS, () => {
            const diagnostic = this.diagnosticMap.get(uri);
            const diagnostics = diagnostic ? diagnostic.getMessages() : [];
            this.finalizeDiagnostic(
                uri,
                method,
                diagnostics,
                diagnostics.length > 0
                    ? undefined
                    : `received no diagnostics within ${LegacyClientMessageHandle.DIAGNOSTIC_TIMEOUT_MS}ms from LSP, uri: ${uri}`,
            );
        });
    }

    private finalizeDiagnostic(uri: string, method: string, diagnostics: string[], errorMessage?: string): void {
        const payload: DiagnosticResultPayload = {
            uri,
            diagnostics,
            ...(errorMessage ? { errorMessage } : {}),
        };
        this.requestCallbacks.emit(uri, method, payload);
        this.diagnosticMap.get(uri)?.clear();
    }

    private getPendingDiagnosticUris(): string[] {
        return Array.from(this.diagnosticMap.keys()).filter((uri) => this.requestCallbacks.hasCallback(uri));
    }

    private cleanupDiagnosticState(uri: string): void {
        this.requestCallbacks.clear(uri);
        this.diagnosticMap.delete(uri);
    }
}
