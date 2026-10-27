/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { event, identity, protocol } from './test-fixtures.js';

function clock(overrides: Record<string, unknown> = {}) {
  return {
    clockId: 'clock-1',
    bootId: 'boot-1',
    wallTimeUtc: '2026-10-23T00:00:00Z',
    monotonicNs: '100',
    offsetUncertaintyMs: 5,
    ...overrides,
  };
}

describe('monotonic clock segments', () => {
  it('orders within a clock/boot segment independently of wall time', async () => {
    const api = await protocol();
    expect(
      api.advanceClock,
      'the monotonic clock segment model is missing'
    ).toBeTypeOf('function');
    const first = api.advanceClock(null, clock(), 10);
    const next = api.advanceClock(
      first,
      clock({
        monotonicNs: '101',
        wallTimeUtc: '2020-01-01T00:00:00Z',
      }),
      10
    );
    expect(next).toMatchObject({
      segment: 1,
      monotonicNs: '101',
      mergeable: true,
    });
    expect(() =>
      api.advanceClock(next, clock({ monotonicNs: '99' }), 10)
    ).toThrow('CLOCK_REGRESSION');
    expect(
      api.advanceClock(next, clock({ monotonicNs: '101' }), 10).segment
    ).toBe(1);
  });

  it.each([{ bootId: 'boot-2' }, { clockId: 'clock-2' }])(
    'segments changed clock identity %j',
    async (change) => {
      const api = await protocol();
      expect(api.advanceClock).toBeTypeOf('function');
      const first = api.advanceClock(null, clock(), 10);
      const next = api.advanceClock(
        first,
        clock({ ...change, monotonicNs: '0' }),
        10
      );
      expect(next).toMatchObject({
        segment: 2,
        monotonicNs: '0',
        reason: 'clock-boundary',
      });
    }
  );

  it('segments above-budget uncertainty and never asserts a merged timeline', async () => {
    const api = await protocol();
    expect(api.advanceClock).toBeTypeOf('function');
    const first = api.advanceClock(null, clock(), 10);
    const uncertain = api.advanceClock(
      first,
      clock({ monotonicNs: '101', offsetUncertaintyMs: 11 }),
      10
    );
    expect(uncertain).toMatchObject({
      segment: 2,
      mergeable: false,
      reason: 'uncertainty-boundary',
    });
    const recovered = api.advanceClock(
      uncertain,
      clock({ monotonicNs: '102', offsetUncertaintyMs: 10 }),
      10
    );
    expect(recovered).toMatchObject({ segment: 3, mergeable: true });
  });

  it('preserves uint64 precision rather than coercing monotonic nanoseconds to Number', async () => {
    const api = await protocol();
    expect(api.advanceClock).toBeTypeOf('function');
    const first = api.advanceClock(
      null,
      clock({ monotonicNs: '18446744073709551614' }),
      10
    );
    const next = api.advanceClock(
      first,
      clock({ monotonicNs: '18446744073709551615' }),
      10
    );
    expect(next.monotonicNs).toBe('18446744073709551615');
  });

  it.each([-1, NaN, Infinity])(
    'rejects invalid view budget %s',
    async (budget) => {
      const api = await protocol();
      expect(api.advanceClock).toBeTypeOf('function');
      expect(() => api.advanceClock(null, clock(), budget)).toThrow(
        'INVALID_SCHEMA'
      );
    }
  );

  it('rejects clock regression atomically but permits retained replay after reconnect', async () => {
    const api = await protocol();
    expect(api.createReadonlyBridge).toBeTypeOf('function');
    const hello = api.createHandshake(identity);
    const receiver = api.createReadonlyBridge(hello);
    receiver.connect(hello, 'epoch-1');
    receiver.accept(event(1, { monotonicNs: '100' }));
    expect(() => receiver.accept(event(2, { monotonicNs: '99' }))).toThrow(
      'CLOCK_REGRESSION'
    );
    expect(receiver.status().ackThrough).toBe(1);
    receiver.accept(event(2, { monotonicNs: '101' }));
    receiver.disconnect();
    receiver.resume(hello, {
      ...identity,
      type: 'resume',
      protocolVersion: '1.1',
      previousEpoch: 'epoch-1',
      sessionEpoch: 'epoch-2',
      resumeFrom: 1,
    });
    expect(
      receiver.accept(event(1, { monotonicNs: '100', sessionEpoch: 'epoch-2' }))
        .disposition
    ).toBe('replay');
  });
});
