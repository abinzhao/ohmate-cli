/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface LspRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: unknown;
}

export interface LspNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

export interface LspResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export type LspMessage = LspRequest | LspResponse | LspNotification;

/** 心跳请求方法名：服务端定期发送，客户端需返回空内容表示存活 */
export const HEARTBEAT_METHOD = 'arkts/heartbeat';

export interface LspClient {
    id: string;
    send(msg: LspMessage): void;
}

export interface OpenFileParam {
    isFromEditor: boolean;
    editorFiles: string[];
    textDocument: TextDocument;
}

export interface EtsFileItem {
    uri: string; // 标准 file:// URI
    selected: boolean; // 是否为当前激活的编辑器文件
}

export interface TextDocument {
    uri: string;
    text: string;
    languageId: string;
    version: number;
}

export function isNotificationRequest(msg: LspMessage): msg is LspNotification {
    return 'method' in msg && !('id' in msg);
}
