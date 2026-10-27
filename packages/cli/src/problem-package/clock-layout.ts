/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { canonicalJson } from '../debug-protocol/canonical-hash.js';
import { ProblemClockEventSchema, ProblemEventSchema, ProblemSessionSchema } from './schemas.js';
import type { ProblemEvent, ProblemSession } from './schemas.js';

export function encodeProblemClocks(input: ProblemSession, events: ProblemEvent[]) {
  const external = Boolean(input.history && input.clockEvidence && Buffer.byteLength(canonicalJson(input)) > 1024 ** 2);
  if (!external) { return { external, session: input, storedSession: input, storedEvents: events }; }
  const session = ProblemSessionSchema.parse({ ...input, schemaVersion: '1.3', clockEvidenceLocation: 'events.jsonl' });
  const { clockEvidence, ...storedSession } = session;
  return { external, session, storedSession,
    storedEvents: events.map((event, index) => ProblemClockEventSchema.parse({ ...event, clockEvidence: clockEvidence![index] })) };
}

export function decodeProblemClocks(session: ProblemSession, values: unknown[], external: boolean) {
  if (!external) { return { session, events: values.map((value) => ProblemEventSchema.parse(value)) }; }
  if (!session.history || session.clockEvidence || session.clockEvidenceLocation !== 'events.jsonl' ||
    Number(session.schemaVersion.split('.')[1]) < 3) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
  const records = values.map((value) => ProblemClockEventSchema.parse(value));
  return {
    session: ProblemSessionSchema.parse({ ...session, clockEvidence: records.map((record) => record.clockEvidence) }),
    events: records.map(({ clockEvidence: _clock, ...event }) => {
      void _clock; return ProblemEventSchema.parse(event);
    }),
  };
}
