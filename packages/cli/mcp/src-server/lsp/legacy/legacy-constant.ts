/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 老版本 ace-server 私有协议常量。
 *
 * 适用条件：`${studio}/plugins/openharmony/ace-server/out/standardIndex/index.js` 不存在
 * （DevEco Studio < 26.0.0.610）。此场景下 ace-server 仅识别 `aceProject/*` 私有方法，
 * 不支持标准 LSP 3.17 的 `initialize` request/response、`textDocument/diagnostic` 拉取等。
 *
 * 仅供 LegacyClientMessageHandle / LegacyLspServerProxy 等 legacy 路径使用。
 * 共享常量（JSONRPC_VERSION / ACE_SERVER_METHOD / LSP_INIT_TIMEOUT_MS / SERVER_MAX_SIZE_* /
 * DependencyMapParseStatus）仍从 ../constant.js 引用，不在此重复。
 */

import { ACE_SERVER_METHOD } from '../constant.js';

/** C→S：客户端发往 ace-server 的方法。 */
export const LEGACY_LSP_TO_SERVER = {
    EXIT: 'exit',
    INITIALIZED: 'initialized',
    ON_DID_CHANGE_PACKAGE_DEPENDENCIES: 'aceProject/onDidChangePackageDependencies',
    ON_ASYNC_DID_OPEN: 'aceProject/onAsyncDidOpen',
    ON_ASYNC_DID_CHANGE: 'aceProject/onAsyncDidChange',
    DID_CLOSE: 'textDocument/didClose',
    ON_ASYNC_HOVER: 'aceProject/onAsyncHover',
    ON_ASYNC_DEFINITION: 'aceProject/onAsyncDefinition',
    ON_ASYNC_FIND_USAGES: 'aceProject/onAsyncFindUsages',
} as const;

/** S→C / 内部：ace-server 推送给客户端的方法 + 复用的标准 method 名 + 内部状态通知。 */
export const LEGACY_LSP_CLIENT = {
    // ace-server 私有（S→C）
    MODULE_INIT_FINISH: ACE_SERVER_METHOD.MODULE_INIT_FINISH,
    INDEXING_PROGRESS_UPDATE: 'aceProject/onIndexingProgressUpdate',
    ON_FORCE_OPEN_FILE: 'aceProject/onForceOpenFile',
    ON_PACKAGE_CHANGE_FINISH: 'aceProject/onPackageChangeFinish',
    TEXT_DOCUMENT_ON_ASYNC_DEFINITION: 'textDocument/onAsyncDefinition',
    ON_DID_CHANGE_PACKAGE_DEPENDENCIES_CLIENT: 'textDocument/onDidChangePackageDependencies',
    // 复用的标准 method 名（key 与新版一致，但用法不同：老版靠 onAsync 推送 + requestId 匹配）
    PUBLISH_DIAGNOSTICS: 'textDocument/publishDiagnostics',
    HOVER: 'textDocument/hover',
    DEFINITION: 'textDocument/definition',
    REFERENCES: 'textDocument/references',
    DID_OPEN: 'textDocument/didOpen',
    DID_CHANGE: 'textDocument/didChange',
    WORKSPACE_DID_CHANGE_CONFIGURATION: 'workspace/didChangeConfiguration',
    WORKSPACE_DID_CHANGE_WATCHED_FILES: 'workspace/didChangeWatchedFiles',
    // 内部状态通知（与新版一致）
    BROADCAST: 'lsp/broadcast',
    ARKTS_ERROR: 'arkts/error',
    ARKTS_INITIALIZED: 'arkts/initialized',
    ARKTS_INITIALIZATION_FAILED: 'arkts/initializationFailed',
    ARKTS_INDEXING_PROGRESS: 'arkts/indexingProgress',
    ARKTS_SYNC_PROJECT: 'arkts/syncProject',
    ARKTS_SYNC_COMPLETED: 'arkts/syncCompleted',
    ARKTS_REINITIALIZING: 'arkts/reinitializing',
} as const;

/** 合并视图（与 CallbackRegistry 的 key 保持一致）。 */
export const LEGACY_LSP_METHOD = {
    ...LEGACY_LSP_TO_SERVER,
    ...LEGACY_LSP_CLIENT,
} as const;

/** 日志标签（仅用于 logger 输出，非协议字段）。 */
export const LEGACY_LSP_SEND_LABEL = {
    EXIT: 'exit',
    INITIALIZED: 'initialized',
    EMPTY: 'empty',
    ON_DID_CHANGE_PACKAGE_DEPENDENCIES: 'onDidChangePackageDependencies',
    ON_ASYNC_DID_OPEN: 'onAsyncDidOpen',
    ON_ASYNC_DID_CHANGE: 'onAsyncDidChange',
    DID_CLOSE: 'didClose',
    ON_ASYNC_HOVER: 'onAsyncHover',
    ON_ASYNC_DEFINITION: 'onAsyncDefinition',
    ON_ASYNC_FIND_USAGES: 'onAsyncFindUsages',
} as const;

/**
 * 老版本诊断聚合：ace-server 按 receivedType（1000/2000/3000/3001）分多次推送
 * publishDiagnostics，需全部收齐才视为完成。新版标准化协议已无此机制。
 */
export const LEGACY_EXPECTED_DIAGNOSTIC_TYPES = new Set<number>([1000, 2000, 3000, 3001]);
