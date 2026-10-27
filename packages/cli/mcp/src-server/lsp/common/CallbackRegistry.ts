/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export class CallbackRegistry<K = string, T extends (...args: never[]) => void = () => void> {
    private readonly map = new Map<K, Set<T>>();

    /**
     * 为指定 key 注册一个回调（同一 key 可注册多个）。
     */
    register(key: K, callback: T): void {
        let set = this.map.get(key);
        if (!set) {
            set = new Set();
            this.map.set(key, set);
        }
        set.add(callback);
    }

    /**
     * 移除回调。若未传入 callback，则移除该 key 下全部回调。
     */
    unregister(key: K, callback?: T): void {
        const set = this.map.get(key);
        if (!set) {
            return;
        }
        if (callback !== undefined) {
            set.delete(callback);
        } else {
            set.clear();
        }
        if (set.size === 0) {
            this.map.delete(key);
        }
    }

    /**
     * 触发该 key 下所有已注册回调，并传入参数（无参时 invoke(key) 即可）。
     * 单个回调抛错不会影响其余回调。
     */
    invoke(key: K, ...args: Parameters<T>): void {
        const set = this.map.get(key);
        if (!set) {
            return;
        }
        for (const cb of set) {
            try {
                cb(...args);
            } catch (e) {
                console.error(`[CallbackRegistry] invoke("${String(key)}") callback error:`, e);
            }
        }
    }

    /**
     * 触发该 key 下所有回调，并移除该 key 下的全部注册（一次性触发）。
     */
    invokeOnce(key: K, ...args: Parameters<T>): void {
        this.invoke(key, ...args);
        this.unregister(key);
    }

    /**
     * 清空所有 key 的注册。
     */
    clear(): void {
        this.map.clear();
    }

    /**
     * 是否存在该 key 的注册。
     */
    has(key: K): boolean {
        const set = this.map.get(key);
        return set !== undefined && set.size > 0;
    }
}
