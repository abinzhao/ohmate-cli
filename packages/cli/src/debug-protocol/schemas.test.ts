/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { event, identity, protocol } from './test-fixtures.js';

describe('strict read-only bridge contracts', () => {
  it('exposes the same bounded batch schema and encrypted opt-in to every protocol consumer', async () => {
    const api = await protocol();
    expect(api.EventBatchSchema, 'shared batch contract is missing').toBeDefined();
    const contract = api.describeReadonlyProtocol();
    expect(contract.schemas.eventBatch).toEqual(z.toJSONSchema(api.EventBatchSchema));
    expect(contract.eventBatch).toMatchObject({ optIn: 'encrypted-ready.eventBatch=events-v1',
      maxEvents: 64, acknowledgement: 'durable-cumulative', frameBudget: 'negotiated-maxFrame' });
    expect(api.EventBatchSchema.safeParse({ type: 'event-batch', version: '1', events: [event(1)] }).success).toBe(true);
    for (const events of [[], Array.from({ length: 65 }, (_, n) => event(n + 1)), [event(1, { capability: 'hilog.write' })]]) {
      expect(api.EventBatchSchema.safeParse({ type: 'event-batch', version: '1', events }).success).toBe(false);
    }
  });

  it('accepts the designed composite buildId in handshake and events', async () => {
    const api = await protocol();
    const buildId = `org.example.application@1000000@default@debug@arkts+native@${'a'.repeat(64)}`;
    expect(api.IdentitySchema.safeParse({ ...identity, buildId }).success).toBe(true);
    expect(api.EventEnvelopeSchema.safeParse(event(1, { buildId })).success).toBe(true);
    expect(() => api.createHandshake({ ...identity, buildId })).not.toThrow();
    for (const invalid of [`${buildId}\n`, 'a'.repeat(513), '../outside']) {
      expect(api.IdentitySchema.safeParse({ ...identity, buildId: invalid }).success).toBe(false);
    }
  });

  it('exports the schemas and pure handshake API without starting services', async () => {
    const cwd = process.cwd();
    const argv = [...process.argv];
    const api = await protocol();
    expect(api.EventEnvelopeSchema).toBeDefined();
    expect(api.HandshakeSchema).toBeDefined();
    expect(api.AckSchema).toBeDefined();
    expect(api.ResumeSchema).toBeDefined();
    expect(api.createHandshake).toBeTypeOf('function');
    expect(process.cwd()).toBe(cwd);
    expect(process.argv).toEqual(argv);
  });

  it.each(['1.1', '1.0'])(
    'negotiates the N/N-1 read-only version %s',
    async (version) => {
      const api = await protocol();
      const local = api.createHandshake(identity);
      const peer = api.createHandshake(identity, {
        protocolVersionRange: { min: version, max: version },
        maxFrame: 2048,
        resumeWindow: 2,
      });
      const result = api.negotiateReadonly(local, peer);
      expect(result.protocolVersion).toBe(version);
      expect(result.mode).toBe('readonly');
      expect(result.maxFrame).toBe(2048);
      expect(result.resumeWindow).toBe(2);
      expect(result.compression).toBe('none');
      expect(result.identity).toEqual(identity);
    }
  );

  it.each(['0.9', '1.2', '2.0'])(
    'rejects unsupported protocol %s',
    async (version) => {
      const api = await protocol();
      const local = api.createHandshake(identity);
      const peer = {
        ...local,
        protocolVersionRange: { min: version, max: version },
      };
      expect(() => api.negotiateReadonly(local, peer)).toThrow(
        'VERSION_MISMATCH'
      );
    }
  );

  it.each(Object.keys(identity))('binds the handshake to %s', async (field) => {
    const api = await protocol();
    const local = api.createHandshake(identity);
    const peer = {
      ...local,
      identity: {
        ...identity,
        [field]: field === 'fingerprint' ? 'b'.repeat(64) : 'other',
      },
    };
    expect(() => api.negotiateReadonly(local, peer)).toThrow(
      'IDENTITY_MISMATCH'
    );
  });

  it.each(['schemaHash', 'capabilityHash', 'channelVersion'])(
    'checks channel %s',
    async (field) => {
      const api = await protocol();
      const local = api.createHandshake(identity);
      const channels = local.channels.map((channel, index) =>
        index === 0
          ? {
              ...channel,
              [field]: field === 'channelVersion' ? '2.0' : 'b'.repeat(64),
            }
          : channel
      );
      expect(() =>
        api.negotiateReadonly(local, { ...local, channels })
      ).toThrow('CHANNEL_MISMATCH');
      expect(() =>
        api.negotiateReadonly({ ...local, channels }, local)
      ).toThrow('CHANNEL_MISMATCH');
    }
  );

  it('hashes the actual domain JSON schemas deterministically', async () => {
    const api = await protocol();
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
      }
      if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    for (const channel of api.createHandshake(identity).channels) {
      const json = canonical(
        z.toJSONSchema(api.PayloadSchemas[channel.channel])
      );
      expect(channel.schemaHash).toBe(
        createHash('sha256').update(json).digest('hex')
      );
    }
  });

  it('only negotiates explicitly available read capabilities', async () => {
    const api = await protocol();
    const local = api.createHandshake(identity, {
      channels: ['hilog', 'app.network'],
    });
    const peer = api.createHandshake(identity, { channels: ['hilog'] });
    expect(
      api.negotiateReadonly(local, peer).channels.map((item) => item.channel)
    ).toEqual(['hilog']);
    const channels = peer.channels.map((item) => ({
      ...item,
      available: false,
      read: false,
      reason: 'disabled',
    }));
    expect(() => api.negotiateReadonly(local, { ...peer, channels })).toThrow(
      'NO_READ_CAPABILITY'
    );
  });

  it.each([
    { mode: 'write' },
    { credentials: { token: 'fixture' } },
    { maxFrame: 0 },
    { maxFrame: 1048577 },
    { resumeWindow: 0 },
    { resumeWindow: 4097 },
    { compression: ['gzip'] },
    { protocolVersionRange: { min: '1.1', max: '1.0' } },
  ])('rejects unsafe or out-of-budget handshake %j', async (patch) => {
    const api = await protocol();
    expect(
      api.HandshakeSchema.safeParse({
        ...api.createHandshake(identity),
        ...patch,
      }).success
    ).toBe(false);
  });

  it.each([
    { write: true },
    { highRisk: true },
    { capability: 'hilog.write' },
    { channel: 'unknown' },
    { credentials: {} },
  ])('rejects unsafe channel capability %j', async (patch) => {
    const api = await protocol();
    const hello = api.createHandshake(identity, { channels: ['hilog'] });
    const channels = [{ ...hello.channels[0], ...patch }];
    expect(api.HandshakeSchema.safeParse({ ...hello, channels }).success).toBe(
      false
    );
  });

  it('rejects duplicate channel declarations', async () => {
    const api = await protocol();
    const hello = api.createHandshake(identity, { channels: ['hilog'] });
    expect(
      api.HandshakeSchema.safeParse({
        ...hello,
        channels: [...hello.channels, ...hello.channels],
      }).success
    ).toBe(false);
  });

  it('preserves every required envelope field', async () => {
    const api = await protocol();
    expect(api.EventEnvelopeSchema.parse(event())).toEqual(event());
    for (const field of Object.keys(event())) {
      const input: Record<string, unknown> = { ...event() };
      delete input[field];
      expect(api.EventEnvelopeSchema.safeParse(input).success, field).toBe(
        false
      );
    }
  });

  it.each([
    { type: 'command' },
    { capability: 'hilog.write' },
    { capability: 'ui.read' },
    { sequence: 0 },
    { monotonicNs: '-1' },
    { monotonicNs: '01' },
    { monotonicNs: '18446744073709551616' },
    { wallTimeUtc: 'not-a-date' },
    { offsetUncertaintyMs: -1 },
    { payload: { level: 'info', summary: { token: 'fixture' } } },
    { payload: { level: 'info', summary: 'safe', credentials: {} } },
    { payload: { level: 'info', summary: 'safe', body: 'fixture' } },
    { payload: { level: 'info', summary: 'x'.repeat(1025) } },
    { redaction: { policyId: 'default', fieldsRemoved: 0, credentials: {} } },
    { credentials: {} },
  ])('rejects unsafe event %j', async (patch) => {
    const api = await protocol();
    expect(api.EventEnvelopeSchema.safeParse(event(1, patch)).success).toBe(
      false
    );
  });

  it('accepts network metadata but never captured bodies or credentials', async () => {
    const api = await protocol();
    const network = event(1, {
      channel: 'app.network',
      capability: 'app.network.read',
      payload: {
        requestId: 'request-1',
        method: 'GET',
        status: 200,
        durationMs: 12,
        bodyMetadata: { captured: false, byteLength: 20 },
      },
    });
    expect(api.EventEnvelopeSchema.safeParse(network).success).toBe(true);
    for (const extra of [
      { body: {} },
      { credentials: {} },
      { headers: {} },
      { bodyMetadata: { captured: true, byteLength: 20 } },
    ]) {
      expect(
        api.EventEnvelopeSchema.safeParse({
          ...network,
          payload: { ...network.payload, ...extra },
        }).success
      ).toBe(false);
    }
  });

  it.each(['', 'nan', '1e3', 'x'.repeat(50)])(
    'rejects malformed monotonicNs %j without throwing parser errors',
    async (value) => {
      const api = await protocol();
      expect(
        api.EventEnvelopeSchema.safeParse(event(1, { monotonicNs: value }))
          .success
      ).toBe(false);
    }
  );
});
