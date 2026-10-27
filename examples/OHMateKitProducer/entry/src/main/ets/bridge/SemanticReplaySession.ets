/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CryptoPort, canonical, hex, match, requireWire } from './Wire';

export interface SemanticReplayStep {
  kind: string; actionId: string; dataRef: string; assertionId: string; expected: string; waitMs: number;
}
export interface ReplayDescriptor {
  kind: string; actionId: string; dataRefs: string[]; assertionId: string; expectations: string[];
}
export interface ReplaySource {
  buildId: string; buildBinding: string; sourceHash: string; binding: string; windowId: string; deadline: number;
}
export interface ReplayAdapter {
  descriptors: () => ReplayDescriptor[];
  prepare: (commandId: string) => boolean;
  execute: (commandId: string, step: SemanticReplayStep) => Promise<boolean>;
  assert: (commandId: string, assertionId: string, expected: string) => Promise<boolean>;
  restore: (commandId: string) => Promise<boolean>;
}
export interface ReplayReview {
  scope: string; risk: string; commandId: string; idempotencyKey: string; buildId: string;
  actionId: string; assertionId: string; payloadHash: string; planHash: string; expiresAt: number;
}
export interface ReplayStatus {
  phase: string; reason: string; commandId: string; planHash: string; assertion: string;
  nativePending: boolean; pendingCleanup: number; revocation: string; authentication: string;
}

// The host must pin its own compiled artifact. A peer's build string is never
// such evidence, and this local consent never grants a remote write capability.
export class SemanticReplaySession {
  private crypto: CryptoPort;
  private source: () => ReplaySource | undefined;
  private host: ReplayAdapter | undefined;
  private changed: () => void;
  private grant: ReplayReview | undefined = undefined;
  private step: SemanticReplayStep | undefined = undefined;
  private originalSource: ReplaySource | undefined = undefined;
  private descriptorHash: string = '';
  private phase: string = 'idle';
  private reason: string = '';
  private assertion: string = 'not-run';
  private revocation: string = 'not-needed';
  private invalidated: boolean = true;
  private closed: boolean = false;
  private sourceInvalid: boolean = false;
  private clockInvalid: boolean = false;
  private executing: boolean = false;
  private restoring: boolean = false;
  private needsRestore: boolean = false;
  private restoreAttempted: boolean = false;
  private attempts: number = 0;
  private commandIds: string[] = [];
  private lastTime: number = Date.now();
  private lastExecution: number = -1;
  private timer: number = -1;
  private waiting: (() => void) | undefined = undefined;

