/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CryptoPort, canonical, hex, match, requireWire } from './Wire';

export interface UiHighlightSource {
  targetId: string; windowId: string; sourceHash: string; binding: string; deadline: number;
}
export interface UiHighlightHost {
  apply: (commandId: string) => boolean;
  clear: (commandId: string) => boolean;
}
export interface UiHighlightReview {
  scope: string; risk: string; targetId: string; windowId: string; sourceHash: string;
  commandId: string; idempotencyKey: string; payloadHash: string; planHash: string;
  expiresAt: number; durationMs: number;
}
export interface UiHighlightStatus {
  phase: string; reason: string; commandId: string; planHash: string; revocation: string;
  pendingCleanup: number; displayExpiresAt: number; authentication: string;
}

// Application-local consent never authenticates a peer or admits remote writes.
// A host's state acceptance is not proof of rendering or physical paint.
export class UiHighlightSession {
  private crypto: CryptoPort;
  private source: () => UiHighlightSource | undefined;
  private host: UiHighlightHost | undefined;
  private changed: () => void;
  private grant: UiHighlightReview | undefined = undefined;
  private binding: string = '';
  private deadline: number = 0;
  private phase: string = 'idle';
  private reason: string = '';
  private revocation: string = 'not-needed';
  private invalidated: boolean = true;
  private closed: boolean = false;
  private sourceInvalid: boolean = false;
  private clockInvalid: boolean = false;
  private applying: boolean = false;
  private clearing: boolean = false;
  private needsClear: boolean = false;
  private clearAttempted: boolean = false;
  private displayExpiresAt: number = 0;
  private attempts: number = 0;
  private commandIds: string[] = [];
  private lastTime: number = Date.now();
  private lastExecution: number = -1;
  private timer: number = -1;

