/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 标准 LSP 方法名（wire protocol，发往 / 收自 ace-server 子进程）。
 * 全部使用 LSP 3.17 规范定义的 method 字符串，不再保留 ace-server 私有协议。
 */
export const LSP_METHOD = {
    // ---- 生命周期 (C→S) ----
    INITIALIZE: 'initialize',
    INITIALIZED: 'initialized',
    SHUTDOWN: 'shutdown',
    EXIT: 'exit',

    // ---- 文档同步 (C→S notifications) ----
    DID_OPEN: 'textDocument/didOpen',
    DID_CHANGE: 'textDocument/didChange',
    DID_CLOSE: 'textDocument/didClose',

    // ---- 诊断 (S→C notification) ----
    PUBLISH_DIAGNOSTICS: 'textDocument/publishDiagnostics',

    // ---- 语言特性请求 (C→S requests) ----
    HOVER: 'textDocument/hover',
    DEFINITION: 'textDocument/definition',
    DECLARATION: 'textDocument/declaration',
    REFERENCES: 'textDocument/references',
    IMPLEMENTATION: 'textDocument/implementation',
    COMPLETION: 'textDocument/completion',
    COMPLETION_ITEM_RESOLVE: 'completionItem/resolve',
    SIGNATURE_HELP: 'textDocument/signatureHelp',
    CODE_ACTION: 'textDocument/codeAction',
    PREPARE_RENAME: 'textDocument/prepareRename',
    RENAME: 'textDocument/rename',
    DOCUMENT_HIGHLIGHT: 'textDocument/documentHighlight',
    DOCUMENT_LINK: 'textDocument/documentLink',
    INLAY_HINT: 'textDocument/inlayHint',
    DOCUMENT_SYMBOL: 'textDocument/documentSymbol',
    WORKSPACE_SYMBOL: 'workspace/symbol',
    DIAGNOSTIC: 'textDocument/diagnostic',
    WORKSPACE_DIAGNOSTIC: 'workspace/diagnostic',
    PREPARE_CALL_HIERARCHY: 'textDocument/prepareCallHierarchy',
    INCOMING_CALLS: 'callHierarchy/incomingCalls',
    OUTGOING_CALLS: 'callHierarchy/outgoingCalls',
    PREPARE_TYPE_HIERARCHY: 'textDocument/prepareTypeHierarchy',
    SUPERTYPES: 'typeHierarchy/supertypes',
    SUBTYPES: 'typeHierarchy/subtypes',

    // ---- Workspace (C→S notifications) ----
    WORKSPACE_DID_CHANGE_CONFIGURATION: 'workspace/didChangeConfiguration',
    WORKSPACE_DID_CHANGE_WATCHED_FILES: 'workspace/didChangeWatchedFiles',
    DID_CREATE_FILES: 'workspace/didCreateFiles',
    DID_DELETE_FILES: 'workspace/didDeleteFiles',

    // ---- 进度 / 消息 (S→C notifications) ----
    PROGRESS: '$/progress',
    WINDOW_SHOW_MESSAGE: 'window/showMessage',
    WINDOW_LOG_MESSAGE: 'window/logMessage',

    // ============================================================
    // 以下为内部状态通知（不参与 wire protocol，仅用于
    // ArktsLspManager → ArktsCheckTool 之间的进程内通信）
    // ============================================================
    ARKTS_INITIALIZED: 'arkts/initialized',
    ARKTS_INITIALIZATION_FAILED: 'arkts/initializationFailed',
    ARKTS_INDEXING_PROGRESS: 'arkts/indexingProgress',
    ARKTS_SYNC_PROJECT: 'arkts/syncProject',
    ARKTS_SYNC_COMPLETED: 'arkts/syncCompleted',
    ARKTS_REINITIALIZING: 'arkts/reinitializing',
    ARKTS_ERROR: 'arkts/error',

    // ============================================================
    // C++ 路径内部状态信号（与 ARKTS_* 平行，独立命名空间避免歧义）
    // 仅用于 ClangdLspManager → CppCheckTool 之间的进程内通信，
    // 不参与 wire protocol。
    // ============================================================
    CPP_INITIALIZED: 'cpp/initialized',
    CPP_INITIALIZATION_FAILED: 'cpp/initializationFailed',
    CPP_INDEXING_PROGRESS: 'cpp/indexingProgress',
    CPP_SYNC_PROJECT: 'cpp/syncProject',
    CPP_SYNC_COMPLETED: 'cpp/syncCompleted',
    CPP_REINITIALIZING: 'cpp/reinitializing',
    CPP_ERROR: 'cpp/error',
    /** 广播给上层时的回调 key */
    BROADCAST: 'lsp/broadcast',
} as const;

export const JSONRPC_VERSION = '2.0';

/**
 * ace-server 私有 S→C 通知名。标准协议与 legacy 协议共用同一 wire 字符串，
 * 此处为唯一定义点（legacy-constant.ts 亦引用之，不再各自硬编码）。
 */
export const ACE_SERVER_METHOD = {
    MODULE_INIT_FINISH: 'aceProject/onModuleInitFinish',
    INDEXING_PROGRESS_UPDATE: 'aceProject/onIndexingProgressUpdate',
} as const;

/** 日志标签（仅用于 logger 输出，非协议字段） */
export const LSP_SEND_LABEL = {
    INITIALIZE: 'initialize',
    INITIALIZED: 'initialized',
    SHUTDOWN: 'shutdown',
    EXIT: 'exit',
    DID_OPEN: 'didOpen',
    DID_CHANGE: 'didChange',
    DID_CLOSE: 'didClose',
    HOVER: 'hover',
    DEFINITION: 'definition',
    REFERENCES: 'references',
    COMPLETION: 'completion',
    DOCUMENT_SYMBOL: 'documentSymbol',
    DIAGNOSTIC: 'diagnostic',
    WORKSPACE_DID_CHANGE_CONFIGURATION: 'workspace/didChangeConfiguration',
    WORKSPACE_DID_CHANGE_WATCHED_FILES: 'workspace/didChangeWatchedFiles',
} as const;

export enum DependencyMapParseStatus {
    OK = 'OK',
    ERROR = 'ERROR',
}

export interface DependencyMapParseResult {
    status: DependencyMapParseStatus;
    message?: string;
}

/** serverMaxSize 默认基准：8 GB */
export const SERVER_MAX_SIZE_BASE_MB = 8192;
/** 模块数阈值：<= 该值使用基准，> 该值按每个模块追加内存 */
export const SERVER_MAX_SIZE_MODULE_THRESHOLD = 100;
/** 超过阈值后，每个模块追加 0.03 GB */
export const SERVER_MAX_SIZE_PER_EXTRA_MODULE_GB = 0.03;
/** 计算结果上限：机器物理内存的70% */
export const SERVER_MAX_SIZE_PHYSICAL_CAP_RATIO = 0.7;

/** LSP 初始化等待超时：进度重置与初始化总等待统一为 15分钟 */
export const LSP_INIT_TIMEOUT_MS = 15 * 60 * 1000;
