/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { IdentitySchema, type Identity } from './domain-schemas.js';
import { hashContract } from './canonical-hash.js';
import { WriteCommandSchema, WriteReceiptSchema, WriteRevokeReasonSchema, writeRequiresRollback,
  MAX_WRITE_COMMANDS, MAX_WRITE_TTL_MS } from './write-schemas.js';
import type { WriteCommand, WriteReceipt, WriteRevokeReason } from './write-schemas.js';

export interface WriteOperation {
  execute(signal: AbortSignal): Promise<void>;
  rollback?(): Promise<void>;
}
export interface WriteReview {
  reviewId: string; command: WriteCommand; expiresAt: number;
}
interface ReviewOwner extends WriteReview { digest: string }
interface CommandOwner {
  command: WriteCommand; digest: string; controller: AbortController; operation: WriteOperation;
  receipt: WriteReceipt; done: Promise<void>; timer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>; invalidated: boolean; needsRollback: boolean;
  expiresAt: number; cleanupAttempts: number; executionError: string | null;
}

// Application-local consent only. This owner does not attest peers or enable bridge writes.
export class WriteSession {
  private readonly identity: Identity;
  private readonly reviews = new Map<string, ReviewOwner>();
  private readonly grants = new Map<string, ReviewOwner>();
  private readonly commands = new Map<string, CommandOwner>();
  private readonly commandIds = new Map<string, string>();
  private state: 'open' | 'revoked' | 'cleanup-failed' = 'open';
  private lastTime = 0;
  private readonly expiresAt: number;
  constructor(identity: Identity, private readonly epoch: string) {
    this.identity = IdentitySchema.parse(identity);
    WriteCommandSchema.shape.sessionEpoch.parse(epoch);
    const now = Date.now();
    if (Number.isSafeInteger(now)) { this.lastTime = now; }
    else { this.state = 'revoked'; }
    this.expiresAt = Math.min(this.lastTime + MAX_WRITE_TTL_MS, Number.MAX_SAFE_INTEGER);
  }
  status() {
    this.now();
    return { state: this.state, authentication: 'not-authenticated', consent: 'application-local-memory-only',
      pendingCleanup: [...this.commands.values()].filter((owner) => owner.needsRollback).length };
  }
  receipts(): WriteReceipt[] {
    this.now();
    return [...this.commands.values()].map((owner) => structuredClone(owner.receipt));
  }
  review(input: unknown): WriteReview {
    const now = this.now(), command = WriteCommandSchema.parse(input);
    const error = this.denial(command, now);
    if (error) { throw new Error(error); }
    this.pruneReviews(now);
    if (this.reviews.size + this.grants.size >= MAX_WRITE_COMMANDS) { throw new Error('WRITE_QUOTA'); }
    const review: ReviewOwner = { reviewId: randomUUID(), command, digest: hashContract(command),
      expiresAt: Math.min(command.deadline, now + command.ttlMs, this.expiresAt) };
    this.reviews.set(review.reviewId, review);
    return structuredClone({ reviewId: review.reviewId, command, expiresAt: review.expiresAt });
  }
  confirm(reviewId: string): void {
    const now = this.now();
    const review = this.reviews.get(reviewId);
    if (!review) { throw new Error('REVIEW_UNAVAILABLE'); }
    this.reviews.delete(reviewId);
    if (now >= review.expiresAt) { throw new Error('REVIEW_EXPIRED'); }
    const error = this.denial(review.command, now);
    if (error) { throw new Error(error); }
    this.grants.set(review.digest, review);
  }
  async apply(input: unknown, operation: WriteOperation): Promise<WriteReceipt> {
    const now = this.now();
    const parsed = WriteCommandSchema.safeParse(input);
    if (!parsed.success) { return this.blocked(null, 'INVALID_WRITE_COMMAND'); }
    const command = parsed.data, digest = hashContract(command);
    const existing = this.commands.get(command.idempotencyKey);
    if (existing) {
      if (existing.digest !== digest) { return this.blocked(command, 'COMMAND_CONFLICT'); }
      await existing.done;
      return structuredClone(existing.receipt);
    }
    if (this.commandIds.has(command.commandId)) { return this.blocked(command, 'COMMAND_CONFLICT'); }
    const error = this.denial(command, now) ?? this.admission(command, digest, operation, now);
    if (error) { return this.blocked(command, error); }
    return this.start(command, digest, operation, now);
  }
  private denial(command: WriteCommand, now: number): string | null {
    if (hashContract(command.identity) !== hashContract(this.identity) || command.sessionEpoch !== this.epoch) {
      return 'WRITE_IDENTITY_MISMATCH';
    }
    if (now >= command.deadline || now >= this.expiresAt) { return 'COMMAND_EXPIRED'; }
    return this.state === 'open' ? null : this.state === 'cleanup-failed' ? 'CLEANUP_REQUIRED' : 'WRITE_SESSION_REVOKED';
  }
  private admission(command: WriteCommand, digest: string, operation: WriteOperation, now: number): string | null {
    const grant = this.grants.get(digest);
    if (!grant || now >= grant.expiresAt) { return 'SCOPE_NOT_CONFIRMED'; }
    if (this.commands.size >= MAX_WRITE_COMMANDS) { return 'WRITE_QUOTA'; }
    if (writeRequiresRollback(command.scope) && typeof operation.rollback !== 'function') { return 'ROLLBACK_REQUIRED'; }
    if (typeof operation.execute !== 'function') { return 'INVALID_WRITE_OPERATION'; }
    if ([...this.commands.values()].some((owner) => owner.needsRollback &&
      owner.command.scope === command.scope && owner.command.targetId === command.targetId)) { return 'WRITE_BUSY'; }
    return null;
  }
  private async start(command: WriteCommand, digest: string, operation: WriteOperation, now: number): Promise<WriteReceipt> {
    const grant = this.grants.get(digest)!;
    this.grants.delete(digest);
    let finish!: () => void;
    const owner: CommandOwner = { command, digest, operation: { execute: operation.execute, rollback: operation.rollback },
      controller: new AbortController(), receipt: this.receipt(command, 'running', null),
      done: new Promise<void>((resolve) => { finish = resolve; }), invalidated: false, needsRollback: !!operation.rollback,
      expiresAt: grant.expiresAt, cleanupAttempts: 0, executionError: null };
    owner.receipt.revocation = owner.needsRollback ? 'active' : 'not-needed';
    this.commands.set(command.idempotencyKey, owner);
    this.commandIds.set(command.commandId, command.idempotencyKey);
    owner.timer = setTimeout(() => this.expire(owner), Math.max(0, owner.expiresAt - now));
    owner.timer.unref?.();
    try { await this.run(owner); }
    finally { owner.operation.execute = async () => {}; finish(); }
    return structuredClone(owner.receipt);
  }
  private async run(owner: CommandOwner): Promise<void> {
    try { await owner.operation.execute(owner.controller.signal); }
    catch {
      owner.receipt.status = owner.invalidated ? 'cancelled' : 'failed';
      owner.receipt.error = owner.invalidated ? 'WRITE_REVOKED' : 'EXECUTION_FAILED';
      owner.executionError = owner.receipt.error;
      this.invalidate(owner);
    }
    const now = this.now();
    if (owner.invalidated || this.state !== 'open' || now >= owner.expiresAt) {
      if (owner.receipt.status === 'running') {
        owner.receipt.status = 'cancelled'; owner.receipt.error = 'WRITE_REVOKED';
        owner.executionError = owner.receipt.error;
      }
      this.invalidate(owner);
      await this.restore(owner);
    } else { owner.receipt.status = 'applied'; }
  }
  private invalidate(owner: CommandOwner): void {
    owner.invalidated = true;
    clearTimeout(owner.timer);
    owner.controller.abort();
  }
  private expire(owner: CommandOwner): void {
    if (owner.invalidated) { return; }
    const attempts = owner.cleanupAttempts;
    this.invalidate(owner);
    void owner.done.then(() => this.restore(owner, attempts));
  }
  private restore(owner: CommandOwner, previousAttempts = owner.cleanupAttempts): Promise<void> {
    if (owner.cleanupAttempts !== previousAttempts) { return owner.cleanup ?? Promise.resolve(); }
    if (!owner.needsRollback) { return Promise.resolve(); }
    if (!owner.cleanup) {
      owner.cleanupAttempts++;
      owner.cleanup = this.rollback(owner).finally(() => { owner.cleanup = undefined; });
    }
    return owner.cleanup;
  }
  private async rollback(owner: CommandOwner): Promise<void> {
    try {
      await owner.operation.rollback!();
      owner.needsRollback = false; owner.receipt.revocation = 'revoked';
      owner.operation.rollback = undefined;
      if (owner.receipt.error === 'ROLLBACK_FAILED') { owner.receipt.error = owner.executionError; }
    } catch {
      this.state = 'cleanup-failed';
      this.reviews.clear(); this.grants.clear();
      owner.receipt.revocation = 'cleanup-failed'; owner.receipt.error = 'ROLLBACK_FAILED';
    }
  }
  async revoke(reason: WriteRevokeReason): Promise<void> {
    WriteRevokeReasonSchema.parse(reason);
    this.state = 'revoked'; this.reviews.clear(); this.grants.clear();
    const owners = [...this.commands.values()].map((owner) => ({ owner, attempts: owner.cleanupAttempts }));
    for (const { owner } of owners) { this.invalidate(owner); }
    for (const { owner, attempts } of owners) { await owner.done; await this.restore(owner, attempts); }
    if (owners.some(({ owner }) => owner.needsRollback)) { this.state = 'cleanup-failed'; }
  }
  async close(): Promise<void> { await this.revoke('service-closed'); }
  private now(): number {
    const now = Date.now();
    const valid = Number.isSafeInteger(now) && now >= this.lastTime;
    if (valid) { this.lastTime = now; }
    // Observation may revoke once, but polling must never retry failed restoration.
    if (this.state === 'open') {
      if (!valid || this.lastTime >= this.expiresAt) { void this.revoke('expired'); }
      else {
        for (const owner of this.commands.values()) {
          if (this.lastTime >= owner.expiresAt) { this.expire(owner); }
        }
      }
    }
    return this.lastTime;
  }
  private pruneReviews(now: number): void {
    for (const [id, review] of this.reviews) {
      if (now >= review.expiresAt) { this.reviews.delete(id); }
    }
    for (const [digest, grant] of this.grants) {
      if (now >= grant.expiresAt) { this.grants.delete(digest); }
    }
  }
  private blocked(command: WriteCommand | null, error: string): WriteReceipt {
    return this.receipt(command, 'blocked', error);
  }
  private receipt(command: WriteCommand | null, status: WriteReceipt['status'], error: string | null): WriteReceipt {
    return WriteReceiptSchema.parse({ type: 'write-receipt', version: '1', executor: 'application',
      commandId: command?.commandId ?? null, idempotencyKey: command?.idempotencyKey ?? null,
      identity: this.identity, sessionEpoch: this.epoch, scope: command?.scope ?? null,
      targetId: command?.targetId ?? null, impactHash: command?.planHash ?? null,
      status, revocation: 'not-needed', error });
  }
}