  constructor(crypto: CryptoPort, source: () => UiHighlightSource | undefined,
    host: UiHighlightHost | undefined = undefined, changed: () => void = (): void => {}) {
    this.crypto = crypto; this.source = source; this.host = host; this.changed = changed;
  }
  review(ttlMs: number = 30000, durationMs: number = 3000): UiHighlightReview {
    this.observe();
    requireWire(!this.needsClear && !this.applying && !this.clearing, 'UI_HIGHLIGHT_CLEANUP_REQUIRED');
    this.invalidate('cancelled', 'UI_HIGHLIGHT_CANCELLED');
    this.grant = undefined;
    requireWire(!this.closed && !this.clockInvalid && !this.sourceInvalid && this.attempts < 256,
      'UI_HIGHLIGHT_UNAVAILABLE');
    this.attempts++;
    const source = this.readSource();
    requireWire(this.host !== undefined && source !== undefined &&
      Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 30000 &&
      Number.isInteger(durationMs) && durationMs > 0 && durationMs <= 3000, 'UI_HIGHLIGHT_INVALID');
    if (source === undefined) { throw new Error('UI_HIGHLIGHT_UNAVAILABLE'); }
    const random = this.crypto.random(16);
    requireWire(random.length === 16, 'UI_HIGHLIGHT_UNAVAILABLE');
    random[6] = (random[6] & 15) | 64; random[8] = (random[8] & 63) | 128;
    const text = hex(random); random.fill(0);
    const commandId = text.slice(0, 8) + '-' + text.slice(8, 12) + '-' + text.slice(12, 16) +
      '-' + text.slice(16, 20) + '-' + text.slice(20);
    requireWire(!this.commandIds.includes(commandId), 'UI_HIGHLIGHT_UNAVAILABLE');
    this.commandIds.push(commandId);
    const expiresAt = Math.min(Date.now() + ttlMs, source.deadline);
    const payload: Record<string, Object> = {
      'targetId': source.targetId, 'windowId': source.windowId, 'durationMs': durationMs
    };
    const payloadHash = this.crypto.hash(canonical(payload));
    const plan: Record<string, Object> = {
      'scope': 'ui.highlight', 'risk': 'R2', 'commandId': commandId, 'idempotencyKey': commandId,
      'targetId': source.targetId, 'windowId': source.windowId, 'sourceHash': source.sourceHash,
      'binding': source.binding, 'deadline': source.deadline, 'expiresAt': expiresAt, 'payloadHash': payloadHash
    };
    const review: UiHighlightReview = {
      scope: 'ui.highlight', risk: 'R2', targetId: source.targetId, windowId: source.windowId,
      sourceHash: source.sourceHash, commandId: commandId, idempotencyKey: commandId,
      payloadHash: payloadHash, planHash: this.crypto.hash(canonical(plan)),
      expiresAt: expiresAt, durationMs: durationMs
    };
    this.grant = review; this.binding = source.binding; this.deadline = source.deadline;
    this.phase = 'review'; this.reason = ''; this.invalidated = false; this.revocation = 'not-needed';
    this.clearAttempted = false; this.displayExpiresAt = 0;
    this.schedule(expiresAt);
    return JSON.parse(JSON.stringify(review)) as UiHighlightReview;
  }
  confirm(planHash: string): boolean {
    this.observe();
    if (this.invalidated || this.phase !== 'review' || this.grant?.planHash !== planHash) { return false; }
    this.phase = 'confirmed'; return true;
  }
  apply(planHash: string): boolean {
    this.observe();
    const grant = this.grant;
    const host = this.host;
    if (this.invalidated || this.phase !== 'confirmed' || grant === undefined || grant.planHash !== planHash ||
      host === undefined || this.needsClear || this.applying || this.clearing ||
      (this.lastExecution >= 0 && Date.now() - this.lastExecution < 1000)) { return false; }
    // Responsibility exists before even a throwing or reentrant host has effects.
    this.applying = true; this.needsClear = true; this.revocation = 'active'; this.phase = 'running';
    this.displayExpiresAt = Math.min(Date.now() + grant.durationMs, grant.expiresAt, this.deadline);
    this.lastExecution = Date.now();
    let accepted = false;
    try { accepted = host.apply(grant.commandId) === true; }
    catch { accepted = false; }
    finally { this.applying = false; }
    this.observe();
    if (!accepted || this.invalidated) {
      if (!this.invalidated) { this.invalidate('failed', 'UI_HIGHLIGHT_FAILED'); }
      this.clearOnce(); this.changed(); return false;
    }
    this.phase = 'applied'; this.schedule(this.displayExpiresAt); this.changed(); return true;
  }
  cancel(): void {
    this.observe();
    if (!this.invalidated) { this.invalidate('cancelled', 'UI_HIGHLIGHT_CANCELLED'); }
    this.clearOnce(); this.changed();
  }
  dispose(): void {
    this.closed = true; this.cancel();
    if (!this.needsClear && !this.applying && !this.clearing) { this.host = undefined; }
  }
  retryClear(): boolean {
    this.observe();
    if (this.applying || this.clearing) { return false; }
    if (!this.needsClear) { return this.revocation === 'revoked'; }
    this.invalidate('cancelled', this.reason || 'UI_HIGHLIGHT_CANCELLED');
    const cleared = this.clearOwned(); this.changed(); return cleared;
  }
  status(): UiHighlightStatus {
    this.observe();
    const status: UiHighlightStatus = {
      phase: this.phase, reason: this.reason, commandId: this.grant?.commandId ?? '',
      planHash: ['review', 'confirmed'].includes(this.phase) && !this.invalidated ? this.grant?.planHash ?? '' : '',
      revocation: this.revocation, pendingCleanup: this.needsClear ? 1 : 0,
      displayExpiresAt: this.displayExpiresAt, authentication: 'unverified'
    };
    return status;
  }
  private readSource(): UiHighlightSource | undefined {
    try {
      const source = this.source();
      if (source === undefined || source.targetId !== 'bridge_snapshot_target' ||
        !match(source.windowId, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') ||
        !match(source.sourceHash, '^[a-f0-9]{64}$') || !match(source.binding, '^[a-f0-9]{64}$') ||
        !Number.isSafeInteger(source.deadline) || source.deadline <= Date.now()) { return undefined; }
      return source;
    } catch { return undefined; }
  }
  private observe(): void {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.lastTime) {
      this.clockInvalid = true;
      this.invalidate('cancelled', 'UI_HIGHLIGHT_CLOCK_INVALID');
    } else { this.lastTime = now; }
    const grant = this.grant;
    if (!this.invalidated && grant !== undefined) {
      const source = this.readSource();
      if (now >= grant.expiresAt || (this.displayExpiresAt > 0 && now >= this.displayExpiresAt)) {
        this.invalidate('expired', 'UI_HIGHLIGHT_EXPIRED');
      } else if (source === undefined || source.sourceHash !== grant.sourceHash || source.binding !== this.binding ||
        source.windowId !== grant.windowId || source.targetId !== grant.targetId || source.deadline !== this.deadline) {
        this.sourceInvalid = true;
        this.invalidate('cancelled', 'UI_HIGHLIGHT_SOURCE_CHANGED');
      }
    }
    if (this.invalidated) { this.clearOnce(); }
  }
  private invalidate(phase: string, reason: string): void {
    this.invalidated = true; this.phase = phase; this.reason = reason;
    clearTimeout(this.timer); this.timer = -1; this.displayExpiresAt = 0;
  }
  private clearOnce(): void {
    if (this.needsClear && !this.clearAttempted && !this.applying && !this.clearing) { this.clearOwned(); }
  }
  private clearOwned(): boolean {
    const commandId = this.grant?.commandId;
    const host = this.host;
    if (commandId === undefined || host === undefined || this.applying || this.clearing) { return false; }
    this.clearAttempted = true; this.clearing = true;
    let cleared = false;
    try { cleared = host.clear(commandId) === true; } catch { cleared = false; }
    finally { this.clearing = false; }
    this.needsClear = !cleared; this.revocation = cleared ? 'revoked' : 'cleanup-failed';
    if (cleared && this.closed) { this.host = undefined; }
    if (!cleared && !this.reason) { this.reason = 'UI_HIGHLIGHT_CLEAR_FAILED'; }
    return cleared;
  }
  private schedule(deadline: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.observe();
      if (!this.invalidated) { this.schedule(deadline); }
      this.changed();
    }, Math.max(0, Math.min(250, deadline - Date.now())));
  }
}
