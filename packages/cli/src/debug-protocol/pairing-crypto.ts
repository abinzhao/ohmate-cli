/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { hashContract } from './canonical-hash.js';
import { negotiateReadonly } from './handshake.js';
import { securityError } from './security-schemas.js';
import type { PairingInvitation, PairingRequest } from './security-schemas.js';

export function ephemeralKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
export function pairingTranscript(invitation: PairingInvitation, request: Omit<PairingRequest, 'proof'>): string {
  return hashContract({
    domain: 'ohmate/debug/pairing/1', suite: invitation.suite, pairingId: invitation.pairingId,
    fingerprint: invitation.fingerprint, expiresAt: invitation.expiresAt,
    serverKey: invitation.publicKey, serverChallenge: invitation.challenge,
    clientKey: request.publicKey, clientChallenge: request.challenge,
    negotiated: negotiateReadonly(invitation.handshake, request.handshake), appConfirmed: request.appConfirmed,
  });
}
export function pairingProof(code: string, role: 'kit' | 'cli', transcript: string): string {
  return createHmac('sha256', Buffer.from(code, 'base64')).update(`ohmate/debug/pairing/1/${role}/${transcript}`).digest('hex');
}
export function equalProof(value: string, expected: string): boolean {
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
export function sharedKeys(privateKey: KeyObject, remote: string, transcript: string) {
  let material: Buffer;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(remote, 'base64'), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw securityError('PAIRING_INVALID');
    }
    material = diffieHellman({ privateKey, publicKey });
  } catch { throw securityError('PAIRING_INVALID'); }
  const derive = (direction: string) => Buffer.from(hkdfSync('sha256', material, Buffer.from(transcript, 'hex'),
    Buffer.from(`ohmate/debug/1/${direction}`), 32));
  try { return { kitToCli: derive('kit-to-cli'), cliToKit: derive('cli-to-kit') }; }
  finally { material.fill(0); }
}
