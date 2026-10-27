/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { HandshakeSchema } from '../debug-protocol/handshake.js';
import { EventEnvelopeSchema, EVENT_BATCH_LIMIT } from '../debug-protocol/envelopes.js';
import { HashSchema, IdentifierSchema } from '../debug-protocol/domain-schemas.js';
import { ClockSegmentSchema } from '../debug-protocol/clock-segments.js';

const LegacyManifestSchema = z.strictObject({
  schemaVersion: z.literal('1.1'), sessionId: z.string().uuid(), streamId: z.string().uuid(),
  authentication: z.literal('pairing-proof'), buildVerification: z.literal('unverified'),
  deviceProvenance: z.literal('peer-asserted'), handshake: HandshakeSchema,
  maxBytes: z.number().int().min(16384).max(5 * 1024 * 1024),
  maxEvents: z.number().int().min(1).max(4096),
});
export const JournalManifestSchema = z.discriminatedUnion('schemaVersion', [
  LegacyManifestSchema,
  LegacyManifestSchema.extend({ schemaVersion: z.literal('1.2'), peer: HandshakeSchema }),
  LegacyManifestSchema.extend({ schemaVersion: z.literal('1.3'), peer: HandshakeSchema,
    storage: z.literal('segments-v1') }),
  LegacyManifestSchema.extend({ schemaVersion: z.literal('1.4'), peer: HandshakeSchema,
    storage: z.literal('segments-v1'), retention: z.literal('rolling-v1') }),
]);
export const JournalEpochsSchema = z.array(IdentifierSchema).min(1).max(24)
  .refine((epochs) => new Set(epochs).size === epochs.length);
export const JournalClockSchema = ClockSegmentSchema;
export const JournalEventSchema = z.strictObject({
  index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previousHash: HashSchema,
  sourceDigest: HashSchema, resumeDigest: HashSchema.optional(), event: EventEnvelopeSchema, clock: JournalClockSchema,
  hash: HashSchema,
});
const LegacySegmentSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), from: z.number().int().positive().max(4096),
  through: z.number().int().positive().max(4096),
  bytes: z.number().int().positive().max(512 * 1024),
  records: z.array(JournalEventSchema).min(1).max(EVENT_BATCH_LIMIT), hash: HashSchema,
});
export const JournalSegmentSchema = z.discriminatedUnion('schemaVersion', [
  LegacySegmentSchema,
  LegacySegmentSchema.extend({ schemaVersion: z.literal('1.1'),
    from: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    through: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
]);
export const JournalRetentionSchema = z.strictObject({
  anchor: z.strictObject({ index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    hash: HashSchema, sourceDigest: HashSchema, resumeDigest: HashSchema,
    sessionEpoch: IdentifierSchema, clock: JournalClockSchema }).nullable(),
  cleanupPending: z.boolean(),
  cleanup: z.strictObject({ name: z.string().regex(/^\d{16}-\d{16}\.seg$/), digest: HashSchema }).nullable(),
}).refine((value) => value.cleanupPending === (value.cleanup !== null) && (!value.cleanupPending || value.anchor !== null));
const LegacyCheckpointSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), manifestHash: HashSchema,
  index: z.number().int().min(0).max(4096), lastHash: HashSchema,
  bytes: z.number().int().positive().max(5 * 1024 * 1024),
});
export const JournalCheckpointSchema = z.discriminatedUnion('schemaVersion', [
  LegacyCheckpointSchema,
  LegacyCheckpointSchema.extend({ schemaVersion: z.literal('1.1'), epochs: JournalEpochsSchema }),
  LegacyCheckpointSchema.extend({ schemaVersion: z.literal('1.2'), epochs: JournalEpochsSchema,
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), retention: JournalRetentionSchema }),
]);
export type JournalManifest = z.infer<typeof JournalManifestSchema>;
export type JournalEvent = z.infer<typeof JournalEventSchema>;
export type JournalCheckpoint = z.infer<typeof JournalCheckpointSchema>;
export type JournalRetention = z.infer<typeof JournalRetentionSchema>;
