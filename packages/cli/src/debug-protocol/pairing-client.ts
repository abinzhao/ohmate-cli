/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { hashContract } from './canonical-hash.js';
import { createHandshake, negotiateReadonly } from './handshake.js';
import type { HandshakeOptions } from './handshake.js';
import { ephemeralKey, equalProof, pairingProof, pairingTranscript, sharedKeys } from './pairing-crypto.js';
import { SecureChannel } from './secure-channel.js';
import { PairingInvitationSchema, PairingReplySchema, parseSecurity, securityError } from './security-schemas.js';
import type { PairingInvitation, PairingRequest } from './security-schemas.js';

export interface PairingClientOptions extends HandshakeOptions { appConfirmed: boolean; now?: () => number }
class PairingClient {
  private privateKey: KeyObject | null;
  private readonly invitation: PairingInvitation;
  private readonly outgoing: PairingRequest;
  private readonly transcript: string;
  private readonly now: () => number;
  constructor(input: unknown, options: PairingClientOptions) {
    if (options.appConfirmed !== true) { throw securityError('APP_CONFIRMATION_REQUIRED'); }
    this.invitation = parseSecurity(PairingInvitationSchema, input);
    this.now = options.now ?? Date.now;
    if (this.invitation.expiresAt <= this.now()) { throw securityError('PAIRING_INVALID'); }
    const pair = ephemeralKey(); this.privateKey = pair.privateKey;
    const request = { type: 'pair-request' as const, pairingId: this.invitation.pairingId,
      publicKey: pair.publicKey, challenge: randomBytes(32).toString('base64'),
      handshake: createHandshake(this.invitation.handshake.identity, options), appConfirmed: true as const };
    this.transcript = pairingTranscript(this.invitation, request);
    this.outgoing = { ...request, proof: pairingProof(this.invitation.oneTimeCode, 'kit', this.transcript) };
  }
  request(): PairingRequest { return structuredClone(this.outgoing); }
  finish(input: unknown): SecureChannel {
    if (!this.privateKey) { throw securityError('INVALID_STATE'); }
    const privateKey = this.privateKey; this.privateKey = null;
    const reply = parseSecurity(PairingReplySchema, input);
    const negotiated = negotiateReadonly(this.invitation.handshake, this.outgoing.handshake);
    const limits = { connectionId: reply.connectionId, expiresAt: reply.expiresAt, maxFrames: reply.maxFrames, maxFrame: negotiated.maxFrame };
    if (reply.pairingId !== this.invitation.pairingId || reply.expiresAt <= this.now() ||
      reply.expiresAt > this.now() + 600_000 ||
      !equalProof(reply.proof, pairingProof(this.invitation.oneTimeCode, 'cli', hashContract({ transcript: this.transcript, limits })))) {
      throw securityError('PAIRING_INVALID');
    }
    const channel = new SecureChannel('kit', sharedKeys(privateKey, this.invitation.publicKey, this.transcript), limits, this.now);
    this.invitation.oneTimeCode = '';
    return channel;
  }
}
export function createPairingClient(invitation: unknown, options: PairingClientOptions): PairingClient {
  return new PairingClient(invitation, options);
}
