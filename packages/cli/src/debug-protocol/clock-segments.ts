/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ClockSchema } from './envelopes.js';
import type { Clock } from './envelopes.js';
import { parseProtocol, ProtocolError } from './protocol-error.js';
import { alignClock, ClockAlignmentSchema, type ClockAlignment, type ClockObservation } from './clock-calibration.js';
import { z } from 'zod';

export const ClockSegmentSchema = z.strictObject({
  ...ClockSchema.shape, segment: z.number().int().positive(),
  mergeable: z.boolean(), reason: z.enum(['initial', 'continuous', 'clock-boundary', 'uncertainty-boundary', 'calibration-boundary']),
  alignment: ClockAlignmentSchema.optional(),
});

export interface ClockSegment extends Clock {
  segment: number;
  mergeable: boolean;
  reason: 'initial' | 'continuous' | 'clock-boundary' | 'uncertainty-boundary' | 'calibration-boundary';
  alignment?: ClockAlignment;
}

export function assertClockBudget(budgetMs: number): void {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new ProtocolError('INVALID_SCHEMA');
  }
}

// Without an observation this retains the legacy eligibility model for old logs.
// Readers must require alignment evidence before using a cross-clock timestamp.
export function advanceClock(
  previous: ClockSegment | null,
  input: unknown,
  budgetMs: number,
  observation?: ClockObservation
): ClockSegment {
  assertClockBudget(budgetMs);
  const clock = parseProtocol(ClockSchema, input);
  const sameClock =
    previous?.clockId === clock.clockId && previous.bootId === clock.bootId;
  if (sameClock && BigInt(clock.monotonicNs) < BigInt(previous.monotonicNs)) {
    throw new ProtocolError('CLOCK_REGRESSION');
  }
  const alignment = observation ? alignClock(clock, observation, budgetMs) : undefined;
  const previousObservation = previous?.alignment?.observation;
  if (observation && previousObservation && observation.desktopClockId === previousObservation.desktopClockId &&
    BigInt(observation.receivedNs) < BigInt(previousObservation.receivedNs)) {
    throw new Error('CLOCK_SAMPLE_INVALID');
  }
  const mergeable = alignment ? alignment.mergeable : clock.offsetUncertaintyMs <= budgetMs;
  const previousEvidence = previous?.alignment;
  const calibrationBoundary = previous !== null && (alignment !== undefined || previousEvidence !== undefined) &&
    (alignment?.status !== previousEvidence?.status ||
      alignment?.observation.sessionEpoch !== previousEvidence?.observation.sessionEpoch ||
      alignment?.observation.desktopClockId !== previousEvidence?.observation.desktopClockId ||
      alignment?.observation.sample?.probeId !== previousEvidence?.observation.sample?.probeId);
  const uncertaintyBoundary =
    previous !== null && previous.mergeable !== mergeable;
  const boundary = previous !== null && (!sameClock || uncertaintyBoundary || calibrationBoundary);
  const reason =
    previous === null
      ? 'initial'
      : !sameClock
        ? 'clock-boundary'
        : calibrationBoundary
          ? 'calibration-boundary'
        : uncertaintyBoundary
          ? 'uncertainty-boundary'
          : 'continuous';
  return {
    ...clock,
    segment: (previous?.segment ?? 1) + Number(boundary),
    mergeable,
    reason,
    ...(alignment ? { alignment } : {}),
  };
}
