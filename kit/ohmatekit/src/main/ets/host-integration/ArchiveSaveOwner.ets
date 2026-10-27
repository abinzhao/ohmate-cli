/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CORE_ARCHIVE_MAX_BYTES } from '../core/StoredZip';

export interface ArchiveSaveHost {
  available?(): boolean;
  pick(fileName: string): Promise<boolean>;
  write(bytes: Uint8Array, current: () => boolean): Promise<boolean>;
  close(): Promise<boolean>;
}

// One current-window save lane. Native timeout ends waiting, never ownership.
export class ArchiveSaveOwner {
  private host: ArchiveSaveHost;
  private now: () => number;
  private lastTime: number = -1;
  private clockInvalid: boolean = false;
  private inFlight: boolean = false;
  private cleanupRequired: boolean = false;
  private cancelled: boolean = false;
  private deadline: number = 0;
  private attempts: number = 0;
  private cleanupAttempts: number = 0;
  private timer: number = -1;
  private wake: ((code: string) => void) | undefined = undefined;
  constructor(host: ArchiveSaveHost, now: () => number) { this.host = host; this.now = now; }
  getState(): string {
    this.clock();
    return this.cleanupRequired ? 'cleanup-required' : this.inFlight ? 'busy' : 'idle';
  }
  async save(bytes: Uint8Array, fileName: string, current: () => boolean,
    timeoutMs: number = 30000): Promise<string> {
    if (bytes.length < 1 || bytes.length > CORE_ARCHIVE_MAX_BYTES ||
      !new RegExp('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\\.ohmate-problem\\.zip$').test(fileName) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) { return 'SAVE_INVALID'; }
    if (this.cleanupRequired) { return 'SAVE_CLEANUP_REQUIRED'; }
    if (this.inFlight) { return 'SAVE_BUSY'; }
    const now: number = this.clock();
    if (now < 0 || now > Number.MAX_SAFE_INTEGER - timeoutMs || !this.allowed(current)) { return 'SAVE_UNAVAILABLE'; }
    try { if (this.host.available?.() === false) { return 'SAVE_UNAVAILABLE'; } }
    catch (_) { return 'SAVE_UNAVAILABLE'; }
    if (this.attempts >= 256) { return 'SAVE_QUOTA'; }
    this.attempts++; this.inFlight = true; this.cancelled = false;
    this.deadline = now + timeoutMs;
    const owned: Uint8Array = bytes.slice();
    const waiting = new Promise<string>((resolve: (code: string) => void): void => {
      this.wake = resolve;
      this.timer = setTimeout((): void => { this.cancel('SAVE_TIMEOUT'); }, timeoutMs);
    });
    this.perform(owned, fileName, current).then((code: string): void => {
      // Clear only after the original host no longer reads our buffer.
      owned.fill(0); this.inFlight = false;
      this.complete(code);
    });
    return waiting;
  }
  cancel(code: string = 'SAVE_CANCELLED'): void {
    if (!this.inFlight) { return; }
    this.cancelled = true; this.cleanupRequired = true; this.complete(code);
  }
  async retryCleanup(timeoutMs: number = 1000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) { return false; }
    if (this.inFlight) { return false; }
    if (!this.cleanupRequired) { return true; }
    if (this.cleanupAttempts >= 256) { return false; }
    // Cleanup has its own bounded lane so exhausted save grants cannot strand a file.
    this.cleanupAttempts++; this.inFlight = true; this.cancelled = false;
    this.deadline = Number.MAX_SAFE_INTEGER;
    return new Promise<boolean>((resolve: (closed: boolean) => void): void => {
      let settled: boolean = false;
      const timer: number = setTimeout((): void => {
        settled = true; this.cancelled = true; resolve(false);
      }, timeoutMs);
      const finished: (closed: boolean) => void = (closed: boolean): void => {
        this.inFlight = false; clearTimeout(timer);
        if (!settled && !this.cancelled && closed) { this.cleanupRequired = false; }
        if (!settled) { resolve(closed && !this.cancelled); }
        settled = true;
      };
      Promise.resolve<void>(undefined).then((): Promise<boolean> => this.host.close())
        .then(finished).catch((): void => { finished(false); });
    });
  }
  private async perform(bytes: Uint8Array, fileName: string, current: () => boolean): Promise<string> {
    let code: string = 'SAVE_FAILED';
    try {
      const selected: boolean = await this.host.pick(fileName);
      if (!this.granted(current)) { this.cleanupRequired = true; return 'SAVE_CANCELLED'; }
      if (!selected) { code = 'SAVE_CANCELLED'; }
      else {
        const written: boolean = await this.host.write(bytes, (): boolean => this.granted(current));
        if (!this.granted(current)) { this.cleanupRequired = true; return 'SAVE_CANCELLED'; }
        code = written ? 'SAVE_HOST_REPORTED' : 'SAVE_FAILED';
      }
    } catch (_) {}
    if (this.cancelled) { this.cleanupRequired = true; return 'SAVE_CANCELLED'; }
    try {
      if (!await this.host.close()) { this.cleanupRequired = true; return 'SAVE_CLEANUP_REQUIRED'; }
    } catch (_) { this.cleanupRequired = true; return 'SAVE_CLEANUP_REQUIRED'; }
    // Cancellation during close cannot turn a late close into a fresh grant.
    if (!this.granted(current)) { this.cleanupRequired = true; return 'SAVE_CANCELLED'; }
    return code;
  }
  private granted(current: () => boolean): boolean {
    const now: number = this.clock();
    return !this.cancelled && now >= 0 && now < this.deadline && this.allowed(current);
  }
  private allowed(current: () => boolean): boolean {
    try { return current(); } catch (_) { return false; }
  }
  private clock(): number {
    if (this.clockInvalid) { return -1; }
    try {
      const now: number = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now < this.lastTime) { throw new Error('CLOCK_INVALID'); }
      this.lastTime = now;
      if (this.inFlight && now >= this.deadline) { this.cancel('SAVE_TIMEOUT'); }
      return now;
    } catch (_) {
      this.clockInvalid = true; this.cancel(); return -1;
    }
  }
  private complete(code: string): void {
    if (this.timer !== -1) { clearTimeout(this.timer); this.timer = -1; }
    const wake: ((code: string) => void) | undefined = this.wake;
    this.wake = undefined; wake?.(code);
  }
}
