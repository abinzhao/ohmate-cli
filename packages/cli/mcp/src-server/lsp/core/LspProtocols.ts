/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/* ============================ 基础类型 ============================ */

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Location {
    uri: string;
    range: Range;
}

export interface LocationLink {
    originSelectionRange?: Range;
    targetUri: string;
    targetRange: Range;
    targetSelectionRange: Range;
}

/* ============================ 文档同步 ============================ */

export interface TextDocumentIdentifier {
    uri: string;
}

export interface VersionedTextDocumentIdentifier {
    uri: string;
    version: number;
}

export interface DidOpenTextDocumentParams {
    textDocument: {
        uri: string;
        languageId: string;
        version: number;
        text: string;
    };
}

export interface TextDocumentContentChangeEvent {
    range?: Range;
    rangeLength?: number;
    text: string;
}

export interface DidChangeTextDocumentParams {
    textDocument: VersionedTextDocumentIdentifier;
    contentChanges: TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
    textDocument: TextDocumentIdentifier;
}

/* ============================ 诊断 ============================ */

export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export const DiagnosticSeverity = {
    Error: 1,
    Warning: 2,
    Information: 3,
    Hint: 4,
} as const;

export type DiagnosticTag = 1 | 2;

export interface LspDiagnostic {
    range: Range;
    severity?: DiagnosticSeverity;
    code?: number | string;
    source?: string;
    message: string;
    tags?: DiagnosticTag[];
    relatedInformation?: Array<{
        location: Location;
        message: string;
    }>;
}

export interface PublishDiagnosticsParams {
    uri: string;
    version?: number;
    diagnostics: LspDiagnostic[];
}

/* ============================ 拉取式诊断请求 ============================ */

export interface DocumentDiagnosticParams {
    textDocument: TextDocumentIdentifier;
    identifier?: string;
}

export interface FullDocumentDiagnosticReport {
    kind: 'full';
    items: LspDiagnostic[];
}

export interface UnchangedDocumentDiagnosticReport {
    kind: 'unchanged';
    unchangedDocumentUri: string;
}

export type DocumentDiagnosticReport =
    | FullDocumentDiagnosticReport
    | UnchangedDocumentDiagnosticReport;

/* ============================ 语言特性请求参数 ============================ */

export interface TextDocumentPositionParams {
    textDocument: TextDocumentIdentifier;
    position: Position;
}

export interface HoverParams extends TextDocumentPositionParams {
    workDoneToken?: number | string;
}

export interface DefinitionParams extends TextDocumentPositionParams {
    workDoneToken?: number | string;
}

export interface ReferenceParams extends TextDocumentPositionParams {
    context: {
        includeDeclaration: boolean;
    };
    workDoneToken?: number | string;
}

export interface CompletionParams extends TextDocumentPositionParams {
    context?: {
        triggerKind: number;
        triggerCharacter?: string;
    };
    workDoneToken?: number | string;
}

export interface DocumentSymbolParams {
    textDocument: TextDocumentIdentifier;
    workDoneToken?: number | string;
}

export interface WorkspaceSymbolParams {
    query: string;
    workDoneToken?: number | string;
}

/* ============================ 语言特性响应结果 ============================ */

export interface Hover {
    contents: MarkupContent | MarkedString | MarkedString[];
    range?: Range;
}

export interface MarkupContent {
    kind: 'plaintext' | 'markdown';
    value: string;
}

export type MarkedString = string | { language: string; value: string };

export type Definition = Location | Location[] | LocationLink[] | null;

export type DocumentSymbolResult = DocumentSymbol[] | SymbolInformation[] | null;

export interface DocumentSymbol {
    name: string;
    detail?: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
}

export interface SymbolInformation {
    name: string;
    kind: number;
    location: Location;
    containerName?: string;
}

/* ============================ JSON-RPC 消息 ============================ */

export interface LspResponse {
    jsonrpc: string;
    id?: number | string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export interface LspNotification {
    jsonrpc: string;
    method: string;
    params?: unknown;
}

export interface LspRequest {
    jsonrpc: string;
    id: number | string;
    method: string;
    params?: unknown;
}

/* ============================ 进度通知 ============================ */

export interface ProgressParams<T> {
    token: number | string;
    value: T;
}

export interface WorkDoneProgressBegin {
    kind: 'begin';
    title: string;
    message?: string;
    percentage?: number;
}

export interface WorkDoneProgressReport {
    kind: 'report';
    message?: string;
    percentage?: number;
}

export interface WorkDoneProgressEnd {
    kind: 'end';
    message?: string;
}

export type WorkDoneProgress = WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd;
