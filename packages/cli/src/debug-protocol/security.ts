/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export { PairingAuthority } from './pairing-authority.js';
export type { PairingOptions } from './pairing-authority.js';
export { createPairingClient } from './pairing-client.js';
export type { PairingClientOptions } from './pairing-client.js';
export { SecureChannel } from './secure-channel.js';
export type { ChannelLimits } from './secure-channel.js';
export { pairingTranscript, pairingProof } from './pairing-crypto.js';
export {
  SECURITY_SUITE, PairingInvitationSchema, PairingRequestSchema,
  PairingReplySchema, SealedFrameSchema,
} from './security-schemas.js';
export type { PairingInvitation, PairingRequest, PairingReply, SealedFrame } from './security-schemas.js';
