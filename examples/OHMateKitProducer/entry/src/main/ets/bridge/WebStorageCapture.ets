/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CryptoPort, requireWire, match } from './Wire';
import { ControlledStorageKey, ControlledStorageValue, projectStorage } from './ControlledStorage';
import { StorageWriteSession, StorageWriteReview, StorageWriteInput } from './StorageWriteSession';

export interface StorageSnapshot {
  targetId: string; cookieEntryCount: number; cookieSource: string; summary: string;
  attributes: string; localStorage: string; sessionStorage: string;
  indexedDB: string; cacheStorage: string; quota: string; localEntryCount: number; sessionEntryCount: number;
}
export interface StorageStatus { phase: string; reason: string; nativePending: boolean; expiresAt: number; }
export class StorageWaitTimeout extends Error {
  constructor() { super('WEB_STORAGE_TIMEOUT'); }
}
export class WebStorageCapture {
  private crypto: CryptoPort;
  private activeSource: () => boolean;
  private busySource: () => boolean;
  private cancelWait: () => void;
  private value: StorageSnapshot | undefined = undefined;
  private phase: string = 'idle';
  private reason: string = '';
  private revision: number = 0;
  private attempts: number = 0;
  private lastAttempt: number = -1;
  private lastTime: number = Date.now();
  private clockInvalid: boolean = false;
  private expiresAt: number = 0;
  private controlled: boolean = false;
  private controlledValues: ControlledStorageValue[] = [];
  private cancelWrite: () => void;

