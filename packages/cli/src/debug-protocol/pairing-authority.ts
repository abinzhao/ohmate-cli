/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { IdentitySchema } from './domain-schemas.js';
import type { Identity } from './domain-schemas.js';
import { createHandshake, negotiateReadonly } from './handshake.js';
import { hashContract } from './canonical-hash.js';
import { ephemeralKey, equalProof, pairingProof, pairingTranscript, sharedKeys } from './pairing-crypto.js';
import { SecureChannel } from './secure-channel.js';
import { PairingRequestSchema, SECURITY_SUITE, parseSecurity, securityError } from './security-schemas.js';
import type { PairingInvitation, PairingReply } from './security-schemas.js';

export interface PairingOptions {
  now?: () => number; pairingTtlMs?: number; sessionTtlMs?: number; maxFrames?: number; maxPending?: number;
}
interface Pending { invitation: PairingInvitation; privateKey: KeyObject }
export class PairingAuthority {
  readonly fingerprint: string;
  private readonly pending = new Map<string, Pending>();
  private readonly channels = new Set<SecureChannel>();
  private closed = false;
  private readonly now: () => number;
  private readonly pairingTtl: number;
  private readonly sessionTtl: number;
  private readonly maxFrames: number;
  private readonly maxPending: number;
  constructor(options: PairingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pairingTtl = options.pairingTtlMs ?? 120_000;
    this.sessionTtl = options.sessionTtlMs ?? 600_000;
    this.maxFrames = options.maxFrames ?? 65536;
    this.maxPending = options.maxPending ?? 8;
    if (![this.pairingTtl, this.sessionTtl, this.maxFrames, this.maxPending].every((value) => Number.isSafeInteger(value) && value > 0) ||
      this.pairingTtl > 120_000 || this.sessionTtl > 600_000 || this.maxFrames > 65536 || this.maxPending > 8) {
      throw securityError('INVALID_SCHEMA');
    }
    this.fingerprint = createHash('sha256').update(Buffer.from(ephemeralKey().publicKey, 'base64')).digest('hex');
  }
  issue(target: Omit<Identity, 'fingerprint'>): PairingInvitation {
    this.prune();
    if (this.closed) { throw securityError('INVALID_STATE'); }
    if (this.pending.size >= this.maxPending || this.channels.size >= 8) { throw securityError('PAIRING_LIMIT'); }
    const identity = parseSecurity(IdentitySchema, { ...target, fingerprint: this.fingerprint });
    const pair = ephemeralKey();
    const invitation: PairingInvitation = { type: 'pair-invitation', suite: SECURITY_SUITE, pairingId: randomUUID(),
      fingerprint: this.fingerprint, oneTimeCode: randomBytes(32).toString('base64'), publicKey: pair.publicKey,
      challenge: randomBytes(32).toString('base64'), expiresAt: this.now() + this.pairingTtl, handshake: createHandshake(identity) };
    this.pending.set(invitation.pairingId, { invitation, privateKey: pair.privateKey });
    return structuredClone(invitation);
  }
  accept(input: unknown) {
    this.prune();
    if (this.closed) { throw securityError('INVALID_STATE'); }
    // Consume by id even on invalid requests; a failed attempt requires a fresh application confirmation.
    const id = input && typeof input === 'object' && 'pairingId' in input ? input.pairingId : undefined;
    const pending = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (typeof id === 'string') { this.pending.delete(id); }
    if (!pending) { throw securityError('PAIRING_INVALID'); }
    const request = parseSecurity(PairingRequestSchema, input);
    const transcript = pairingTranscript(pending.invitation, request);
    if (!equalProof(request.proof, pairingProof(pending.invitation.oneTimeCode, 'kit', transcript))) {
      throw securityError('PAIRING_INVALID');
    }
    const negotiated = negotiateReadonly(pending.invitation.handshake, request.handshake);
    const limits = { connectionId: hashContract({ transcript, nonce: randomBytes(32).toString('hex') }),
      expiresAt: this.now() + this.sessionTtl, maxFrames: this.maxFrames, maxFrame: negotiated.maxFrame };
    const reply: PairingReply = { type: 'pair-reply', pairingId: request.pairingId, connectionId: limits.connectionId,
      expiresAt: limits.expiresAt, maxFrames: limits.maxFrames,
      proof: pairingProof(pending.invitation.oneTimeCode, 'cli', hashContract({ transcript, limits })) };
    const channel = new SecureChannel('cli', sharedKeys(pending.privateKey, request.publicKey, transcript), limits, this.now);
    this.channels.add(channel);
    return { reply, channel, negotiated, handshake: pending.invitation.handshake, peer: request.handshake };
  }
  release(channel: SecureChannel): void { channel.close(); this.channels.delete(channel); }
  close(): void {
    this.closed = true; this.pending.clear();
    for (const channel of this.channels) { channel.close(); }
    this.channels.clear();
  }
  private prune(): void {
    for (const [id, value] of this.pending) {
      if (value.invitation.expiresAt <= this.now()) { this.pending.delete(id); }
    }
  }
}
