/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import {
  CounterSchema,
  IdentifierSchema,
  IdentitySchema,
  PayloadSchemas,
} from './domain-schemas.js';
import type { Channel } from './domain-schemas.js';
import { ProtocolVersionSchema } from './handshake.js';

export const ClockSchema = z.strictObject({
  clockId: IdentifierSchema,
  bootId: IdentifierSchema,
  wallTimeUtc: z.iso.datetime(),
  monotonicNs: z
    .string()
    .regex(/^(0|[1-9]\d{0,19})$/)
    .pipe(z.string().refine((value) => BigInt(value) <= 18446744073709551615n)),
  offsetUncertaintyMs: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const RedactionSchema = z.strictObject({
  policyId: IdentifierSchema,
  fieldsRemoved: CounterSchema,
});
const scope = {
  ...IdentitySchema.shape,
  protocolVersion: ProtocolVersionSchema,
  sessionEpoch: IdentifierSchema,
};
function eventSchema<C extends Channel>(channel: C) {
  return z.strictObject({
    ...scope,
    channelVersion: z.literal('1.0'),
    messageId: IdentifierSchema,
    sequence: CounterSchema.refine((value) => value > 0),
    channel: z.literal(channel),
    type: z.literal('event'),
    capability: z.literal(`${channel}.read`),
    ...ClockSchema.shape,
    payload: PayloadSchemas[channel],
    redaction: RedactionSchema,
  });
}
export const EventEnvelopeSchema = z.discriminatedUnion('channel', [
  eventSchema('session'),
  eventSchema('health'),
  eventSchema('arkweb.dom'),
  eventSchema('arkweb.network'),
  eventSchema('arkweb.storage'),
  eventSchema('arkweb.console'),
  eventSchema('app.network'),
  eventSchema('ui'),
  eventSchema('hilog'),
  eventSchema('hiappevent'),
  eventSchema('hitrace'),
  eventSchema('hichecker'),
  eventSchema('hidebug'),
  eventSchema('faultlog'),
  eventSchema('jsleak'),
  eventSchema('instrumentation'),
  eventSchema('problems'),
]);
export const EVENT_BATCH_LIMIT = 64;
export const EventBatchSchema = z.strictObject({
  type: z.literal('event-batch'), version: z.literal('1'),
  events: z.array(EventEnvelopeSchema).min(1).max(EVENT_BATCH_LIMIT),
});
export const AckSchema = z.strictObject({
  ...scope,
  type: z.literal('ack'),
  ackThrough: CounterSchema,
});
export const ResumeSchema = z.strictObject({
  ...scope,
  type: z.literal('resume'),
  previousEpoch: IdentifierSchema,
  resumeFrom: CounterSchema.refine((value) => value > 0),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type Resume = z.infer<typeof ResumeSchema>;
export type Clock = z.infer<typeof ClockSchema>;
