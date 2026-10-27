/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { logger } from '../logger.js';

/**
 * 老版本诊断聚合器（ace-server 私有协议）。
 *
 * ace-server 按 receivedType（PublishDiagnosticsParams.version，取值 1000/2000/3000/3001）
 * 分多次推送 publishDiagnostics，需收齐全部 expected type 才视为一次完整诊断完成。
 * 新版标准化协议一次推送即完成，已无此机制。
 */
export class LegacyDiagnostic {
    public uri: string;
    public messages: Message[] = [];
    private receivedTypes: Set<number> = new Set<number>();
    private readonly uniqueMessages: Set<string> = new Set<string>();
    public isFromEditor: boolean = false;

    constructor(uri: string) {
        this.uri = uri;
    }

    public setReceivedType(type: number): void {
        this.receivedTypes.add(type);
    }

    public addMessage(version: number, diagnostics: string): void {
        this.receivedTypes.add(version);
        const messageKey = `${version}:${diagnostics}`;
        if (this.uniqueMessages.has(messageKey)) {
            logger.info(`[LegacyDiagnostic] addMessage: duplicate message=${messageKey}`);
            return;
        }
        this.uniqueMessages.add(messageKey);
        this.messages.push(new Message(version, diagnostics));
    }

    public clearMessages(): void {
        this.messages = [];
    }

    public clear(): void {
        this.receivedTypes.clear();
        this.uniqueMessages.clear();
        this.messages = [];
    }

    public hasReceivedAllTypes(expectedTypes: Set<number>): boolean {
        for (const type of expectedTypes) {
            if (!this.receivedTypes.has(type)) {
                return false;
            }
        }
        return true;
    }

    public getMessages(): string[] {
        return this.messages.map((message) => message.diagnostics);
    }
}

class Message {
    public version: number = -1;
    public diagnostics: string;

    constructor(version: number, diagnostics: string) {
        this.version = version;
        this.diagnostics = diagnostics;
    }
}