  constructor(crypto: CryptoPort, active: () => boolean, busy: () => boolean, cancel: () => void,
    cancelWrite: () => void = (): void => {}) {
    this.crypto = crypto; this.activeSource = active; this.busySource = busy; this.cancelWait = cancel;
    this.cancelWrite = cancelWrite;
  }
  async read(deadline: number, executor: (active: () => boolean,
    project: (text: string) => StorageSnapshot) => Promise<StorageSnapshot>): Promise<boolean> {
    return this.capture(deadline, executor, (text: string): StorageSnapshot => this.project(text), false);
  }
  async readControlled(deadline: number, url: string, keys: ControlledStorageKey[],
    executor: (active: () => boolean, project: (text: string) => StorageSnapshot) => Promise<StorageSnapshot>): Promise<boolean> {
    return this.capture(deadline, executor, (text: string): StorageSnapshot => {
      const values = projectStorage(this.crypto, text, url, keys);
      this.controlledValues = values;
      return { targetId: 'web-main', cookieEntryCount: 0, cookieSource: 'not-captured',
        summary: '[MEMORY_ONLY]', attributes: 'not-captured',
        localStorage: keys.some((key: ControlledStorageKey) => key.area === 'local') ? 'allowlist-only' : 'disabled',
        sessionStorage: keys.some((key: ControlledStorageKey) => key.area === 'session') ? 'allowlist-only' : 'disabled',
        indexedDB: 'not-supported', cacheStorage: 'not-supported', quota: 'unavailable',
        localEntryCount: values.filter((value: ControlledStorageValue) => value.area === 'local' && value.value !== null).length,
        sessionEntryCount: values.filter((value: ControlledStorageValue) => value.area === 'session' && value.value !== null).length };
    }, true);
  }
  usesControlled(): boolean { return this.controlled; }
  reviewWrite(owner: StorageWriteSession, area: string, key: string, value: string | null,
    url: string, binding: string, deadline: number, ttlMs: number): StorageWriteReview {
    requireWire(this.controlled && this.phase === 'completed' && this.current(), 'STORAGE_WRITE_UNAVAILABLE');
    const original = this.controlledValues.find((item: ControlledStorageValue): boolean => item.area === area && item.key === key);
    requireWire(original !== undefined, 'STORAGE_WRITE_KEY_UNAVAILABLE');
    if (original === undefined) { throw new Error('STORAGE_WRITE_KEY_UNAVAILABLE'); }
    const input: StorageWriteInput = { url: url, area: area, key: key, original: original.value, value: value,
      binding: binding, captureId: this.attempts, captureDeadline: this.expiresAt, deadline: deadline, ttlMs: ttlMs };
    const review = owner.review(input);
    requireWire(this.current(), 'STORAGE_WRITE_UNAVAILABLE');
    return review;
  }
  private async capture(deadline: number, executor: (active: () => boolean,
    project: (text: string) => StorageSnapshot) => Promise<StorageSnapshot>,
    project: (text: string) => StorageSnapshot, controlled: boolean): Promise<boolean> {
    if (this.busySource()) { return false; }
    if (!this.timeValid()) { this.cancel(); return false; }
    const now = Date.now();
    if (this.attempts >= 256 || (this.lastAttempt >= 0 && now - this.lastAttempt < 1000) ||
      !Number.isSafeInteger(deadline) || now >= deadline) { return false; }
    this.cancel();
    this.controlled = controlled;
    if (!this.available()) { this.cancel(); return false; }
    this.attempts++; this.lastAttempt = now;
    this.expiresAt = Math.min(deadline, now + 30000);
    const revision = this.revision;
    this.phase = 'reading';
    try {
      return executor((): boolean => this.current() && revision === this.revision,
        project).then((result: StorageSnapshot): boolean => {
        if (!this.current() || revision !== this.revision) { return false; }
        this.value = result; this.phase = 'completed';
        return true;
      }).catch((error: Error): boolean => this.failed(error, revision));
    } catch (error) {
      return this.failed(error as Error, revision);
    }
  }
  private failed(error: Error, revision: number): boolean {
    if (revision === this.revision && this.current()) {
      this.phase = error instanceof StorageWaitTimeout ? 'timeout' : 'failed';
      this.reason = this.phase === 'timeout' ? 'STORAGE_WAIT_TIMEOUT' : 'STORAGE_CAPTURE_FAILED';
    }
    return false;
  }
  private project(text: string): StorageSnapshot {
    requireWire(typeof text === 'string' && text.length <= 4096, 'STORAGE_RESULT_INVALID');
    const bytes = this.crypto.encode(text);
    try {
      requireWire(bytes.length <= 4096 && this.crypto.decode(bytes) === text, 'STORAGE_RESULT_INVALID');
    } finally { bytes.fill(0); }
    const pairs: string[] = text === '' ? [] : text.split(';');
    requireWire(pairs.length <= 64, 'STORAGE_RESULT_INVALID');
    for (const pair of pairs) {
      const item = pair.trim();
      const separator = item.indexOf('=');
      requireWire(separator > 0 && match(item.slice(0, separator), '^[!#$%&*+.^_`|~0-9A-Za-z-]+$') &&
        !match(item, '[\\x00-\\x1f\\x7f]'), 'STORAGE_RESULT_INVALID');
    }
    // The API returns URL-related name/value pairs, without Cookie attributes.
    return { targetId: 'web-main', cookieEntryCount: pairs.length,
      cookieSource: 'url-related-incognito-unpartitioned', summary: '[MEMORY_ONLY]',
      attributes: 'not-captured', localStorage: 'disabled', sessionStorage: 'disabled',
      indexedDB: 'not-supported', cacheStorage: 'not-supported', quota: 'unavailable',
      localEntryCount: 0, sessionEntryCount: 0 };
  }
  cancel(invalidateWrite: boolean = true): void {
    if (invalidateWrite) { this.cancelWrite(); }
    this.revision++; this.value = undefined; this.phase = 'idle'; this.reason = ''; this.expiresAt = 0;
    for (const entry of this.controlledValues) { entry.value = null; }
    this.controlledValues = []; this.controlled = false;
    this.cancelWait();
  }
  captureId(): number { return this.attempts; }
  snapshot(): StorageSnapshot | undefined {
    if (this.phase === 'idle' || !this.current() || this.value === undefined) { return undefined; }
    const value = this.value;
    return { targetId: value.targetId, cookieEntryCount: value.cookieEntryCount,
      cookieSource: value.cookieSource, summary: value.summary, attributes: value.attributes,
      localStorage: value.localStorage, sessionStorage: value.sessionStorage,
      indexedDB: value.indexedDB, cacheStorage: value.cacheStorage, quota: value.quota,
      localEntryCount: value.localEntryCount, sessionEntryCount: value.sessionEntryCount };
  }
  status(): StorageStatus {
    if (this.phase !== 'idle') { this.current(); }
    return { phase: this.phase, reason: this.reason, nativePending: this.busySource(), expiresAt: this.expiresAt };
  }
  private available(): boolean { try { return this.activeSource(); } catch { return false; } }
  private timeValid(): boolean {
    const now = Date.now();
    if (this.clockInvalid || !Number.isSafeInteger(now) || now < this.lastTime) {
      this.clockInvalid = true; this.cancel(); return false;
    }
    this.lastTime = now; return true;
  }
  private current(): boolean {
    if (!this.timeValid() || !this.available() || Date.now() >= this.expiresAt) {
      this.cancel(); return false;
    }
    return true;
  }
}
