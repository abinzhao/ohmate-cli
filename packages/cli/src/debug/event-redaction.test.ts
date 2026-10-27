/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { redactDebugEvent } from './event-redaction.js';
import { event } from '../debug-protocol/test-fixtures.js';
import { EventEnvelopeSchema } from '../debug-protocol/envelopes.js';

describe('bounded native Console source metadata', () => {
  for (let source = 0; source <= 12; source++) {
    it(`preserves source ${source} metadata without changing the input`, () => {
      const summary = `source-${source};script;line-1000000;frame-column-unverified;[MEMORY_ONLY]`;
      const original = EventEnvelopeSchema.parse(event(1, { channel: 'arkweb.console', capability: 'arkweb.console.read',
        payload: { level: 'warn', summary } }));
      const redacted = redactDebugEvent(original);
      expect(redacted.payload).toEqual({ level: 'warn', summary });
      expect(redacted.redaction.fieldsRemoved).toBe(original.redaction.fieldsRemoved);
      expect(redacted).not.toBe(original);
    });
  }
  for (const summary of [
    'source-13;page;line-1;frame-column-unverified;[MEMORY_ONLY]',
    'source-3;page;line-1000001;frame-column-unverified;[MEMORY_ONLY]',
    'source-3;page;line-01;frame-column-unverified;[MEMORY_ONLY]',
    'source-3;page;line-1;frame-main;[MEMORY_ONLY]',
    'source-3;https://example.invalid/login;line-1;frame-column-unverified;[MEMORY_ONLY]',
    'source-3;page;line-1;frame-column-unverified;[MEMORY_ONLY];TEST_ONLY',
    'source-3;page;line-1;frame-column-unverified;[MEMORY_ONLY]\n',
    'PRIVATE_TEST_ONLY',
  ]) {
    it(`masks unrecognized Console metadata ${JSON.stringify(summary)}`, () => {
      const redacted = redactDebugEvent(EventEnvelopeSchema.parse(event(1, {
        channel: 'arkweb.console', capability: 'arkweb.console.read', payload: { level: 'warn', summary },
      })));
      expect(redacted.payload).toEqual({ level: 'warn', summary: '[MEMORY_ONLY]' });
    });
  }
  for (const channel of ['arkweb.dom', 'arkweb.storage', 'ui']) {
    it(`does not reuse the Console exception for ${channel}`, () => {
      const summary = 'source-3;page;line-1;frame-column-unverified;[MEMORY_ONLY]';
      const payload = channel === 'ui' ? { windowId: 'page', nodeCount: 1, summary } :
        channel === 'arkweb.dom' ? { targetId: 'web-main', nodeCount: 1, summary } :
          { targetId: 'web-main', entryCount: 1, summary };
      expect(redactDebugEvent(EventEnvelopeSchema.parse(event(1, { channel, capability: channel + '.read', payload }))).payload)
        .toMatchObject({ summary: '[MEMORY_ONLY]' });
    });
  }
});

describe('fixed Cookie metadata source', () => {
  const summary = 'url-related-incognito-unpartitioned;attributes-not-captured;local-session-disabled;' +
    'indexeddb-cache-not-supported;quota-unavailable;[MEMORY_ONLY]';
  it('preserves only the fixed scope summary and the count without modifying the input', () => {
    const original = EventEnvelopeSchema.parse(event(1, { channel: 'arkweb.storage', capability: 'arkweb.storage.read',
      payload: { targetId: 'web-main', entryCount: 0, summary } }));
    expect(redactDebugEvent(original).payload).toEqual(original.payload);
    expect(original.payload).toEqual({ targetId: 'web-main', entryCount: 0, summary });
  });
  for (const value of [summary + ';TEST_ONLY', summary + '\n', summary.replace('quota-unavailable', 'quota-1'),
    summary.replace('attributes-not-captured', 'httponly-true'), 'Cookie=PRIVATE_TEST_ONLY']) {
    it(`masks arbitrary Storage text ${JSON.stringify(value)}`, () => {
      const original = EventEnvelopeSchema.parse(event(1, { channel: 'arkweb.storage', capability: 'arkweb.storage.read',
        payload: { targetId: 'web-main', entryCount: 2, summary: value } }));
      expect(redactDebugEvent(original).payload).toEqual({ targetId: 'web-main', entryCount: 2, summary: '[MEMORY_ONLY]' });
    });
  }
  it('does not apply the Cookie exception to DOM summaries', () => {
    const original = EventEnvelopeSchema.parse(event(1, { channel: 'arkweb.dom', capability: 'arkweb.dom.read',
      payload: { targetId: 'web-main', nodeCount: 1, summary } }));
    expect(redactDebugEvent(original).payload).toMatchObject({ summary: '[MEMORY_ONLY]' });
  });
});
