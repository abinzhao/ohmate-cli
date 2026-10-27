/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CryptoPort, canonical, hex, match, requireWire } from './Wire';
import { StorageMutation, storageMutationScript, projectStorageMutation } from './ControlledStorage';

export interface StorageWriteInput {
  url: string; area: string; key: string; original: string | null; value: string | null;
  binding: string; captureId: number; captureDeadline: number; deadline: number; ttlMs: number;
}
export interface StorageWriteReview {
  scope: string; risk: string; targetId: string; commandId: string; idempotencyKey: string;
  area: string; key: string; operation: string; originalHash: string; payloadHash: string;
  planHash: string; expiresAt: number; recoveryDeadline: number;
}
export interface StorageWriteStatus {
  phase: string; commandId: string; revocation: string; reason: string;
  nativePending: boolean; pendingCleanup: number; authentication: string;
}
export interface StorageWriteExecutor {
  busy: () => boolean;
  execute: (code: string, active: () => boolean, dispatched: () => void) => Promise<string>;
}

// ArkTS application owner follows the desktop WriteSession contract: consume one
// grant, retain command tombstones, register recovery before effects, invalidate
// before awaiting native settlement and retry failed cleanup only explicitly.
export class StorageWriteSession {
  private crypto: CryptoPort;
  private bindingSource: () => string;
  private busySource: () => boolean;
  private changed: () => void;
  private reviewValue: StorageWriteReview | undefined = undefined;
  private original: string | null | undefined = undefined;
  private replacement: string | null | undefined = undefined;
  private url: string = '';
  private binding: string = '';
  private phase: string = 'idle';
  private reason: string = '';
  private revocation: string = 'not-needed';
  private invalidated: boolean = true;
  private needsRollback: boolean = false;
  private executing: boolean = false;
  private restoring: boolean = false;
  private autoRestore: boolean = false;
  private attempts: number = 0;
  private commandIds: string[] = [];
  private cleanupAttempts: number = 0;
  private lastTime: number = Date.now();
  private lastExecution: number = -1;
  private clockInvalid: boolean = false;
  private rawDeadline: number = 0;
  private rawTimer: number = -1;
  private grantTimer: number = -1;
  private waiting: (() => void) | undefined = undefined;
  private operation: Promise<boolean> | undefined = undefined;
  private executor: StorageWriteExecutor | undefined = undefined;
  private nativeMutation: StorageMutation | undefined = undefined;
  private recoveryInvalid: boolean = false;

