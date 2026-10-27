/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { HashSchema } from './domain-schemas.js';
import { HandshakeSchema } from './handshake.js';
import { ProtocolError } from './protocol-error.js';

export const SECURITY_SUITE = 'P256-HKDF-SHA256-AES256-GCM';
const base64 = z.string().min(4).max(1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const challenge = base64.refine((value) => Buffer.from(value, 'base64').length === 32);
export const PairingInvitationSchema = z.strictObject({
  type: z.literal('pair-invitation'), suite: z.literal(SECURITY_SUITE),
  pairingId: z.string().uuid(), fingerprint: HashSchema,
  oneTimeCode: challenge, publicKey: base64, challenge,
  expiresAt: z.number().int().positive(), handshake: HandshakeSchema,
}).refine((value) => value.fingerprint === value.handshake.identity.fingerprint);
export const PairingRequestSchema = z.strictObject({
  type: z.literal('pair-request'), pairingId: z.string().uuid(),
  publicKey: base64, challenge, handshake: HandshakeSchema,
  appConfirmed: z.literal(true), proof: HashSchema,
});
export const PairingReplySchema = z.strictObject({
  type: z.literal('pair-reply'), pairingId: z.string().uuid(),
  connectionId: HashSchema, expiresAt: z.number().int().positive(),
  maxFrames: z.number().int().min(1).max(65536), proof: HashSchema,
});
export const SealedFrameSchema = z.strictObject({
  type: z.literal('sealed'), version: z.literal('1'),
  connectionId: HashSchema, direction: z.enum(['kit-to-cli', 'cli-to-kit']),
  counter: z.number().int().positive().max(65536),
  ciphertext: z.string().max(1398104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  tag: base64.refine((value) => Buffer.from(value, 'base64').length === 16),
});
export type PairingInvitation = z.infer<typeof PairingInvitationSchema>;
export type PairingRequest = z.infer<typeof PairingRequestSchema>;
export type PairingReply = z.infer<typeof PairingReplySchema>;
export type SealedFrame = z.infer<typeof SealedFrameSchema>;

export function securityError(code: string): Error {
  // Protocol security failures never retain untrusted input or cryptographic material.
  const error = new Error(code);
  error.name = 'BridgeSecurityError';
  return error;
}
export function parseSecurity<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) { throw new ProtocolError('INVALID_SCHEMA'); }
  return parsed.data;
}
