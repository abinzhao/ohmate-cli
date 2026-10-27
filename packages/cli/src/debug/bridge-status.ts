/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { IdentitySchema, HashSchema } from '../debug-protocol/domain-schemas.js';
import { ForwardBindingSchema } from './hdc-forward.js';

export const BridgeStatusSchema = z.strictObject({
  state: z.enum(['waiting-pairing', 'pairing', 'connected', 'disconnected', 'revoked', 'expired', 'degraded']),
  transport: z.literal('websocket-loopback'), lan: z.literal('disabled'),
  authentication: z.enum(['unpaired', 'pairing-proof']),
  buildVerification: z.literal('unverified'), deviceProvenance: z.literal('peer-asserted'),
  fingerprint: HashSchema, target: IdentitySchema.nullable(),
  streamId: z.string().uuid().nullable(), ackThrough: z.number().int().nonnegative(),
  hdcForward: ForwardBindingSchema.optional(),
  reason: z.string().regex(/^[A-Z0-9_:-]{1,128}$/).nullable(),
  gap: z.strictObject({ missingFrom: z.number().int().positive(), missingThrough: z.number().int().positive() }).nullable(),
});
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;
export function initialBridgeStatus(fingerprint: string): BridgeStatus {
  return { state: 'waiting-pairing', transport: 'websocket-loopback', lan: 'disabled', authentication: 'unpaired',
    buildVerification: 'unverified', deviceProvenance: 'peer-asserted', fingerprint,
    target: null, streamId: null, ackThrough: 0, reason: 'KIT_PRODUCER_NOT_VERIFIED', gap: null };
}