  constructor(crypto: CryptoPort, binding: () => string, busy: () => boolean,
    changed: () => void = (): void => {}) {
    this.crypto = crypto; this.bindingSource = binding; this.busySource = busy;
    this.changed = changed;
  }
  review(input: StorageWriteInput): StorageWriteReview {
    requireWire(!this.executing && !this.restoring && !this.busySource() && !this.needsRollback, 'STORAGE_WRITE_BUSY');
    this.invalidate(); this.clearRaw(); this.reviewValue = undefined;
    requireWire(this.timeValid() && this.attempts < 256, 'STORAGE_WRITE_UNAVAILABLE');
    this.attempts++;
    requireWire(input !== null && typeof input === 'object' &&
      Object.keys(input).length === 10 && Object.keys(input).every((key: string): boolean =>
        ['url', 'area', 'key', 'original', 'value', 'binding', 'captureId', 'captureDeadline', 'deadline', 'ttlMs'].includes(key)) &&
      typeof input.url === 'string' && match(input.url, '^http://127[.]0[.]0[.]1:[1-9][0-9]{0,4}/kit-readonly[.]html$') &&
      ['local', 'session'].includes(input.area) && typeof input.key === 'string' &&
      match(input.key, '^ohmate-test-[a-z0-9-]{1,64}$') && this.validValue(input.original) && this.validValue(input.value) &&
      input.original !== input.value && typeof input.binding === 'string' && input.binding.length > 0 &&
      input.binding.length <= 65536 && this.source() === input.binding &&
      Number.isSafeInteger(input.captureId) && input.captureId > 0 &&
      Number.isSafeInteger(input.captureDeadline) && input.captureDeadline > Date.now() &&
      input.captureDeadline <= Date.now() + 30000 && Number.isSafeInteger(input.deadline) &&
      input.deadline > Date.now() && Number.isInteger(input.ttlMs) && input.ttlMs > 0 && input.ttlMs <= 600000,
    'STORAGE_WRITE_INVALID');
    const expiresAt = Math.min(input.captureDeadline, input.deadline, Date.now() + input.ttlMs);
    const commandId = this.uuid();
    requireWire(!this.commandIds.includes(commandId), 'STORAGE_WRITE_UNAVAILABLE');
    this.commandIds.push(commandId);
    const payload: Record<string, Object | null> = { 'area': input.area, 'key': input.key, 'value': input.value };
    const originalHash = this.crypto.hash(canonical(input.original));
    const payloadHash = this.crypto.hash(canonical(payload));
    const plan: Record<string, Object> = { 'scope': 'arkweb.storage.write', 'targetId': 'web-main',
      'commandId': commandId, 'idempotencyKey': commandId, 'binding': input.binding, 'url': input.url,
      'captureId': input.captureId, 'originalHash': originalHash, 'payloadHash': payloadHash,
      'expiresAt': expiresAt, 'recoveryDeadline': input.captureDeadline, 'ttlMs': input.ttlMs };
    const review: StorageWriteReview = { scope: 'arkweb.storage.write', risk: 'R3', targetId: 'web-main',
      commandId: commandId, idempotencyKey: commandId, area: input.area, key: input.key,
      operation: input.value === null ? 'remove' : input.original === null ? 'create' : 'set',
      originalHash: originalHash, payloadHash: payloadHash, planHash: this.crypto.hash(canonical(plan)),
      expiresAt: expiresAt, recoveryDeadline: input.captureDeadline };
    this.reviewValue = review; this.original = input.original; this.replacement = input.value;
    this.binding = input.binding; this.url = input.url; this.rawDeadline = input.captureDeadline;
    this.phase = 'review'; this.reason = ''; this.revocation = 'not-needed'; this.invalidated = false;
    this.cleanupAttempts = 0; this.autoRestore = false; this.executor = undefined; this.recoveryInvalid = false;
    this.rawTimer = setTimeout(() => { this.expireRaw(); }, Math.max(0, this.rawDeadline - Date.now()));
    this.grantTimer = setTimeout(() => { void this.cancel(this.executor); }, Math.max(0, expiresAt - Date.now()));
    return JSON.parse(JSON.stringify(review)) as StorageWriteReview;
  }
  confirm(planHash: string): boolean {
    if (!this.current() || this.phase !== 'review' || this.reviewValue?.planHash !== planHash) { return false; }
    this.phase = 'confirmed'; return true;
  }
  async apply(planHash: string, executor: StorageWriteExecutor): Promise<boolean> {
    if (!this.current() || this.phase !== 'confirmed' || this.reviewValue?.planHash !== planHash ||
      this.executing || this.restoring || executor.busy() ||
      (this.lastExecution >= 0 && Date.now() - this.lastExecution < 1000)) { return false; }
    const mutation = this.mutation(false);
    this.nativeMutation = mutation;
    this.phase = 'running'; this.executing = true; this.executor = executor; this.lastExecution = Date.now();
    let timer: number = -1;
    const cancelled = new Promise<boolean>((resolve) => {
      this.waiting = (): void => { resolve(false); };
      timer = setTimeout(() => {
        this.autoRestore = true; this.reason = 'STORAGE_WRITE_TIMEOUT'; this.invalidate();
      }, 3000);
    });
    const operation = Promise.resolve().then((): Promise<string> => {
      requireWire(this.current(), 'STORAGE_WRITE_UNAVAILABLE');
      return executor.execute(storageMutationScript(mutation), (): boolean => this.current(), (): void => {
        requireWire(this.current(), 'STORAGE_WRITE_UNAVAILABLE');
        this.needsRollback = true; this.revocation = 'active';
      });
    }).then((text: string): boolean => {
      if (!this.current()) { return false; }
      const outcome = projectStorageMutation(this.crypto, text, mutation);
      if (!this.current()) { return false; }
      if (outcome === 'conflict') {
        this.needsRollback = false; this.revocation = 'not-needed'; this.phase = 'failed';
        this.reason = 'STORAGE_WRITE_CONFLICT'; this.invalidate(); this.clearRaw(); return false;
      }
      requireWire(outcome === 'applied', 'STORAGE_MUTATION_UNKNOWN');
      this.phase = 'applied'; return true;
    }).catch((): boolean => {
      if (!this.invalidated) { this.phase = 'failed'; this.reason = 'STORAGE_WRITE_FAILED'; this.invalidate(); }
      if (this.needsRollback) { this.revocation = 'cleanup-failed'; }
      return false;
    }).finally(async (): Promise<void> => {
      this.releaseMutation(mutation); this.executing = false;
      if (this.invalidated && this.autoRestore && this.needsRollback && this.cleanupAttempts === 0) {
        await this.restore(executor);
      }
      this.changed();
    });
    this.operation = operation;
    try { return await Promise.race([operation, cancelled]); }
    finally { clearTimeout(timer); this.waiting = undefined; }
  }
  async cancel(executor: StorageWriteExecutor | undefined = this.executor): Promise<void> {
    this.autoRestore = true; this.invalidate();
    if (this.executing && this.operation !== undefined) { await this.operation; return; }
    if (executor !== undefined && this.needsRollback && this.cleanupAttempts === 0) { await this.restore(executor); }
    if (!this.needsRollback) { this.clearRaw(); }
  }
  async retryRestore(executor: StorageWriteExecutor): Promise<boolean> {
    this.invalidate();
    if (!this.needsRollback) { return this.revocation === 'revoked'; }
    return this.restore(executor);
  }
  private async restore(executor: StorageWriteExecutor): Promise<boolean> {
    if (this.executing || this.restoring || executor.busy() || !this.recoveryCurrent()) {
      if (this.needsRollback) { this.revocation = 'cleanup-failed'; }
      return false;
    }
    this.cleanupAttempts++; this.restoring = true; this.revocation = 'active';
    const mutation = this.mutation(true);
    this.nativeMutation = mutation;
    let timer: number = -1;
    let waiting: boolean = true;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        waiting = false;
        if (this.recoveryCurrent()) { this.reason = 'STORAGE_RESTORE_TIMEOUT'; }
        this.revocation = 'cleanup-failed'; resolve(false);
      }, 3000);
    });
    const operation = Promise.resolve().then((): Promise<string> => executor.execute(storageMutationScript(mutation),
      (): boolean => waiting && this.recoveryCurrent(), (): void => {
        requireWire(waiting && this.recoveryCurrent(), 'STORAGE_RECOVERY_UNAVAILABLE');
      })).then((text: string): boolean => {
      if (!waiting || !this.recoveryCurrent()) { return false; }
      const outcome = projectStorageMutation(this.crypto, text, mutation);
      if (!waiting || !this.recoveryCurrent() || outcome !== 'restored') { return false; }
      this.needsRollback = false; this.revocation = 'revoked'; this.reason = ''; this.clearRaw();
      return true;
    }).catch((): boolean => false).then((restored: boolean): boolean => {
      if (!restored) {
        this.revocation = 'cleanup-failed';
        if (!this.reason) { this.reason = 'STORAGE_RESTORE_FAILED'; }
      }
      return restored;
    }).finally(() => {
      waiting = false; this.releaseMutation(mutation); this.restoring = false; clearTimeout(timer); this.changed();
    });
    return Promise.race([operation, timeout]);
  }
  private mutation(restore: boolean): StorageMutation {
    const review = this.reviewValue;
    requireWire(review !== undefined && this.original !== undefined && this.replacement !== undefined,
      'STORAGE_RECOVERY_UNAVAILABLE');
    if (review === undefined || this.original === undefined || this.replacement === undefined) {
      throw new Error('STORAGE_RECOVERY_UNAVAILABLE');
    }
    return { url: this.url, area: review.area, key: review.key, commandId: review.commandId,
      mode: restore ? 'restore' : 'apply', expected: restore ? this.replacement : this.original,
      replacement: restore ? this.original : this.replacement, original: this.original,
      deadline: restore ? this.rawDeadline : review.expiresAt };
  }
  status(): StorageWriteStatus {
    this.timeValid();
    if (this.reviewValue !== undefined && this.original !== undefined) { this.sourceCurrent(); }
    if (this.reviewValue !== undefined && !this.invalidated) { this.current(); }
    if (Date.now() >= this.rawDeadline && this.rawDeadline > 0) { this.expireRaw(); }
    return { phase: this.phase, commandId: this.reviewValue?.commandId ?? '', reason: this.reason,
      revocation: this.revocation, nativePending: this.executing || this.restoring || this.busySource(),
      pendingCleanup: this.needsRollback ? 1 : 0, authentication: 'not-authenticated' };
  }
  dispose(): void {
    this.recoveryInvalid = true; this.invalidate(); this.clearRaw();
    if (this.needsRollback) { this.revocation = 'cleanup-failed'; this.reason = 'STORAGE_RECOVERY_DISPOSED'; }
  }
  private invalidate(): void {
    this.invalidated = true; clearTimeout(this.grantTimer);
    if (this.phase === 'review' || this.phase === 'confirmed' || this.phase === 'running' || this.phase === 'applied') {
      this.phase = 'cancelled';
    }
    this.waiting?.();
  }
  private clearRaw(): void {
    clearTimeout(this.rawTimer); this.original = undefined; this.replacement = undefined; this.rawDeadline = 0;
    if (this.nativeMutation !== undefined) { this.releaseMutation(this.nativeMutation); }
  }
  private releaseMutation(mutation: StorageMutation): void {
    mutation.expected = null; mutation.replacement = null; mutation.original = null;
    if (this.nativeMutation === mutation) { this.nativeMutation = undefined; }
  }
  private expireRaw(): void {
    const retained = this.original !== undefined || this.replacement !== undefined;
    this.invalidate(); this.clearRaw();
    if (this.needsRollback) { this.revocation = 'cleanup-failed'; this.reason = 'STORAGE_RECOVERY_EXPIRED'; }
    if (retained) { this.changed(); }
  }
  private current(): boolean {
    if (!this.timeValid() || this.invalidated || this.reviewValue === undefined ||
      Date.now() >= this.reviewValue.expiresAt || !this.sourceCurrent()) {
      this.invalidate(); return false;
    }
    return this.original !== undefined && this.replacement !== undefined;
  }
  private recoveryCurrent(): boolean {
    if (this.recoveryInvalid) { return false; }
    if (!this.timeValid() || this.original === undefined || this.replacement === undefined ||
      Date.now() >= this.rawDeadline) { this.expireRaw(); return false; }
    return this.sourceCurrent();
  }
  private sourceCurrent(): boolean {
    if (this.recoveryInvalid) { return false; }
    if (this.source() === this.binding) { return true; }
    this.recoveryInvalid = true; this.invalidate(); this.clearRaw();
    this.reason = this.needsRollback ? 'STORAGE_RECOVERY_SOURCE_CHANGED' : 'STORAGE_WRITE_SOURCE_CHANGED';
    if (this.needsRollback) { this.revocation = 'cleanup-failed'; }
    return false;
  }
  private timeValid(): boolean {
    const now = Date.now();
    if (this.clockInvalid || !Number.isSafeInteger(now) || now < this.lastTime) {
      this.clockInvalid = true; this.invalidate(); this.clearRaw(); this.reason = 'STORAGE_WRITE_CLOCK_INVALID'; return false;
    }
    this.lastTime = now; return true;
  }
  private source(): string { try { return this.bindingSource(); } catch { return ''; } }
  private validValue(value: string | null): boolean {
    if (value === null) { return true; }
    if (typeof value !== 'string' || value.length > 1024) { return false; }
    const bytes = this.crypto.encode(value);
    try { return bytes.length <= 4096 && this.crypto.decode(bytes) === value; }
    finally { bytes.fill(0); }
  }
  private uuid(): string {
    const bytes = this.crypto.random(16);
    try {
      requireWire(bytes.length === 16, 'STORAGE_WRITE_UNAVAILABLE');
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const text = hex(bytes);
      return text.slice(0, 8) + '-' + text.slice(8, 12) + '-' + text.slice(12, 16) + '-' +
        text.slice(16, 20) + '-' + text.slice(20);
    } finally { bytes.fill(0); }
  }
}
