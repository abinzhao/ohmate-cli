/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ChannelSchema, PayloadSchemas } from './domain-schemas.js';
import { capabilitySchema, HandshakeSchema, BudgetSchema, CURRENT_PROTOCOL_VERSION, PREVIOUS_PROTOCOL_VERSION } from './handshake.js';
import { EventEnvelopeSchema, EventBatchSchema, EVENT_BATCH_LIMIT, AckSchema, ResumeSchema } from './envelopes.js';
import { hashContract } from './canonical-hash.js';
import { ClockProbeSchema, ClockReplySchema, ClockAlignmentSchema } from './clock-calibration.js';
import { WriteCommandSchema, WriteReceiptSchema, WriteScopeSchema, writeRequiresRollback,
  MAX_WRITE_COMMANDS, MAX_WRITE_TTL_MS } from './write-schemas.js';

export function describeReadonlyProtocol() {
  return {
    mode: 'readonly',
    protocolVersionRange: { min: PREVIOUS_PROTOCOL_VERSION, max: CURRENT_PROTOCOL_VERSION },
    compression: ['none'],
    channels: ChannelSchema.options.map((channel) => ({
      channel, channelVersion: '1.0', capability: `${channel}.read`,
      schemaHash: hashContract(z.toJSONSchema(PayloadSchemas[channel])),
      capabilityHash: hashContract(z.toJSONSchema(capabilitySchema(channel))),
    })),
    schemas: {
      handshake: z.toJSONSchema(HandshakeSchema), event: z.toJSONSchema(EventEnvelopeSchema),
      eventBatch: z.toJSONSchema(EventBatchSchema),
      ack: z.toJSONSchema(AckSchema), resume: z.toJSONSchema(ResumeSchema), budget: z.toJSONSchema(BudgetSchema),
      clockProbe: z.toJSONSchema(ClockProbeSchema), clockReply: z.toJSONSchema(ClockReplySchema),
      clockAlignment: z.toJSONSchema(ClockAlignmentSchema),
    },
    clock: { optIn: 'encrypted-ready.clockSync=four-timestamp-v1', uncertaintyBudgetMs: 10,
      validityMs: 10000, refreshAfterMs: 5000, relativeDriftCeilingPpm: 1000,
      attestation: 'none', legacyMergeable: 'eligibility-only' },
    eventBatch: { optIn: 'encrypted-ready.eventBatch=events-v1', maxEvents: EVENT_BATCH_LIMIT,
      acknowledgement: 'durable-cumulative', frameBudget: 'negotiated-maxFrame' },
    validation: 'Structural JSON Schema plus negotiateReadonly/ReadonlyBridge state and identity checks',
  };
}

export function describeWriteProtocol() {
  return {
    version: '1', mode: 'application-local', authentication: 'unavailable', authenticationRecovery: 'disabled',
    maxCommandsPerSession: MAX_WRITE_COMMANDS, maxTtlMs: MAX_WRITE_TTL_MS,
    consoleTermination: 'not-guaranteed', persistence: 'hash-only-receipts-in-memory',
    scopes: WriteScopeSchema.options.map((scope) => ({
      scope, available: false, reason: 'DEVICE_BUILD_UNVERIFIED',
      risk: scope === 'arkweb.console.execute' || scope === 'arkweb.storage.write' ? 'R3' : 'R2',
      rollbackRequired: writeRequiresRollback(scope), confirmation: 'each-command-in-application',
    })),
    schemas: { command: z.toJSONSchema(WriteCommandSchema), receipt: z.toJSONSchema(WriteReceiptSchema) },
  };
}
