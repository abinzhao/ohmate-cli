/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export {
  ChannelSchema,
  IdentitySchema,
  PayloadSchemas,
} from './domain-schemas.js';
export type { Channel, Identity } from './domain-schemas.js';
export {
  CURRENT_PROTOCOL_VERSION,
  PREVIOUS_PROTOCOL_VERSION,
  ProtocolVersionSchema,
  ProtocolVersionRangeSchema,
  BudgetSchema,
  ChannelOfferSchema,
  HandshakeSchema,
  createHandshake,
  negotiateReadonly,
} from './handshake.js';
export type {
  Handshake,
  HandshakeOptions,
  ChannelOffer,
  NegotiatedReadonly,
} from './handshake.js';
export {
  EventEnvelopeSchema,
  EventBatchSchema,
  EVENT_BATCH_LIMIT,
  AckSchema,
  ResumeSchema,
  ClockSchema,
  RedactionSchema,
} from './envelopes.js';
export type { EventEnvelope, Ack, Resume, Clock } from './envelopes.js';
export { ProtocolError } from './protocol-error.js';
export { describeReadonlyProtocol, describeWriteProtocol } from './contract.js';
export type { ProtocolErrorCode, GapDetails } from './protocol-error.js';
export { advanceClock } from './clock-segments.js';
export type { ClockSegment } from './clock-segments.js';
export { alignClock, validateClockSample, ClockProbeSchema, ClockReplySchema,
  ClockSampleSchema, ClockObservationSchema, ClockAlignmentSchema } from './clock-calibration.js';
export type { ClockSample, ClockObservation, ClockAlignment } from './clock-calibration.js';
export { ReadonlyBridge, createReadonlyBridge } from './readonly-bridge.js';
export type {
  BridgeState,
  BridgeOptions,
  BridgeStatus,
  AcceptedEvent,
} from './readonly-bridge.js';
export { WriteCommandSchema, WriteReceiptSchema, WriteScopeSchema, WriteRevokeReasonSchema } from './write-schemas.js';
export type { WriteCommand, WriteReceipt, WriteScope, WriteRevokeReason } from './write-schemas.js';
export { WriteSession } from './write-session.js';
export type { WriteOperation, WriteReview } from './write-session.js';
