/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';

export const IdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const buildIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/)
  .refine((value) => !/[\r\n]/.test(value));
export const CounterSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const summary = z.string().max(1024);
const duration = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const level = z.enum(['critical', 'error', 'warn', 'info', 'debug', 'verbose']);
const bodyMetadata = z.strictObject({
  captured: z.literal(false),
  byteLength: CounterSchema,
});
const network = z.strictObject({
  requestId: IdentifierSchema,
  method: z.enum([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
    'CONNECT',
    'TRACE',
  ]),
  status: z.number().int().min(100).max(599).optional(),
  durationMs: duration,
  bodyMetadata: bodyMetadata.optional(),
});
const log = z.strictObject({ level, summary });

export const COOKIE_METADATA_SUMMARY =
  'url-related-incognito-unpartitioned;attributes-not-captured;local-session-disabled;' +
  'indexeddb-cache-not-supported;quota-unavailable;[MEMORY_ONLY]';

// Only redacted domain summaries cross this boundary, never internal objects.
export const PayloadSchemas = {
  session: z.strictObject({
    state: z.enum(['recording', 'paused', 'stopped']),
    summary,
  }),
  health: z.strictObject({
    status: z.enum(['healthy', 'degraded', 'unavailable']),
    summary,
  }),
  'arkweb.dom': z.strictObject({
    targetId: IdentifierSchema,
    nodeCount: CounterSchema,
    summary,
  }),
  'arkweb.network': network,
  'arkweb.storage': z.strictObject({
    targetId: IdentifierSchema,
    entryCount: CounterSchema,
    summary,
  }),
  'arkweb.console': log,
  'app.network': network,
  ui: z.strictObject({
    windowId: IdentifierSchema,
    nodeCount: CounterSchema,
    summary,
  }),
  hilog: log,
  hiappevent: z.strictObject({ eventName: IdentifierSchema, summary }),
  hitrace: z.strictObject({
    traceId: IdentifierSchema,
    spanId: IdentifierSchema,
    durationMs: duration,
  }),
  hichecker: z.strictObject({ ruleId: IdentifierSchema, summary }),
  hidebug: z.strictObject({
    metric: z.enum(['cpuPercent', 'pssBytes', 'heapBytes']),
    value: duration,
  }),
  faultlog: z.strictObject({
    faultId: IdentifierSchema,
    kind: z.enum(['jscrash', 'cppcrash', 'freeze']),
    summary,
  }),
  jsleak: z.strictObject({
    snapshotId: IdentifierSchema,
    suspectedCount: CounterSchema,
    summary,
  }),
  instrumentation: z.strictObject({
    eventName: IdentifierSchema,
    traceId: IdentifierSchema.optional(),
    summary,
  }),
  problems: z.strictObject({
    problemId: IdentifierSchema,
    severity: level,
    summary,
  }),
};

export type Channel = keyof typeof PayloadSchemas;
export const ChannelSchema = z.enum(
  Object.keys(PayloadSchemas) as [Channel, ...Channel[]]
);
export const IdentitySchema = z.strictObject({
  project: IdentifierSchema,
  buildId: buildIdSchema,
  device: IdentifierSchema,
  process: IdentifierSchema,
  sessionId: IdentifierSchema,
  fingerprint: HashSchema,
});
export type Identity = z.infer<typeof IdentitySchema>;
