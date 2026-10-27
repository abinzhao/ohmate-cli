/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { LspDiagnostic } from './LspProtocols.js';

/**
 * 单个文件的诊断聚合器。
 *
 * 标准 LSP 下 `textDocument/publishDiagnostics` 直接以对象数组推送，
 * 不再需要 ace-server 的 receivedTypes/version 聚合机制；
 * 这里仅保留去重 + 累积，在收到一次完整推送后即 resolve。
 */
export class Diagnostic {
    public readonly uri: string;
    private diagnostics: LspDiagnostic[] = [];

    constructor(uri: string) {
        this.uri = uri;
    }

    set(diagnostics: LspDiagnostic[]): void {
        this.diagnostics = diagnostics;
    }

    get(): LspDiagnostic[] {
        return this.diagnostics;
    }

    clear(): void {
        this.diagnostics = [];
    }
}
