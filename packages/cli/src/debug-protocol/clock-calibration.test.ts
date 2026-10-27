/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import * as protocol from './index.js';
import { advanceClock } from './clock-segments.js';
import { event, identity } from './test-fixtures.js';

const calibration = protocol;

const sample = {
  probeId: 'probe-1', sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1',
  clockId: 'clock-1', bootId: 'boot-1',
  t0: '1000000000', t1: '902000000', t2: '903000000', t3: '1005000000',
  precisionNs: '1000000',
};
const observed = (changes = {}) => ({
  sessionEpoch: 'epoch-1', desktopClockId: 'desktop-1', receivedNs: '1006000000',
  sample: { ...sample }, ...changes,
});
const clock = (changes = {}) => ({
  clockId: 'clock-1', bootId: 'boot-1', monotonicNs: '904000000',
  wallTimeUtc: '2026-10-24T00:00:00Z', offsetUncertaintyMs: 0, ...changes,
});

it('exports the measured clock model', () => {
  expect(calibration.alignClock).toBeTypeOf('function');
});

it('derives the offset interval from four timestamps, including asymmetric delay and quantization', () => {
  const result = calibration.alignClock(clock(), observed(), 10);
  expect(result).toMatchObject({
    status: 'calibrated', mergeable: true, offsetNs: '100000000',
    uncertaintyNs: '4006000', desktopMonotonicNs: '1004000000',
    assumptions: 'relative-drift-at-most-1000ppm',
  });
});

it('never treats peer uncertainty or wall-clock equality as calibration', () => {
  expect(calibration.alignClock(clock(), observed({ sample: null }), 10)).toMatchObject({
    status: 'not-calibrated', mergeable: false, desktopMonotonicNs: null,
  });
  const noEvidence = advanceClock(null, clock(), 10, observed({ sample: null }));
  expect(noEvidence.mergeable).toBe(false);
});

it.each([
  { sessionEpoch: 'epoch-2' }, { desktopClockId: 'desktop-2' },
])('does not reuse another epoch or desktop clock %j', (change) => {
  expect(calibration.alignClock(clock(), observed(change), 10)).toMatchObject({ status: 'clock-changed', mergeable: false });
});

it.each([{ clockId: 'clock-2' }, { bootId: 'boot-2' }])('invalidates changed peer clock %j', (change) => {
  expect(calibration.alignClock(clock(change), observed(), 10)).toMatchObject({ status: 'clock-changed', mergeable: false });
});

it('expires by monotonic elapsed time even when the wall clock moves backwards', () => {
  expect(calibration.alignClock(clock({ monotonicNs: '10903000000', wallTimeUtc: '2020-01-01T00:00:00Z' }),
    observed({ receivedNs: '11005000000' }), 100)).toMatchObject({ status: 'expired', mergeable: false });
});

it('rejects an elapsed-time drift outside the measured delay interval', () => {
  expect(calibration.alignClock(clock({ monotonicNs: '1903000000' }),
    observed({ receivedNs: '1105000000' }), 10)).toMatchObject({ status: 'drift', mergeable: false });
});

it('segments an over-budget measurement and a later uncalibrated epoch', () => {
  const first = advanceClock(null, clock(), 10, observed());
  const next = advanceClock(first, clock({ monotonicNs: '5903000000' }), 5,
    observed({ receivedNs: '6005000000' }));
  expect(next).toMatchObject({ segment: 2, mergeable: false, reason: 'calibration-boundary',
    alignment: { status: 'over-budget' } });
  const third = advanceClock(next, clock({ monotonicNs: '5904000000' }), 10,
    observed({ sample: null, sessionEpoch: 'epoch-2', receivedNs: '6006000000' }));
  expect(third).toMatchObject({ segment: 3, mergeable: false, reason: 'calibration-boundary' });
});

it('keeps nanoseconds beyond Number precision exact and permits negative offsets', () => {
  const shifted = { ...sample, t0: '18000000000000000000', t1: '18000000000102000000',
    t2: '18000000000103000000', t3: '18000000000005000000' };
  const result = calibration.alignClock(clock({ monotonicNs: '18000000000104000000' }),
    observed({ sample: shifted, receivedNs: '18000000000006000000' }), 10);
  expect(result).toMatchObject({ offsetNs: '-100000000', desktopMonotonicNs: '18000000000004000000' });
});

it.each([
  { t2: '901000000' }, { t3: '999999999' }, { t3: '12000000000' },
  { t0: '18446744073709551616' }, { precisionNs: '0' },
])('rejects impossible or unbounded measurements %j', (change) => {
  expect(() => calibration.alignClock(clock(), observed({ sample: { ...sample, ...change } }), 10))
    .toThrow('CLOCK_SAMPLE_INVALID');
});

it('does not map an event captured before the sample or received before t3', () => {
  expect(calibration.alignClock(clock({ monotonicNs: '902000000' }), observed(), 10))
    .toMatchObject({ status: 'before-sample', mergeable: false });
  expect(() => calibration.alignClock(clock(), observed({ receivedNs: '1004000000' }), 10))
    .toThrow('CLOCK_SAMPLE_INVALID');
});

it('rejects desktop arrival regression rather than constructing a plausible historical mapping', () => {
  const first = advanceClock(null, clock(), 10, observed());
  expect(() => advanceClock(first, clock({ monotonicNs: '905000000' }), 10,
    observed({ receivedNs: '1005500000' }))).toThrow('CLOCK_SAMPLE_INVALID');
});

it('does not let a returned clock record mutate retained calibration state', () => {
  const handshake = protocol.createHandshake(identity), bridge = protocol.createReadonlyBridge(handshake);
  bridge.connect(handshake, 'epoch-1');
  const first = bridge.accept(event(1, clock()), observed());
  first.clock.alignment!.observation.sample!.probeId = 'mutated-result';
  expect(bridge.accept(event(2, clock({ monotonicNs: '905000000' })), observed({ receivedNs: '1007000000' }))
    .clock.segment).toBe(1);
});
