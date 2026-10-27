/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { logger } from '../logger.js';

/** 异步请求完成时的回调：(method, payload) => void */
export type RequestCallback = (method: string, payload: unknown) => void;

/** Promise 式回调：resolve(result) / reject(error) */
export interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    method: string;
    timer?: NodeJS.Timeout;
}

export type RequestCallbackKey = string | number;

/**
 * 通用请求回调与超时管理：
 *  - 按 key（uri 或 request id）注册 Promise 式回调；
 *  - 支持旧式 (method, payload) 回调（兼容诊断等按 uri 匹配的场景）；
 *  - 超时自动 reject / onTimeout。
 */
export class RequestCallbackManager {
    private readonly callbacks = new Map<RequestCallbackKey, RequestCallback>();
    private readonly pending = new Map<RequestCallbackKey, PendingRequest>();
    private readonly timeouts = new Map<RequestCallbackKey, NodeJS.Timeout>();

    /* ---------- Promise 式（按 request id 匹配响应） ---------- */

    registerPending(key: RequestCallbackKey, method: string, timeoutMs: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this.pending.delete(key);
                    this.timeouts.delete(key);
                    reject(new Error(`LSP request '${method}' (id=${key}) timeout after ${timeoutMs}ms`));
                }, timeoutMs);
                this.timeouts.set(key, timer);
            }
            this.pending.set(key, { resolve, reject, method, timer });
        });
    }

    resolvePending(key: RequestCallbackKey, result: unknown): boolean {
        this.clearTimeout(key);
        const entry = this.pending.get(key);
        if (!entry) {
            return false;
        }
        entry.resolve(result);
        this.pending.delete(key);
        return true;
    }

    rejectPending(key: RequestCallbackKey, err: Error): boolean {
        this.clearTimeout(key);
        const entry = this.pending.get(key);
        if (!entry) {
            return false;
        }
        entry.reject(err);
        this.pending.delete(key);
        return true;
    }

    /* ---------- 旧式回调（按 uri 匹配诊断等） ---------- */

    register(key: RequestCallbackKey, callback: RequestCallback): void {
        this.callbacks.set(key, callback);
    }

    emit(key: RequestCallbackKey, method: string, payload: unknown): void {
        logger.debug(`[RequestCallbackManager] emit, method: ${method}, key: ${key}`);
        this.clearTimeout(key);
        const cb = this.callbacks.get(key);
        if (cb) {
            try {
                cb(method, payload);
            } finally {
                this.callbacks.delete(key);
            }
        } else {
            const registered = [...this.callbacks.keys()].map((k) => String(k));
            logger.debug(
                `[RequestCallbackManager] emit: NO callback for key='${key}', registered keys=[${registered.join(',')}]`,
            );
        }
    }

    registerTimeout(key: RequestCallbackKey, method: string, timeoutMs: number, onTimeout: () => void): void {
        const existing = this.timeouts.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timeout = setTimeout(() => {
            logger.debug(`[RequestCallbackManager] timeout, key=${key}, method=${method}`);
            try {
                onTimeout();
            } finally {
                this.timeouts.delete(key);
            }
        }, timeoutMs);
        this.timeouts.set(key, timeout);
    }

    clearTimeout(key: RequestCallbackKey): void {
        const timer = this.timeouts.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timeouts.delete(key);
        }
    }

    deleteCallback(key: RequestCallbackKey): void {
        this.callbacks.delete(key);
    }

    hasCallback(key: RequestCallbackKey): boolean {
        return this.callbacks.has(key) || this.pending.has(key);
    }

    /** 清除该 key 的全部状态（回调 / pending / 超时）。 */
    clear(key: RequestCallbackKey): void {
        this.clearTimeout(key);
        const pending = this.pending.get(key);
        if (pending) {
            pending.reject(new Error(`Request '${pending.method}' (id=${key}) cancelled`));
            this.pending.delete(key);
        }
        this.callbacks.delete(key);
    }

    rejectAll(err: Error): void {
        for (const [, entry] of this.pending) {
            entry.reject(err);
        }
        this.pending.clear();
        for (const [, timer] of this.timeouts) {
            clearTimeout(timer);
        }
        this.timeouts.clear();
        this.callbacks.clear();
    }
}
