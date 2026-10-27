/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { EtsFileItem, isNotificationRequest, LspMessage, LspNotification, LspRequest, OpenFileParam } from './types.js';
import { ClientMessageHandle } from './core/ClientMessageHandle.js';
import { LegacyClientMessageHandle } from './legacy/LegacyClientMessageHandle.js';
import { getLogPath, logger } from './logger.js';
import path from 'path';
import { InitializationOptions } from './model/InitializationOptions.js';
import { ModuleModel } from './model/ModuleModel.js';
import { ModuleJsonParam } from './model/ModuleJsonParam.js';
import { ModulesDependencyParse, DepsOnlyItem } from './parse/ModulesDependencyParse.js';
import { Capabilities } from './model/Capabilities/Capabilities.js';
import { Params } from './model/Params.js';
import { ModuleDependencyInfo } from './model/ModuleDependencyInfo.js';
import { computeLspServerMaxSize, normalizePath, toFileUri } from './utils.js';
import { resolveArktsServerEntry } from '../utils/common.js';
import { ReloadEvent } from './watcher/DependencyMapWatcher.js';
import { ACE_SERVER_METHOD, JSONRPC_VERSION, LSP_INIT_TIMEOUT_MS, LSP_METHOD } from './constant.js';
import { isRecord } from './common/typeGuards.js';
import type {
    DidOpenTextDocumentParams,
    DidChangeTextDocumentParams,
    DidCloseTextDocumentParams,
    HoverParams,
    DefinitionParams,
    ReferenceParams,
    Position,
    DocumentDiagnosticParams,
} from './core/LspProtocols.js';

/**
 * LspServerProxy
 *
 * 进程内单例：直接持有 ClientMessageHandle（其内部 spawn 唯一一个 ace-server 子进程），
 * 使用标准 LSP 协议与子进程通信。所有语言特性请求通过标准 request/response 完成。
 */
export class LspServerProxy {
    private messageHandle: ClientMessageHandle | LegacyClientMessageHandle;
    /** 标准协议句柄（仅 useStandardProtocol=true 时有效；legacy 模式不应调用 standard-only 方法）。 */
    private get stdHandle(): ClientMessageHandle {
        return this.messageHandle as ClientMessageHandle;
    }
    /** 老版本协议句柄（仅 useStandardProtocol=false 时有效）。 */
    private get legacyHandle(): LegacyClientMessageHandle {
        return this.messageHandle as LegacyClientMessageHandle;
    }
    /** ace-server 子进程 pid；未启动为 null。 */
    public get lspPid(): number | null {
        return this.messageHandle.lspPid;
    }
    /** 老版本：onAsyncOpenFile。仅 legacy 模式调用。 */
    onAsyncOpenFile(param: OpenFileParam): void {
        this.legacyHandle.onAsyncOpenFile(param);
    }
    /** 老版本：closeFile(uri, isManual)。仅 legacy 模式调用。 */
    closeFileLegacy(uri: string, isManual: boolean): void {
        this.legacyHandle.closeFile(uri, isManual);
    }
    private serverPath: string;
    private logPath: string;
    private lastStartErrorMessage: string | null = null;
    private currentParams: Params | null = null;
    private indexLogPath: string;
    private lastDepsOnlyForDiff: DepsOnlyItem[] = [];

    private get currentModuleModels(): ModuleModel[] {
        return this.currentParams?.initializationOptions?.modules ?? [];
    }

    constructor(
        private sdkPath: string,
        arktsLangServer: string,
        private rootUri: string,
        indexLogPath: string,
        private nodeMaxOldSpaceSize?: number,
        private readonly useStandardProtocol: boolean = true,
        private readonly nodePath?: string,
        private readonly useSocket: boolean = false,
    ) {
        // socket 与 stdio 共用同一入口（standardIndex/index.js），按协议版本选；socket 仅换启动 flag
        this.serverPath = resolveArktsServerEntry(arktsLangServer, this.useStandardProtocol);
        this.logPath = getLogPath();
        this.indexLogPath = indexLogPath || this.logPath;
        logger.debug(`[LspServerProxy] arktsLangServer=${arktsLangServer}`);
        logger.debug(`[LspServerProxy] useStandardProtocol=${this.useStandardProtocol}, useSocket=${this.useSocket}`);
        logger.debug(`[LspServerProxy] serverPath=${this.serverPath}`);
        const handleConfig = {
            serverPath: this.serverPath,
            logPath: this.logPath,
            indexingDataLocation: this.indexLogPath,
            projectPath: this.rootUri,
            useSocket: this.useSocket,
            nodePath: this.nodePath,
        };
        this.messageHandle = this.useStandardProtocol
            ? new ClientMessageHandle(handleConfig)
            : new LegacyClientMessageHandle(handleConfig);
        this.messageHandle.setBroadcastToClients((msg: LspMessage) => this.onLspMessage(msg));
    }

