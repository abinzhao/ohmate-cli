/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { ChannelSchema, HashSchema, IdentitySchema, IdentifierSchema } from '../debug-protocol/domain-schemas.js';
import { EventEnvelopeSchema } from '../debug-protocol/envelopes.js';
import { JournalClockSchema, JournalEpochsSchema } from '../debug/journal-schemas.js';
import { problemPath, PROBLEM_LIMITS } from './zip.js';
import { kitSchemas } from './kit-profile.js';

export const ProblemIdentitySchema = IdentitySchema.omit({ fingerprint: true });
const offlineEvents = EventEnvelopeSchema.options.map((option) => option.omit({ fingerprint: true }));
export const ProblemEventSchema = z.union(offlineEvents as [typeof offlineEvents[number], typeof offlineEvents[number], ...typeof offlineEvents[number][]]);
const clockEvents = offlineEvents.map((option) => option.extend({ clockEvidence: JournalClockSchema }));
export const ProblemClockEventSchema = z.union(clockEvents as [typeof clockEvents[number], typeof clockEvents[number], ...typeof clockEvents[number][]]);
const SummaryFileSchema = z.strictObject({
  path: z.string().refine((path) => { try { problemPath(path); return true; } catch { return false; } }),
  type: z.enum(['json', 'jsonl', 'json-schema']),
  size: z.number().int().min(0).max(PROBLEM_LIMITS.maxFileBytes),
  sha256: HashSchema, sensitivity: z.enum(['public-schema', 'redacted-summary']),
  compression: z.enum(['store', 'deflate']),
});
export const ProblemFileSchema = SummaryFileSchema.extend({
  type: z.enum(['json', 'jsonl', 'json-schema', 'text', 'png', 'jpeg']),
  sensitivity: z.enum(['public-schema', 'redacted-summary', 'reviewed-attachment']),
});
const schemaVersion = z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/);
const SummaryManifestSchema = z.strictObject({
  format: z.literal('ohmate-problem'), schemaVersion,
  problemId: IdentifierSchema, sessionId: IdentifierSchema,
  content: z.literal('domain-summaries'), integrity: z.literal('sha256-not-signature'),
  files: z.array(SummaryFileSchema).min(1).max(PROBLEM_LIMITS.maxFiles - 1),
});
export const ProblemManifestSchema = SummaryManifestSchema.extend({
  content: z.enum(['domain-summaries', 'kit-readonly']),
  files: z.array(ProblemFileSchema).min(1).max(PROBLEM_LIMITS.maxFiles - 1),
});
const LegacyProblemSessionSchema = z.strictObject({
  schemaVersion: schemaVersion.refine((value) => value.split('.')[0] === '1'), identity: ProblemIdentitySchema,
  source: z.strictObject({ kind: z.literal('desktop-durable-summary'), debugSessionId: z.string().uuid(), streamId: z.string().uuid() }),
  buildVerification: z.literal('unverified'), deviceProvenance: z.literal('peer-asserted'),
  authentication: z.literal('not-restored'), clockCalibration: z.literal('not-verified'),
  clockEvidence: z.array(JournalClockSchema).max(4096).optional(),
  through: z.number().int().min(0).max(4096),
  coverage: z.array(z.strictObject({ channel: ChannelSchema, count: z.number().int().min(0).max(4096),
    status: z.enum(['summary-only', 'not-captured']) })).length(ChannelSchema.options.length),
  redaction: z.strictObject({ policyId: z.literal('offline-summary-v1'), fieldsRemoved: z.number().int().min(0),
    memoryOnlyText: z.literal('excluded'), attachments: z.literal('none') }),
});
export const ProblemHistorySchema = z.strictObject({
  retention: z.literal('rolling-v1'),
  from: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  retainedCount: z.number().int().min(0).max(4096),
  epochs: JournalEpochsSchema,
  anchor: z.strictObject({ sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sessionEpoch: IdentifierSchema, clock: JournalClockSchema }).nullable(),
  gap: z.strictObject({ missingFrom: z.literal(1), missingThrough: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    reason: z.literal('retention-quota') }).nullable(),
});
const RetainedProblemSessionSchema = LegacyProblemSessionSchema.extend({
  through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  clockEvidence: z.array(JournalClockSchema).max(4096), history: ProblemHistorySchema,
});
const EventClockSessionSchema = RetainedProblemSessionSchema.omit({ clockEvidence: true }).extend({
  clockEvidenceLocation: z.literal('events.jsonl'),
});
const kitSourceSchema = z.union([
  LegacyProblemSessionSchema.shape.source,
  z.strictObject({ kind: z.literal('app-memory-summary') }),
  z.strictObject({ kind: z.literal('app-readonly-summary') }),
]);
export const ProblemSessionSchema = RetainedProblemSessionSchema.extend({
  source: kitSourceSchema,
  clockEvidence: RetainedProblemSessionSchema.shape.clockEvidence.optional(), history: ProblemHistorySchema.optional(),
  clockEvidenceLocation: z.literal('events.jsonl').optional(),
}).superRefine((session, context) => {
  if (session.source.kind !== 'desktop-durable-summary' &&
    (session.schemaVersion !== '1.4' || session.through !== 0 || session.clockEvidence !== undefined ||
      session.history !== undefined || session.clockEvidenceLocation !== undefined)) {
    context.addIssue({ code: 'custom', message: 'PROBLEM_APP_SOURCE_INVALID' });
  }
});
export type ProblemManifest = z.infer<typeof ProblemManifestSchema>;
export type ProblemSession = z.infer<typeof ProblemSessionSchema>;
export type ProblemEvent = z.infer<typeof ProblemEventSchema>;
export type ProblemHistory = z.infer<typeof ProblemHistorySchema>;

// Generated in memory from the same canonical repository source as realtime.
export function problemSchemas(clockEvidence = false, retainedHistory = false, eventClocks = false, kit = false,
  appSource: boolean | 'app-readonly-summary' = false): Map<string, unknown> {
  const session = eventClocks ? EventClockSessionSchema : retainedHistory ? RetainedProblemSessionSchema :
    clockEvidence ? LegacyProblemSessionSchema : LegacyProblemSessionSchema.omit({ clockEvidence: true });
  if (appSource && (!kit || clockEvidence || retainedHistory || eventClocks)) { throw new Error('PROBLEM_APP_SOURCE_INVALID'); }
  const exportedSession = appSource ? session.extend({
    source: z.strictObject({ kind: z.literal(appSource === true ? 'app-memory-summary' : 'app-readonly-summary') }),
    schemaVersion: z.literal('1.4'), through: z.literal(0),
  }) : session;
  return new Map<string, unknown>([
    ['schemas/manifest.schema.json', z.toJSONSchema(kit ? ProblemManifestSchema : SummaryManifestSchema)],
    ['schemas/session.schema.json', z.toJSONSchema(exportedSession)],
    ['schemas/event.schema.json', z.toJSONSchema(eventClocks ? ProblemClockEventSchema : ProblemEventSchema)],
    ...(kit ? [...kitSchemas()] : []),
  ]);
}
