/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as util from 'util';
import { mcpLog, getMcpLogDir } from '../utils/mcp-logger.js';

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

let currentLogPath: string = '';

/**
 * 兼容旧调用：仅记录调用方传入的 logPath（用于 ace-server 的 --logger-path / --report-dir）。
 * 真实的日志写入与轮转交给外层 `mcp-logger` 完成，避免开两套日志文件。
 */
export function initializeLogger(logDest: string): void {
    if (!logDest || logDest === 'auto' || logDest === 'stdout' || logDest === 'none') {
        currentLogPath = '';
        return;
    }
    currentLogPath = logDest;
}

export function getLogPath(): string {
    return currentLogPath || (getMcpLogDir() ?? '');
}

function format(message: string, ...args: unknown[]): string {
    if (args.length === 0) {
        return message;
    }
    try {
        return util.format(message, ...args);
    } catch {
        return [message, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))].join(' ');
    }
}

export const logger: Logger = {
    info(message: string, ...args: unknown[]): void {
        mcpLog.info(`[lsp] ${format(message, ...args)}`);
    },
    warn(message: string, ...args: unknown[]): void {
        mcpLog.warn(`[lsp] ${format(message, ...args)}`);
    },
    error(message: string, ...args: unknown[]): void {
        mcpLog.error(`[lsp] ${format(message, ...args)}`);
    },
    debug(message: string, ...args: unknown[]): void {
        mcpLog.debug(`[lsp] ${format(message, ...args)}`);
    },
};

export function disposeLogger(): void {
    // mcp-logger 由外层统一关闭，这里 no-op。
}

export function flushLogger(): void {
    // mcp-logger 内部 fsync 在 process exit 前由外层调用 flushMcpLogger 完成，这里 no-op。
}
