/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export const ARKTS_PROXY_JSONRPC_ERROR_CODE = {
    /** LSP 尚未初始化成功（如 arkts/initializationFailed 场景） */
    UNINITIALIZED: -32099,
    /** 未知或未附带明细的错误 */
    UNKNOWN: -32000,
} as const;

export type ArkTsProxyJsonRpcErrorCode =
    (typeof ARKTS_PROXY_JSONRPC_ERROR_CODE)[keyof typeof ARKTS_PROXY_JSONRPC_ERROR_CODE];

export class ArkTsProxyError extends Error {
    readonly code: ArkTsProxyJsonRpcErrorCode;

    constructor(message: string, code: ArkTsProxyJsonRpcErrorCode) {
        super(message);
        this.name = 'ArkTsProxyError';
        this.code = code;
    }

    static uninitialized(message: string): ArkTsProxyError {
        return new ArkTsProxyError(message, ARKTS_PROXY_JSONRPC_ERROR_CODE.UNINITIALIZED);
    }

    static unknown(message: string = 'Unknown error'): ArkTsProxyError {
        return new ArkTsProxyError(message, ARKTS_PROXY_JSONRPC_ERROR_CODE.UNKNOWN);
    }

    toJsonRpcErrorParams(): { code: number; message: string } {
        return { code: this.code, message: this.message };
    }
}
