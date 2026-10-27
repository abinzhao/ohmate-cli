/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { TextDocumentContentChangeEvent } from './core/LspProtocols.js';
import { isRecord, isStringArray } from './common/typeGuards.js';

export function isPosition(value: unknown): value is { line: number; character: number } {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.line === 'number' && typeof value.character === 'number';
}

export function isTextDocument(
    value: unknown,
): value is { uri: string; text: string; languageId: string; version: number } {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.uri === 'string' &&
        typeof value.text === 'string' &&
        typeof value.languageId === 'string' &&
        typeof value.version === 'number'
    );
}

export { isStringArray };

export function isContentChange(value: unknown): value is TextDocumentContentChangeEvent {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.text !== 'string') {
        return false;
    }
    const range = value.range;
    if (!isRecord(range)) {
        return false;
    }
    return isPosition(range.start) && isPosition(range.end);
}
