/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { Range } from '../core/LspProtocols.js';

/**
 * 老版本 ace-server onAsyncDidChange 参数（非标准 LSP DidChangeTextDocumentParams）。
 * 新版标准化协议已改用标准 DidChangeTextDocumentParams，此类型仅 legacy 路径使用。
 */
export interface LegacyContentChange {
    range: Range;
    text: string;
}

export interface DidChangeParam {
    contentChanges: LegacyContentChange[];
    uri: string;
    version: number;
}