  constructor(crypto: CryptoPort, source: () => ReplaySource | undefined, host: ReplayAdapter | undefined = undefined,
    changed: () => void = (): void => {}) {
    this.crypto = crypto; this.source = source; this.host = host; this.changed = changed;
  }
  review(input: SemanticReplayStep, buildId: string): ReplayReview {
    this.observe();
    requireWire(!this.executing && !this.restoring && !this.needsRestore, 'REPLAY_CLEANUP_REQUIRED');
    this.invalidate('cancelled', 'REPLAY_CANCELLED'); this.grant = undefined; this.step = undefined;
    requireWire(!this.closed && !this.clockInvalid && !this.sourceInvalid && this.attempts < 256, 'REPLAY_UNAVAILABLE');
    this.attempts++;
    requireWire(this.validStep(input), 'REPLAY_STEP_INVALID');
    const source = this.readSource();
    requireWire(source !== undefined && source.deadline > Date.now() && source.buildId === buildId, 'REPLAY_BUILD_UNAVAILABLE');
    if (source === undefined) { throw new Error('REPLAY_UNAVAILABLE'); }
    const descriptorHash = this.descriptors(input);
    const step = JSON.parse(JSON.stringify(input)) as SemanticReplayStep;
    const commandId = this.uuid();
    requireWire(!this.commandIds.includes(commandId), 'REPLAY_UNAVAILABLE');
    this.commandIds.push(commandId);
    const expiresAt = Math.min(Date.now() + 30000, source.deadline);
    const payloadHash = this.crypto.hash(canonical(step));
    const plan: Record<string, Object> = { 'scope': 'replay.step', 'risk': 'R3', 'commandId': commandId,
      'idempotencyKey': commandId, 'source': source, 'descriptorHash': descriptorHash,
      'payloadHash': payloadHash, 'expiresAt': expiresAt };
    const review: ReplayReview = { scope: 'replay.step', risk: 'R3', commandId: commandId, idempotencyKey: commandId,
      buildId: source.buildId, actionId: step.actionId, assertionId: step.assertionId, payloadHash: payloadHash,
      planHash: this.crypto.hash(canonical(plan)), expiresAt: expiresAt };
    this.grant = review; this.step = step; this.originalSource = source; this.descriptorHash = descriptorHash;
    this.phase = 'review'; this.reason = ''; this.assertion = 'not-run'; this.revocation = 'not-needed';
    this.invalidated = false; this.restoreAttempted = false; this.schedule();
    return JSON.parse(JSON.stringify(review)) as ReplayReview;
  }
  confirm(planHash: string): boolean {
    this.observe();
    if (this.invalidated || this.phase !== 'review' || this.grant?.planHash !== planHash) { return false; }
    this.phase = 'confirmed'; return true;
  }
  async apply(planHash: string): Promise<boolean> {
    this.observe();
    const grant = this.grant, step = this.step, host = this.host;
    if (this.invalidated || this.phase !== 'confirmed' || grant === undefined || step === undefined || host === undefined ||
      grant.planHash !== planHash || this.executing || this.restoring || this.needsRestore ||
      (this.lastExecution >= 0 && Date.now() - this.lastExecution < 1000)) { return false; }
    this.executing = true; this.needsRestore = true; this.revocation = 'active'; this.phase = 'running';
    this.lastExecution = Date.now();
    let timeout: number = -1;
    const cancelled = new Promise<boolean>((resolve) => {
      this.waiting = (): void => { resolve(false); };
      timeout = setTimeout(() => { this.invalidate('aborted', 'REPLAY_TIMEOUT'); this.changed(); }, step.waitMs);
    });
    const operation = Promise.resolve().then(async (): Promise<boolean> => {
      requireWire(this.current() && host.prepare(grant.commandId) === true, 'REPLAY_PREPARE_FAILED');
      requireWire(this.current(), 'REPLAY_UNAVAILABLE');
      const accepted = await host.execute(grant.commandId, JSON.parse(JSON.stringify(step)) as SemanticReplayStep);
      requireWire(this.current() && accepted === true, 'REPLAY_EFFECT_FAILED');
      const asserted = await host.assert(grant.commandId, step.assertionId, step.expected);
      if (!this.current()) { return false; }
      this.assertion = asserted === true ? 'passed' : 'failed';
      requireWire(asserted === true, 'REPLAY_ASSERTION_FAILED');
      this.phase = 'asserted'; return true;
    }).catch((): boolean => {
      if (!this.invalidated) {
        this.invalidate('aborted', this.assertion === 'failed' ? 'REPLAY_ASSERTION_FAILED' : 'REPLAY_FAILED', false);
      }
      return false;
    }).finally(async (): Promise<void> => {
      this.executing = false;
      if (this.invalidated && this.needsRestore && !this.restoreAttempted) { await this.restoreOwned(); }
      this.releaseClosed(); this.changed();
    });
    try {
      const applied = await Promise.race([operation, cancelled]);
      return applied && this.current() && this.phase === 'asserted';
    }
    finally { clearTimeout(timeout); this.waiting = undefined; }
  }
  cancel(): void {
    this.observe(); this.invalidate('aborted', this.reason || 'REPLAY_CANCELLED');
    if (this.needsRestore && !this.executing && !this.restoring && !this.restoreAttempted) { void this.restoreOwned(); }
    this.changed();
  }
  dispose(): void { this.closed = true; this.cancel(); this.releaseClosed(); }
  async retryRestore(): Promise<boolean> {
    this.observe(); this.invalidate('aborted', this.reason || 'REPLAY_CANCELLED');
    if (!this.needsRestore) { return this.revocation === 'revoked'; }
    return this.restoreOwned();
  }
  status(): ReplayStatus {
    this.observe();
    const status: ReplayStatus = { phase: this.phase, reason: this.reason, commandId: this.grant?.commandId ?? '',
      planHash: !this.invalidated && ['review', 'confirmed'].includes(this.phase) ? this.grant?.planHash ?? '' : '',
      assertion: this.assertion, nativePending: this.executing || this.restoring, pendingCleanup: this.needsRestore ? 1 : 0,
      revocation: this.revocation, authentication: 'unverified' };
    return status;
  }
  private validStep(step: SemanticReplayStep): boolean {
    return step !== null && typeof step === 'object' && Object.keys(step).length === 6 &&
      Object.keys(step).every((key: string): boolean =>
        ['kind', 'actionId', 'dataRef', 'assertionId', 'expected', 'waitMs'].includes(key)) &&
      ['action', 'input', 'route', 'wait', 'assert'].includes(step.kind) &&
      typeof step.actionId === 'string' && match(step.actionId, '^test[.][a-z0-9][a-z0-9.-]{0,63}$') &&
      typeof step.assertionId === 'string' && match(step.assertionId, '^test[.][a-z0-9][a-z0-9.-]{0,63}$') &&
      typeof step.dataRef === 'string' && (step.dataRef === '' || match(step.dataRef, '^test:[a-z0-9][a-z0-9-]{0,63}$')) &&
      typeof step.expected === 'string' && match(step.expected, '^test:[a-z0-9][a-z0-9-]{0,63}$') &&
      Number.isInteger(step.waitMs) && step.waitMs > 0 && step.waitMs <= 3000;
  }
  private descriptors(step: SemanticReplayStep): string {
    const values = this.host?.descriptors();
    requireWire(values !== undefined && values.length > 0 && values.length <= 64, 'REPLAY_ADAPTER_REQUIRED');
    if (values === undefined) { throw new Error('REPLAY_ADAPTER_REQUIRED'); }
    requireWire(canonical(values).length <= 32768 && values.some((value: ReplayDescriptor): boolean =>
      value.kind === step.kind && value.actionId === step.actionId && value.assertionId === step.assertionId &&
      value.dataRefs.length <= 16 && value.expectations.length <= 16 &&
      value.dataRefs.includes(step.dataRef) && value.expectations.includes(step.expected)), 'REPLAY_ACTION_UNREGISTERED');
    return this.crypto.hash(canonical(values));
  }
  private readSource(): ReplaySource | undefined {
    try {
      const source = this.source();
      if (source === undefined || source.buildBinding !== 'local-artifact' ||
        typeof source.buildId !== 'string' || source.buildId.length === 0 || source.buildId.length > 512 ||
        source.buildId.startsWith('unverified:') || !match(source.sourceHash, '^[a-f0-9]{64}$') ||
        !match(source.binding, '^[a-f0-9]{64}$') || !match(source.windowId, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') ||
        !Number.isSafeInteger(source.deadline) || source.deadline <= 0) { return undefined; }
      return JSON.parse(JSON.stringify(source)) as ReplaySource;
    } catch { return undefined; }
  }
  private sourceCurrent(): boolean {
    try {
      const current = this.readSource();
      const original = this.originalSource;
      return current !== undefined && original !== undefined && canonical(current) === canonical(original) &&
        this.step !== undefined && this.descriptors(this.step) === this.descriptorHash;
    } catch { return false; }
  }
  private observe(): void {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.lastTime) {
      this.clockInvalid = true; this.invalidate('aborted', 'REPLAY_CLOCK_INVALID');
    } else { this.lastTime = now; }
    if (this.grant !== undefined && (!this.invalidated || this.needsRestore)) {
      if (!this.sourceCurrent()) {
        this.sourceInvalid = true; this.revocation = this.needsRestore ? 'source-invalid' : 'not-needed';
        this.invalidate('aborted', 'REPLAY_SOURCE_CHANGED');
      } else if (!this.invalidated && now >= this.grant.expiresAt) { this.invalidate('aborted', 'REPLAY_EXPIRED'); }
    }
    if (this.invalidated && this.needsRestore && !this.executing && !this.restoring && !this.restoreAttempted &&
      !this.sourceInvalid) { void this.restoreOwned(); }
  }
  private current(): boolean { this.observe(); return !this.invalidated; }
  private invalidate(phase: string, reason: string, wake: boolean = true): void {
    this.invalidated = true; this.phase = phase; this.reason = reason;
    clearTimeout(this.timer); this.timer = -1;
    if (wake) { const waiting = this.waiting; this.waiting = undefined; waiting?.(); }
  }
  private async restoreOwned(): Promise<boolean> {
    if (!this.needsRestore || this.executing || this.restoring || this.host === undefined || this.grant === undefined ||
      this.sourceInvalid) { return false; }
    if (!this.sourceCurrent()) {
      this.sourceInvalid = true; this.revocation = 'source-invalid'; return false;
    }
    const host = this.host, commandId = this.grant.commandId;
    this.restoreAttempted = true; this.restoring = true; this.revocation = 'restoring';
    let timeout: number = -1, timedOut = false;
    const stopped = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true; this.revocation = 'cleanup-failed'; this.changed(); resolve(false);
      }, 3000);
    });
    const operation = Promise.resolve().then((): Promise<boolean> => {
      if (!this.sourceCurrent()) { this.sourceInvalid = true; }
      requireWire(!this.sourceInvalid, 'REPLAY_SOURCE_CHANGED');
      return host.restore(commandId);
    })
      .then((accepted: boolean): boolean => {
        if (!this.sourceCurrent()) { this.sourceInvalid = true; }
        if (timedOut || this.sourceInvalid) { return false; }
        return accepted === true;
      }).catch((): boolean => false).then((restored: boolean): boolean => {
        this.needsRestore = !restored;
        this.revocation = restored ? 'revoked' : this.sourceInvalid ? 'source-invalid' : 'cleanup-failed';
        return restored;
      }).finally((): void => {
        clearTimeout(timeout); this.restoring = false; this.releaseClosed(); this.changed();
      });
    return Promise.race([operation, stopped]);
  }
  private releaseClosed(): void {
    if (this.closed && !this.executing && !this.restoring && !this.needsRestore) {
      this.host = undefined; this.step = undefined; this.originalSource = undefined;
    }
  }
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.observe(); if (!this.invalidated) { this.schedule(); } this.changed();
    }, Math.max(0, Math.min(250, (this.grant?.expiresAt ?? Date.now()) - Date.now())));
  }
  private uuid(): string {
    const random = this.crypto.random(16); requireWire(random.length === 16, 'REPLAY_UNAVAILABLE');
    random[6] = (random[6] & 15) | 64; random[8] = (random[8] & 63) | 128;
    const text = hex(random); random.fill(0);
    return text.slice(0, 8) + '-' + text.slice(8, 12) + '-' + text.slice(12, 16) + '-' +
      text.slice(16, 20) + '-' + text.slice(20);
  }
}
