/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { IdentifierSchema } from './domain-schemas.js';
import { ClockSchema, type Clock } from './envelopes.js';

export const MonotonicNsSchema = ClockSchema.shape.monotonicNs;
export const ClockProbeSchema = z.strictObject({
  type: z.literal('clock-probe'), version: z.literal('1'),
  probeId: IdentifierSchema, sessionEpoch: IdentifierSchema, t0: MonotonicNsSchema,
});
export const ClockReplySchema = z.strictObject({
  type: z.literal('clock-reply'), version: z.literal('1'),
  probeId: IdentifierSchema, sessionEpoch: IdentifierSchema, t0: MonotonicNsSchema,
  clockId: IdentifierSchema, bootId: IdentifierSchema, t1: MonotonicNsSchema, t2: MonotonicNsSchema,
  precisionNs: MonotonicNsSchema.refine((value) => BigInt(value) >= 1000000n && BigInt(value) <= 1000000000n),
});
export const ClockSampleSchema = ClockReplySchema.omit({ type: true, version: true }).extend({
  desktopClockId: IdentifierSchema, t3: MonotonicNsSchema,
});
export const ClockObservationSchema = z.strictObject({
  sessionEpoch: IdentifierSchema, desktopClockId: IdentifierSchema, receivedNs: MonotonicNsSchema,
  sample: ClockSampleSchema.nullable(),
});
export const ClockAlignmentSchema = z.strictObject({
  observation: ClockObservationSchema,
  status: z.enum(['calibrated', 'not-calibrated', 'clock-changed', 'before-sample', 'expired', 'drift', 'over-budget']),
  mergeable: z.boolean(),
  offsetNs: z.string().regex(/^-?(0|[1-9]\d{0,20})$/).nullable(),
  uncertaintyNs: z.string().regex(/^(0|[1-9]\d{0,20})$/).nullable(),
  desktopMonotonicNs: MonotonicNsSchema.nullable(),
  assumptions: z.literal('relative-drift-at-most-1000ppm'),
});
export type ClockSample = z.infer<typeof ClockSampleSchema>;
export type ClockObservation = z.infer<typeof ClockObservationSchema>;
export type ClockAlignment = z.infer<typeof ClockAlignmentSchema>;

export function validateClockSample(input: unknown): ClockSample {
  const parsed = ClockSampleSchema.safeParse(input);
  if (!parsed.success) { throw new Error('CLOCK_SAMPLE_INVALID'); }
  const sample = parsed.data;
  const elapsed = BigInt(sample.t3) - BigInt(sample.t0);
  const processing = BigInt(sample.t2) - BigInt(sample.t1);
  if (elapsed < 0n || elapsed > 10000000000n || processing < 0n ||
    processing > elapsed + 2n * BigInt(sample.precisionNs) + (elapsed + 999n) / 1000n) {
    throw new Error('CLOCK_SAMPLE_INVALID');
  }
  return sample;
}

// Offset is desktop minus peer. No symmetry assumption or wall-clock subtraction.
// The drift ceiling is an explicit view policy, not a hardware accuracy claim.
export function alignClock(clock: Clock, input: unknown, budgetMs: number): ClockAlignment {
  const decoded = ClockObservationSchema.safeParse(input);
  if (!decoded.success || !Number.isFinite(budgetMs) || budgetMs < 0) { throw new Error('CLOCK_SAMPLE_INVALID'); }
  const observation = decoded.data;
  const result: ClockAlignment = {
    observation, status: 'not-calibrated', mergeable: false, offsetNs: null, uncertaintyNs: null,
    desktopMonotonicNs: null, assumptions: 'relative-drift-at-most-1000ppm',
  };
  if (!observation.sample) { return result; }
  const sample = validateClockSample(observation.sample);
  const received = BigInt(observation.receivedNs), t0 = BigInt(sample.t0), t3 = BigInt(sample.t3);
  if (received < t3) { throw new Error('CLOCK_SAMPLE_INVALID'); }
  if (observation.sessionEpoch !== sample.sessionEpoch || observation.desktopClockId !== sample.desktopClockId ||
    clock.clockId !== sample.clockId || clock.bootId !== sample.bootId) {
    return { ...result, status: 'clock-changed' };
  }
  if (received - t3 >= 10000000000n) { return { ...result, status: 'expired' }; }
  const peer = BigInt(clock.monotonicNs);
  if (peer < BigInt(sample.t2)) { return { ...result, status: 'before-sample' }; }
  const drift = (received - t0 + 999n) / 1000n;
  const precision = 2n * BigInt(sample.precisionNs);
  const low = t0 - BigInt(sample.t1) - precision - drift;
  const high = t3 - BigInt(sample.t2) + precision + drift;
  const offset = (low + high) / 2n;
  const uncertainty = (high - low + 1n) / 2n;
  if (peer + low > received) { return { ...result, status: 'drift' }; }
  const measured = { ...result, offsetNs: offset.toString(), uncertaintyNs: uncertainty.toString() };
  if (uncertainty > BigInt(Math.floor(Math.min(budgetMs, Number.MAX_SAFE_INTEGER / 1000000) * 1000000))) {
    return { ...measured, status: 'over-budget' };
  }
  const mapped = peer + offset;
  if (mapped < 0n || mapped > 18446744073709551615n) { return { ...measured, status: 'over-budget' }; }
  return { ...measured, status: 'calibrated', mergeable: true, desktopMonotonicNs: mapped.toString() };
}
