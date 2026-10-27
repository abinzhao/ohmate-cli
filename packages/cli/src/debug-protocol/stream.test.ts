/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { event, identity, protocol } from './test-fixtures.js';

async function bridge(options = {}) {
  const api = await protocol();
  expect(
    api.createReadonlyBridge,
    'the receiver state machine is missing'
  ).toBeTypeOf('function');
  const hello = api.createHandshake(identity, { resumeWindow: 2, ...options });
  const receiver = api.createReadonlyBridge(hello, {
    clockUncertaintyBudgetMs: 10,
  });
  receiver.connect(hello, 'epoch-1');
  return { api, receiver, hello };
}

function resume(resumeFrom: number, overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    type: 'resume',
    protocolVersion: '1.1',
    previousEpoch: 'epoch-1',
    sessionEpoch: 'epoch-2',
    resumeFrom,
    ...overrides,
  };
}

describe('bounded continuous-ack receiver', () => {
  it('accepts consecutive events and returns identity-bound acknowledgements', async () => {
    const { api, receiver } = await bridge();
    for (const sequence of [1, 2, 3]) {
      const result = receiver.accept(event(sequence));
      expect(result.disposition).toBe('accepted');
      expect(api.AckSchema.parse(result.ack)).toMatchObject({
        ...identity,
        type: 'ack',
        sessionEpoch: 'epoch-1',
        ackThrough: sequence,
      });
    }
    expect(receiver.status()).toMatchObject({
      ackThrough: 3,
      lastSequence: 3,
      retainedFrom: 2,
    });
  });

  it('does not advance the ack for an exact duplicate, including reordered JSON keys', async () => {
    const { receiver } = await bridge();
    receiver.accept(event());
    const reordered = {
      ...event(),
      payload: { summary: 'Redacted fixture summary', level: 'info' },
    };
    expect(receiver.accept(reordered)).toMatchObject({
      disposition: 'duplicate',
      ack: { ackThrough: 1 },
    });
  });

  it('reports a gap without buffering or skipping missing events', async () => {
    const { api, receiver } = await bridge();
    try {
      receiver.accept(event(3));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(api.ProtocolError);
      expect(error).toMatchObject({
        code: 'SEQUENCE_GAP',
        gap: { expected: 1, received: 3, missingFrom: 1, missingThrough: 2 },
      });
    }
    expect(receiver.status().ackThrough).toBe(0);
    expect(receiver.accept(event()).ack.ackThrough).toBe(1);
  });

  it.each([
    [event(2, { messageId: 'fixture-message-1' }), 'MESSAGE_ID_CONFLICT'],
    [
      event(1, { payload: { level: 'error', summary: 'changed' } }),
      'MESSAGE_ID_CONFLICT',
    ],
    [event(1, { messageId: 'different-message' }), 'SEQUENCE_CONFLICT'],
  ])('rejects message or sequence conflicts', async (input, code) => {
    const { receiver } = await bridge();
    receiver.accept(event());
    expect(() => receiver.accept(input)).toThrow(code);
    expect(receiver.status().ackThrough).toBe(1);
  });

  it.each(Object.keys(identity))(
    'rejects cross-%s events without changing state',
    async (field) => {
      const { receiver } = await bridge();
      const changed = field === 'fingerprint' ? 'b'.repeat(64) : 'other';
      expect(() => receiver.accept(event(1, { [field]: changed }))).toThrow(
        'IDENTITY_MISMATCH'
      );
      expect(receiver.status().ackThrough).toBe(0);
    }
  );

  it.each([
    [{ sessionEpoch: 'stale-epoch' }, 'EPOCH_MISMATCH'],
    [{ protocolVersion: '1.0' }, 'VERSION_MISMATCH'],
    [{ type: 'command' }, 'INVALID_SCHEMA'],
    [
      {
        channel: 'ui',
        capability: 'ui.read',
        payload: { windowId: 'window', nodeCount: 1, summary: '' },
      },
      'CHANNEL_MISMATCH',
    ],
  ])('enforces the negotiated scope for %j', async (patch, code) => {
    const { receiver } = await bridge({ channels: ['hilog'] });
    expect(() => receiver.accept(event(1, patch))).toThrow(code);
    expect(receiver.status().ackThrough).toBe(0);
  });

  it('enforces the UTF-8 wire frame budget before accepting events', async () => {
    const { receiver } = await bridge({ maxFrame: 1024 });
    expect(() =>
      receiver.accept(
        event(1, {
          payload: { level: 'info', summary: '界'.repeat(300) },
        })
      )
    ).toThrow('FRAME_TOO_LARGE');
    expect(receiver.status().ackThrough).toBe(0);
  });

  it('accepts JSON wire frames and counts whitespace toward the frame budget', async () => {
    const { receiver } = await bridge({ maxFrame: 1024 });
    expect(() =>
      receiver.accept(`${' '.repeat(1024)}${JSON.stringify(event())}`)
    ).toThrow('FRAME_TOO_LARGE');
    expect(() => receiver.accept('{broken')).toThrow('INVALID_SCHEMA');
    expect(receiver.accept(JSON.stringify(event())).ack.ackThrough).toBe(1);
  });

  it('never reflects rejected secret objects in protocol errors', async () => {
    const { receiver } = await bridge();
    try {
      receiver.accept(
        event(1, { credentials: { token: 'fixture-secret-never-log' } })
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('fixture-secret-never-log');
      expect(error).toMatchObject({ code: 'INVALID_SCHEMA' });
    }
  });

  it('copies accepted data and returned acknowledgements', async () => {
    const { receiver } = await bridge();
    const input = event();
    const result = receiver.accept(input);
    input.payload.summary = 'changed';
    result.ack.ackThrough = 999;
    expect(receiver.accept(event()).disposition).toBe('duplicate');
    expect(receiver.status().ackThrough).toBe(1);
  });

  it('deduplicates omitted optional fields and their undefined object equivalents', async () => {
    const { receiver } = await bridge({ channels: ['instrumentation'] });
    const input = event(1, {
      channel: 'instrumentation',
      capability: 'instrumentation.read',
      payload: {
        eventName: 'fixture-event',
        summary: 'redacted',
        traceId: undefined,
      },
    });
    receiver.accept(input);
    expect(receiver.accept(JSON.stringify(input)).disposition).toBe(
      'duplicate'
    );
  });

  it('rejects window-evicted replay with an explicit gap', async () => {
    const { api, receiver } = await bridge();
    [1, 2, 3].forEach((sequence) => receiver.accept(event(sequence)));
    expect(() => receiver.accept(event())).toThrow('REPLAY_OUTSIDE_WINDOW');
    try {
      receiver.accept(event());
    } catch (error) {
      expect(error).toBeInstanceOf(api.ProtocolError);
      expect(error).toMatchObject({
        gap: { missingFrom: 1, missingThrough: 1 },
      });
    }
    expect(receiver.status().ackThrough).toBe(3);
  });

  it('uses a fresh epoch to resume retained events without redelivery', async () => {
    const { receiver, hello } = await bridge();
    [1, 2, 3].forEach((sequence) => receiver.accept(event(sequence)));
    receiver.disconnect();
    expect(receiver.resume(hello, resume(2)).ack).toMatchObject({
      sessionEpoch: 'epoch-2',
      ackThrough: 1,
    });
    expect(() => receiver.accept(event(2))).toThrow('EPOCH_MISMATCH');
    for (const sequence of [2, 3]) {
      expect(
        receiver.accept(event(sequence, { sessionEpoch: 'epoch-2' }))
      ).toMatchObject({ disposition: 'replay', ack: { ackThrough: sequence } });
    }
    expect(
      receiver.accept(event(4, { sessionEpoch: 'epoch-2' }))
    ).toMatchObject({
      disposition: 'accepted',
      ack: { ackThrough: 4 },
    });
  });

  it('does not ack past replay that has not been received yet', async () => {
    const { receiver, hello } = await bridge();
    [1, 2].forEach((sequence) => receiver.accept(event(sequence)));
    receiver.disconnect();
    receiver.resume(hello, resume(1));
    expect(() =>
      receiver.accept(event(3, { sessionEpoch: 'epoch-2' }))
    ).toThrow('SEQUENCE_GAP');
    expect(receiver.status().ackThrough).toBe(0);
  });

  it.each([1, 5])(
    'rejects unavailable resumeFrom %s atomically',
    async (resumeFrom) => {
      const { receiver, hello } = await bridge();
      [1, 2, 3].forEach((sequence) => receiver.accept(event(sequence)));
      receiver.disconnect();
      expect(() => receiver.resume(hello, resume(resumeFrom))).toThrow(
        'SEQUENCE_GAP'
      );
      expect(receiver.status()).toMatchObject({
        state: 'disconnected',
        sessionEpoch: 'epoch-1',
        ackThrough: 3,
      });
      expect(receiver.resume(hello, resume(4)).ack.ackThrough).toBe(3);
    }
  );

  it.each([
    [{ buildId: 'other-build' }, 'IDENTITY_MISMATCH'],
    [{ sessionId: 'other-session' }, 'IDENTITY_MISMATCH'],
    [{ previousEpoch: 'other-epoch' }, 'EPOCH_MISMATCH'],
    [{ sessionEpoch: 'epoch-1' }, 'EPOCH_REUSED'],
    [{ protocolVersion: '1.0' }, 'VERSION_MISMATCH'],
  ])('rejects resume scope %j', async (patch, code) => {
    const { receiver, hello } = await bridge();
    receiver.disconnect();
    expect(() => receiver.resume(hello, resume(1, patch))).toThrow(code);
    expect(receiver.status().state).toBe('disconnected');
  });

  it('rejects negotiation drift on resume and reuse of any earlier epoch', async () => {
    const { api, receiver, hello } = await bridge();
    receiver.disconnect();
    const changed = api.createHandshake(identity, { resumeWindow: 1 });
    expect(() => receiver.resume(changed, resume(1))).toThrow(
      'RESUME_MISMATCH'
    );
    receiver.resume(hello, resume(1));
    receiver.disconnect();
    expect(() =>
      receiver.resume(
        hello,
        resume(1, {
          previousEpoch: 'epoch-2',
          sessionEpoch: 'epoch-1',
        })
      )
    ).toThrow('EPOCH_REUSED');
  });

  it('resumes a suspended receiver but cannot reset an established stream via connect', async () => {
    const { receiver, hello } = await bridge();
    receiver.suspend();
    expect(() => receiver.accept(event())).toThrow('INVALID_STATE');
    expect(() => receiver.connect(hello, 'epoch-2')).toThrow('INVALID_STATE');
    expect(receiver.resume(hello, resume(1)).ack.ackThrough).toBe(0);
  });

  it.each(['revoke', 'expire'] as const)(
    'treats %s as a terminal state',
    async (action) => {
      const { receiver, hello } = await bridge();
      receiver.accept(event());
      receiver[action]();
      expect(() => receiver.accept(event(2))).toThrow('INVALID_STATE');
      expect(() => receiver.resume(hello, resume(2))).toThrow('INVALID_STATE');
      expect(() => receiver.connect(hello, 'epoch-2')).toThrow('INVALID_STATE');
      expect(() => receiver.disconnect()).toThrow('INVALID_STATE');
      expect(receiver.status().retainedFrom).toBeNull();
    }
  );

  it('isolates separate receiver instances and supports previous-minor events', async () => {
    const { api, receiver } = await bridge();
    receiver.accept(event());
    const hello = api.createHandshake(
      { ...identity, buildId: 'other-build', sessionId: 'other-session' },
      {
        protocolVersionRange: { min: '1.0', max: '1.0' },
      }
    );
    const second = api.createReadonlyBridge(hello);
    second.connect(hello, 'epoch-1');
    expect(() => second.accept(event())).toThrow('IDENTITY_MISMATCH');
    expect(
      second.accept(
        event(1, {
          buildId: 'other-build',
          sessionId: 'other-session',
          protocolVersion: '1.0',
        })
      ).ack.ackThrough
    ).toBe(1);
  });
});
