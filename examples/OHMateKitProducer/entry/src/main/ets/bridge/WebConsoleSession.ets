/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { webview } from '@kit.ArkWeb';
import { CryptoPort, canonical, hex, requireWire } from './Wire';

export interface ConsoleReview {
  scope: string; risk: string; targetId: string; commandId: string; planHash: string;
  codeHash: string; codeBytes: number; expiresAt: number; preemption: string;
}
export interface ConsoleResult { resultType: string; bytes: number; summary: string; }
export interface ConsoleStatus extends ConsoleResult {
  phase: string; commandId: string; reason: string; nativePending: boolean; authentication: string;
}
export class ConsoleWaitTimeout extends Error {
  constructor() { super('WEB_CONSOLE_TIMEOUT'); }
}
export class WebConsoleSession {
  private crypto: CryptoPort;
  private activeSource: () => boolean;
  private busySource: () => boolean;
  private cancelWait: () => void;
  private reviewValue: ConsoleReview | undefined = undefined;
  private code: string = '';
  private phase: string = 'idle';
  private reason: string = '';
  private result: ConsoleResult = { resultType: '', bytes: 0, summary: '' };
  private revision: number = 0;
  private attempts: number = 0;
  private commandIds: string[] = [];
  private lastTime: number = Date.now();
  private lastExecution: number = -1;
  private totalBytes: number = 0;