    /**
     * 标准 LSP 启动流程：
     *  1. spawn 子进程
     *  2. 解析模块依赖图
     *  3. send initialize request → 等待 response（capabilities）
     *  4. send initialized notification
     */
    async start(
        editorOpenFiles: EtsFileItem[],
        onInitialized?: (success: boolean) => void,
        onDepParseProgress?: (current: number, total: number) => void,
    ): Promise<void> {
        let success = false;
        try {
            logger.debug(`serverPath: ${this.serverPath}`);
            logger.debug(`rootUri: ${this.rootUri}`);
            logger.debug(`sdkPath: ${this.sdkPath}`);
            logger.debug(`logPath: ${this.logPath}`);

            const fileUri = toFileUri(this.rootUri);
            const options = new InitializationOptions(fileUri, this.serverPath, this.logPath, this.indexLogPath);

            // 先解析模块：解析失败则不启动 LSP 进程
            const moduleModels: ModuleModel[] = [];
            const parser = new ModulesDependencyParse(this.rootUri, this.sdkPath);
            const depMapResult = parser.getAllDependencyMap(moduleModels, onDepParseProgress);
            if (depMapResult.status === 'ERROR') {
                throw new Error(`${depMapResult.message}`);
            }
            this.fillModuleModelsPaths(moduleModels);
            options.modules = moduleModels;

            // 解析成功后，按模块数动态计算 serverMaxSize，再启动进程
            const serverMaxSize = computeLspServerMaxSize(moduleModels.length, this.nodeMaxOldSpaceSize);
            await this.messageHandle.start(serverMaxSize);

            this.currentParams = new Params(fileUri, options, new Capabilities());

            if (this.useStandardProtocol) {
                await this.startStandardProtocol(this.currentParams);
            } else {
                await this.startLegacy(this.currentParams, editorOpenFiles);
            }
            success = true;
        } catch (e) {
            this.lastStartErrorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[LSP] Initialization failed: ${this.lastStartErrorMessage}`);
            await this.messageHandle.stop();
        }
        onInitialized?.(success);
    }

    /** 标准协议初始化：socket 模式同时等待 initialize response 与 onModuleInitFinish，stdio 模式仅等 response。 */
    private async startStandardProtocol(params: Params): Promise<void> {
        const handle = this.messageHandle as ClientMessageHandle;
        const broadcastProgress = () =>
            handle.broadcastToClients({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_INDEXING_PROGRESS,
                params: {},
            });
        if (this.useSocket) {
            logger.info('[LSP] socket mode: waiting for initialize response + aceProject/onModuleInitFinish');
            await handle.sendInitializeAndWaitForNotification(
                params,
                ACE_SERVER_METHOD.MODULE_INIT_FINISH,
                LSP_INIT_TIMEOUT_MS,
                () => {
                    logger.info('[LSP] initialize response received');
                    broadcastProgress();
                    handle.sendInitialized();
                },
                broadcastProgress,
            );
            logger.info('[LSP] initialize response + onModuleInitFinish received, initialization complete');
        } else {
            await handle.sendInitializeResettable(params, LSP_INIT_TIMEOUT_MS);
            logger.info('[LSP] initialize response received');
            broadcastProgress();
            handle.sendInitialized();
        }
    }

    /**
     * 老版本 ace-server 私有协议启动流程：
     *  1. sendInitialize(params, 1)（fire-and-forget，不发标准 request）
     *  2. 等 aceProject/onIndexingProgressUpdate（进度）+ aceProject/onModuleInitFinish（完成）
     *  3. sendInitialized(editorOpenFiles)（带 editors）
     */
    private async startLegacy(params: Params, editorOpenFiles: EtsFileItem[]): Promise<void> {
        const handle = this.messageHandle as LegacyClientMessageHandle;
        handle.sendInitialize(params, 1);
        handle.onIndexingProgressUpdate(() => {
            this.onLspMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_INDEXING_PROGRESS,
                params: {},
            });
        });
        await this.withResettableTimeout(
            (resolve, reset) => {
                handle.onIndexingProgressUpdate(reset);
                handle.onInitializationCompleted(resolve);
            },
            'LSP initialization',
            LSP_INIT_TIMEOUT_MS,
        );
        handle.sendInitialized(editorOpenFiles);
    }

    private withResettableTimeout(
        registerCallback: (resolve: () => void, reset: () => void) => void,
        operationName: string,
        timeoutMs: number,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout>;
            const schedule = () => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            };
            const reset = () => {
                clearTimeout(timeoutId);
                schedule();
            };
            schedule();
            registerCallback(() => {
                clearTimeout(timeoutId);
                resolve();
            }, reset);
        });
    }

    consumeStartErrorMessage(): string | null {
        const message = this.lastStartErrorMessage;
        this.lastStartErrorMessage = null;
        return message;
    }

    private onLspMessage: (msg: LspMessage) => void = () => {};

    setOnMessage(callback: (msg: LspMessage) => void): void {
        this.onLspMessage = callback;
    }

    /** 注册诊断回调：文件被打开后，收到 publishDiagnostics 时回调。 */
    registerDiagnosticCallback(uri: string): void {
        logger.debug(`[LSP] registerDiagnosticCallback uri='${uri}', useStandardProtocol=${this.useStandardProtocol}`);
        this.messageHandle.registerRequestCallback(uri, (method: string, payload: unknown) => {
            const diagnosticPayload = isRecord(payload) ? payload : {};
            logger.debug(`[LSP] onDiagnosticCompleted called, uri: ${uri}`);
            const response: LspNotification = {
                jsonrpc: JSONRPC_VERSION,
                method,
                params: {
                    uri: typeof diagnosticPayload.uri === 'string' ? diagnosticPayload.uri : uri,
                    diagnostics: Array.isArray(diagnosticPayload.diagnostics)
                        ? diagnosticPayload.diagnostics
                        : [],
                    ...(typeof diagnosticPayload.errorMessage === 'string'
                        ? { errorMessage: diagnosticPayload.errorMessage }
                        : {}),
                },
            };
            this.onLspMessage(response);
        });
    }

    /* ========== 标准语言特性请求（返回 Promise） ========== */

    /** textDocument/hover — 返回标准 Hover 结果。 */
    async hover(params: HoverParams): Promise<unknown> {
        const uri = params.textDocument.uri;
        this.registerDiagnosticCallback(uri);
        return this.stdHandle.sendLspRequest(LSP_METHOD.HOVER, params);
    }

    /** textDocument/definition — 返回标准 Definition 结果。 */
    async definition(params: DefinitionParams): Promise<unknown> {
        return this.stdHandle.sendLspRequest(LSP_METHOD.DEFINITION, params);
    }

    /** textDocument/references — 返回标准 Location[] 结果。 */
    async references(params: ReferenceParams): Promise<unknown> {
        return this.stdHandle.sendLspRequest(LSP_METHOD.REFERENCES, params);
    }

    /** textDocument/completion — 返回标准 CompletionList 结果。 */
    async completion(params: { textDocument: { uri: string }; position: Position }): Promise<unknown> {
        return this.stdHandle.sendLspRequest(LSP_METHOD.COMPLETION, params);
    }

    /** textDocument/documentSymbol — 返回标准 DocumentSymbol[] 结果。 */
    async documentSymbol(params: { textDocument: { uri: string } }): Promise<unknown> {
        return this.stdHandle.sendLspRequest(LSP_METHOD.DOCUMENT_SYMBOL, params);
    }

    /** textDocument/diagnostic — 返回标准 DocumentDiagnosticReport 结果。 */
    async diagnostic(params: DocumentDiagnosticParams): Promise<unknown> {
        return this.stdHandle.sendLspRequest(LSP_METHOD.DIAGNOSTIC, params, 2 * 60 * 1000);
    }

    /**
     * 通用语言特性请求：直接发 LSP request 并 await response。
     * 供 hover / definition / references / completion 等使用，
     * 由调用方保证 method 名称和 params 结构正确。
     */
    async sendFeatureRequest(method: string, params: unknown): Promise<unknown> {
        return this.stdHandle.sendLspRequest(method, params);
    }

    /* ========== 依赖管理 ========== */

    /**
     * 仅解析依赖并更新 ModuleModel，通过 workspace/didChangeConfiguration 通知 LSP。
     */
    reloadDependenciesOnly(event?: ReloadEvent): DepsOnlyItem[] {
        const fullReload = event?.fullReload ?? false;
        const parser = new ModulesDependencyParse(this.rootUri, this.sdkPath);
        const byName = this.getModuleModelsByName();

        if (fullReload) {
            logger.info("[LspServerProxy] Project-level oh-package changed, parsing all modules' dependencies");
            const depsOnly = parser.getDependenciesOnly();
            this.markDependencyTypesIncremental(depsOnly);
            const moduleModels = this.mergeDepsOnlyIntoModuleList(depsOnly, byName);
            this.applyModuleModelsUpdate(moduleModels);
            this.sendDidChangeConfiguration({ moduleSet: moduleModels });
            logger.info(`[LspServerProxy] Dependencies only (all) reloaded, count: ${moduleModels.length}`);
            this.lastDepsOnlyForDiff = depsOnly;
            return depsOnly;
        }

        const changedModules = event?.changedModules ?? [];
        const removedSet = new Set(event?.removedModuleNames ?? []);
        if (changedModules.length === 0 && removedSet.size === 0) {
            logger.info('[LspServerProxy] No changed/removed modules, skip dependency reload');
            return [];
        }

        logger.info(`[LspServerProxy] Module-level deps changed, parsing: [${changedModules.join(', ')}]`);
        const depsOnly = parser.getDependenciesOnly(changedModules);
        this.markDependencyTypesIncremental(depsOnly);
        const moduleModels = this.mergeIncrementalDeps(this.currentModuleModels, removedSet, depsOnly);
        this.applyModuleModelsUpdate(moduleModels);
        this.sendDidChangeConfiguration({ moduleSet: moduleModels });
        logger.info(`[LspServerProxy] Dependencies only (incremental) reloaded, count: ${moduleModels.length}`);
        this.lastDepsOnlyForDiff = depsOnly;
        return depsOnly;
    }

    private sendDidChangeConfiguration(settings: unknown): void {
        this.stdHandle.sendDidChangeConfiguration(settings);
    }

    private getModuleModelsByName(): Map<string, ModuleModel> {
        return new Map(this.currentModuleModels.map((m) => [m.moduleName ?? '', m]));
    }

    private markDependencyTypesIncremental(depsOnly: DepsOnlyItem[]): void {
        const byName = this.getModuleModelsByName();
        const lastByName = new Map(this.lastDepsOnlyForDiff.map((d) => [d.moduleName ?? '', d]));

        for (const item of depsOnly) {
            const name = item.moduleName ?? '';
            const { oldDeps, oldDynamic } = this.getOldDepsForModule(name, byName, lastByName);
            const newDeps = item.dependencies ?? {};
            const newDynamic = item.dynamicDependencies ?? {};

            this.markAddAndDeleteInDeps(oldDeps, newDeps, (key, old) => {
                (item.dependencies ??= {})[key] = this.makeDeleteEntry(key, old);
            });
            this.markAddAndDeleteInDeps(oldDynamic, newDynamic, (key, old) => {
                (item.dynamicDependencies ??= {})[key] = this.makeDeleteEntry(key, old);
            });
        }
    }

    private getOldDepsForModule(
        moduleName: string,
        byName: Map<string, ModuleModel>,
        lastByName: Map<string, DepsOnlyItem>,
    ): { oldDeps: Record<string, ModuleDependencyInfo>; oldDynamic: Record<string, ModuleDependencyInfo> } {
        const oldModule = byName.get(moduleName);
        let oldDeps = oldModule?.moduleDependencies?.dependencies ?? {};
        let oldDynamic = oldModule?.moduleDependencies?.dynamicDependencies ?? {};
        if (Object.keys(oldDeps).length === 0 && Object.keys(oldDynamic).length === 0) {
            const last = lastByName.get(moduleName);
            if (last) {
                oldDeps = last.dependencies ?? {};
                oldDynamic = last.dynamicDependencies ?? {};
            }
        }
        return { oldDeps, oldDynamic };
    }

    private markAddAndDeleteInDeps(
        oldMap: Record<string, ModuleDependencyInfo>,
        newMap: Record<string, ModuleDependencyInfo>,
        onDelete: (key: string, old: ModuleDependencyInfo | undefined) => void,
    ): void {
        for (const key of Object.keys(newMap)) {
            if (!(key in oldMap)) {
                newMap[key].type = 'add';
            }
        }
        for (const key of Object.keys(oldMap)) {
            if (!(key in newMap)) {
                onDelete(key, oldMap[key]);
            }
        }
    }

    private makeDeleteEntry(name: string, old: ModuleDependencyInfo | undefined): ModuleDependencyInfo {
        return new ModuleDependencyInfo({
            name,
            version: old?.version ?? '',
            registryType: old?.registryType ?? 'ohpm',
            resolved: old?.resolved ?? '',
            type: 'delete',
        });
    }

    private createMinimalModelFromDepsItem(item: DepsOnlyItem): ModuleModel {
        const model = new ModuleModel(item.modulePath);
        model.moduleName = item.moduleName;
        model.moduleType = item.moduleName;
        model.packageName = item.moduleName;
        model.moduleJsonParam = new ModuleJsonParam([]);
        model.modulePath = item.modulePath;
        model.moduleDependencies = item;
        return model;
    }

    private mergeDepsOnlyIntoModuleList(depsOnly: DepsOnlyItem[], byName: Map<string, ModuleModel>): ModuleModel[] {
        const result: ModuleModel[] = [];
        for (const item of depsOnly) {
            const name = item.moduleName ?? '';
            let model = byName.get(name);
            if (!model) {
                model = this.createMinimalModelFromDepsItem(item);
            } else {
                model.modulePath = item.modulePath;
                model.moduleDependencies = item;
            }
            result.push(model);
        }
        return result;
    }

    private mergeIncrementalDeps(
        current: ModuleModel[],
        removedSet: Set<string>,
        depsOnly: DepsOnlyItem[],
    ): ModuleModel[] {
        const depsMap = new Map(depsOnly.map((d) => [d.moduleName ?? '', d]));
        const result: ModuleModel[] = [];
        for (const m of current) {
            const name = m.moduleName ?? '';
            if (removedSet.has(name)) {
                continue;
            }
            const item = depsMap.get(name);
            if (item) {
                m.modulePath = item.modulePath;
                m.moduleDependencies = item;
                depsMap.delete(name);
            }
            result.push(m);
        }
        for (const [, item] of depsMap) {
            result.push(this.createMinimalModelFromDepsItem(item));
        }
        return result;
    }

    private applyModuleModelsUpdate(moduleModels: ModuleModel[]): void {
        this.fillModuleModelsPaths(moduleModels);
        if (this.currentParams) {
            this.currentParams.initializationOptions.modules = moduleModels;
        }
    }

    private fillModuleModelsPaths(models: ModuleModel[]): void {
        const basePath = this.sdkPath;
        const aceLoaderPath = normalizePath(path.join(basePath, 'default/openharmony/ets/build-tools/ets-loader'));
        const sdkJsPath = normalizePath(path.join(basePath, 'default/openharmony/ets/api'));
        const hosSdkPath = normalizePath(path.join(basePath, 'default/hms'));

        for (const model of models) {
            model.aceLoaderPath = aceLoaderPath;
            model.sdkJsPath = sdkJsPath;
            model.hosSdkPath = hosSdkPath;
        }
    }

    /* ========== 通知分发（兼容上层 sendNotification 调用） ========== */

    sendRequest(msg: LspRequest) {
        switch (msg.method) {
            case LSP_METHOD.HOVER:
                this.stdHandle.sendLspRequest(LSP_METHOD.HOVER, msg.params).then(
                    (result) => this.onLspMessage({ jsonrpc: JSONRPC_VERSION, id: msg.id, result }),
                    (err) => this.onLspMessage({ jsonrpc: JSONRPC_VERSION, id: msg.id, error: { code: -32603, message: err.message } }),
                );
                break;
            case LSP_METHOD.DEFINITION:
                this.stdHandle.sendLspRequest(LSP_METHOD.DEFINITION, msg.params).then(
                    (result) => this.onLspMessage({ jsonrpc: JSONRPC_VERSION, id: msg.id, result }),
                    (err) => this.onLspMessage({ jsonrpc: JSONRPC_VERSION, id: msg.id, error: { code: -32603, message: err.message } }),
                );
                break;
            case LSP_METHOD.REFERENCES:
                this.stdHandle.sendLspRequest(LSP_METHOD.REFERENCES, msg.params).then(
                    (result) => this.onLspMessage({ jsonrpc: JSONRPC_VERSION, id: msg.id, result }),
                    (err) => this.onLspMessage({ jsonrpc: JSONRPC_VERSION, id: msg.id, error: { code: -32603, message: err.message } }),
                );
                break;
            default:
                logger.warn(`Unhandled LSP request: ${msg.method}`);
        }
    }

    sendNotification(msg: LspMessage) {
        if (!isNotificationRequest(msg)) {
            logger.info('LspServerProxy, msg is not notification request, ignore.');
            return;
        }

        switch (msg.method) {
            case LSP_METHOD.DID_OPEN:
                this.handleDidOpenNotification(msg);
                break;
            case LSP_METHOD.DID_CHANGE:
                this.handleDidChangeNotification(msg);
                break;
            case LSP_METHOD.DID_CLOSE:
                this.handleDidCloseNotification(msg);
                break;
            case LSP_METHOD.WORKSPACE_DID_CHANGE_WATCHED_FILES:
                this.handleDidChangeWatchedFiles(msg);
                break;
            case LSP_METHOD.DID_CREATE_FILES:
                this.handleDidCreateFiles(msg);
                break;
            case LSP_METHOD.DID_DELETE_FILES:
                this.handleDidDeleteFiles(msg);
                break;
            default:
                logger.warn(`Unhandled LSP notification: ${msg.method}`);
        }
    }

    private handleDidOpenNotification(msg: LspNotification): void {
        const params = msg.params as DidOpenTextDocumentParams | undefined;
        if (!params || !params.textDocument || typeof params.textDocument.uri !== 'string') {
            logger.error('Invalid textDocument/didOpen params');
            return;
        }
        this.stdHandle.sendDidOpen(params);
    }

    private handleDidChangeNotification(msg: LspNotification): void {
        const params = msg.params as DidChangeTextDocumentParams | undefined;
        if (!params || !params.textDocument || typeof params.textDocument.uri !== 'string') {
            logger.error('Invalid textDocument/didChange params');
            return;
        }
        this.stdHandle.sendDidChange(params);
    }

    private handleDidCloseNotification(msg: LspNotification): void {
        const params = msg.params as DidCloseTextDocumentParams | undefined;
        if (!params || !params.textDocument || typeof params.textDocument.uri !== 'string') {
            logger.error('Invalid textDocument/didClose params');
            return;
        }
        this.stdHandle.closeFile(params);
    }

    private handleDidChangeWatchedFiles(msg: LspNotification): void {
        const params = msg.params as { changes?: Array<{ uri: string; type: number }> } | undefined;
        if (!params || !Array.isArray(params.changes)) {
            return;
        }
        this.messageHandle.onDidChangeWatchedFiles(params.changes);
    }

    private handleDidCreateFiles(msg: LspNotification): void {
        const params = msg.params as { files?: Array<{ uri: string }> } | undefined;
        if (!params || !Array.isArray(params.files)) {
            return;
        }
        this.stdHandle.sendNotification(LSP_METHOD.DID_CREATE_FILES, params);
    }

    private handleDidDeleteFiles(msg: LspNotification): void {
        const params = msg.params as { files?: Array<{ uri: string }> } | undefined;
        if (!params || !Array.isArray(params.files)) {
            return;
        }
        this.stdHandle.sendNotification(LSP_METHOD.DID_DELETE_FILES, params);
    }

    async dispose(): Promise<void> {
        await this.messageHandle.stop();
    }
}