  constructor(crypto: CryptoPort, active: () => boolean, busy: () => boolean, cancel: () => void) {
    this.crypto = crypto; this.activeSource = active; this.busySource = busy; this.cancelWait = cancel;
  }
  private size(text: string): number {
    requireWire(typeof text === 'string' && text.length <= 4096, 'CONSOLE_CODE_INVALID');
    const bytes = this.crypto.encode(text);
    try {
      requireWire(bytes.length <= 4096 && this.crypto.decode(bytes) === text, 'CONSOLE_CODE_INVALID');
      return bytes.length;
    } finally { bytes.fill(0); }
  }
  review(code: string, binding: string, deadline: number, ttlMs: number): ConsoleReview {
    requireWire(!this.busySource(), 'CONSOLE_CAPTURE_BUSY');
    this.cancel();
    requireWire(this.timeValid() && this.available() && this.attempts < 256, 'CONSOLE_UNAVAILABLE');
    this.attempts++;
    const bytes = this.size(code);
    requireWire(code.trim().length > 0 && Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 600000,
      'CONSOLE_CODE_INVALID');
    const expiresAt = Math.min(deadline, Date.now() + ttlMs);
    requireWire(Number.isSafeInteger(expiresAt) && expiresAt > Date.now(), 'CONSOLE_UNAVAILABLE');
    const random = this.crypto.random(16);
    let commandId = '';
    try { requireWire(random.length === 16, 'CONSOLE_UNAVAILABLE'); commandId = hex(random); }
    finally { random.fill(0); }
    requireWire(!this.commandIds.includes(commandId), 'CONSOLE_UNAVAILABLE');
    this.commandIds.push(commandId);
    const codeHash = this.crypto.hash(code);
    const plan: Record<string, Object> = {
      'scope': 'arkweb.console.execute', 'risk': 'R3', 'targetId': 'web-main', 'commandId': commandId,
      'codeHash': codeHash, 'binding': binding, 'revision': this.revision, 'expiresAt': expiresAt, 'ttlMs': ttlMs
    };
    const review: ConsoleReview = { scope: 'arkweb.console.execute', risk: 'R3', targetId: 'web-main',
      commandId: commandId, codeHash: codeHash, codeBytes: bytes, planHash: this.crypto.hash(canonical(plan)),
      expiresAt: expiresAt, preemption: 'not-supported' };
    this.reviewValue = review; this.code = code; this.phase = 'review';
    return { scope: review.scope, risk: review.risk, targetId: review.targetId, commandId: review.commandId,
      codeHash: review.codeHash, codeBytes: review.codeBytes, planHash: review.planHash,
      expiresAt: review.expiresAt, preemption: review.preemption };
  }
  confirm(planHash: string): boolean {
    if (!this.current() || this.phase !== 'review' || this.reviewValue?.planHash !== planHash) { return false; }
    this.phase = 'confirmed'; return true;
  }
  async execute(planHash: string, executor: (code: string, active: () => boolean,
    project: (message: webview.JsMessageExt) => ConsoleResult) => Promise<ConsoleResult>): Promise<boolean> {
    if (!this.current() || this.phase !== 'confirmed' || this.busySource() ||
      this.reviewValue?.planHash !== planHash) { return false; }
    if (this.lastExecution >= 0 && Date.now() - this.lastExecution < 1000) { return false; }
    const revision = this.revision;
    const code = this.code;
    requireWire(this.crypto.hash(code) === this.reviewValue?.codeHash, 'CONSOLE_CODE_INVALID');
    this.lastExecution = Date.now(); this.code = ''; this.phase = 'running';
    try {
      return executor(code, (): boolean => this.current() && this.revision === revision,
        (message: webview.JsMessageExt): ConsoleResult => this.project(message)).then((result: ConsoleResult): boolean => {
        if (!this.current() || revision !== this.revision) { return false; }
        requireWire(this.totalBytes + result.bytes <= 65536, 'CONSOLE_RESULT_LIMIT');
        this.totalBytes += result.bytes; this.result = result; this.phase = 'completed';
        return true;
      }).catch((error: Error): boolean => this.failed(error, revision));
    } catch (error) {
      return this.failed(error as Error, revision);
    }
  }
  private failed(error: Error, revision: number): boolean {
    if (revision === this.revision && this.current()) {
      this.phase = error instanceof ConsoleWaitTimeout ? 'timeout' : 'failed';
      this.reason = this.phase === 'timeout' ? 'CONSOLE_WAIT_TIMEOUT' : 'CONSOLE_EXECUTION_FAILED';
    }
    return false;
  }
  private project(message: webview.JsMessageExt): ConsoleResult {
    const type = message.getType();
    let resultType = 'unsupported';
    let bytes = 0;
    if (type === webview.JsMessageType.STRING) {
      resultType = 'string'; bytes = this.size(message.getString());
    } else if (type === webview.JsMessageType.NUMBER) {
      requireWire(Number.isFinite(message.getNumber()), 'CONSOLE_RESULT_INVALID'); resultType = 'number';
    } else if (type === webview.JsMessageType.BOOLEAN) {
      requireWire(typeof message.getBoolean() === 'boolean', 'CONSOLE_RESULT_INVALID'); resultType = 'boolean';
    } else {
      requireWire([webview.JsMessageType.NOT_SUPPORT, webview.JsMessageType.ARRAY,
        webview.JsMessageType.ARRAY_BUFFER].includes(type), 'CONSOLE_RESULT_INVALID');
    }
    return { resultType: resultType, bytes: bytes, summary: '[MEMORY_ONLY]' };
  }
  cancel(): void {
    this.revision++; this.code = ''; this.reviewValue = undefined; this.phase = 'idle'; this.reason = '';
    this.result = { resultType: '', bytes: 0, summary: '' }; this.cancelWait();
  }
  status(): ConsoleStatus {
    this.current();
    return { phase: this.phase, commandId: this.reviewValue?.commandId ?? '', reason: this.reason,
      nativePending: this.busySource(), resultType: this.result.resultType, bytes: this.result.bytes,
      summary: this.result.summary, authentication: 'not-authenticated' };
  }
  private available(): boolean { try { return this.activeSource(); } catch { return false; } }
  private timeValid(): boolean {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < this.lastTime) { this.cancel(); return false; }
    this.lastTime = now; return true;
  }
  private current(): boolean {
    if (!this.timeValid() || !this.available() || this.reviewValue === undefined ||
      Date.now() >= this.reviewValue.expiresAt) { this.cancel(); return false; }
    return true;
  }
}
