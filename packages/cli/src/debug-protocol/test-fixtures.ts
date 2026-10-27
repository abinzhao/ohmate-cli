/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs';
import { expect } from 'vitest';

export const identity = {
  project: 'fixture-project',
  buildId: 'fixture-build',
  device: 'fixture-device',
  process: 'fixture-process',
  sessionId: 'fixture-session',
  fingerprint: 'a'.repeat(64),
};

export async function protocol(): Promise<typeof import('./index.js')> {
  expect(
    existsSync(new URL('./index.ts', import.meta.url)),
    'the importable read-only protocol entry is missing'
  ).toBe(true);
  const entry = './index.js';
  return import(entry);
}

export function event(sequence = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    protocolVersion: '1.1',
    channelVersion: '1.0',
    messageId: `fixture-message-${sequence}`,
    sessionEpoch: 'epoch-1',
    sequence,
    channel: 'hilog',
    type: 'event',
    capability: 'hilog.read',
    clockId: 'fixture-clock',
    bootId: 'fixture-boot',
    wallTimeUtc: '2026-10-23T00:00:00Z',
    monotonicNs: String(sequence),
    offsetUncertaintyMs: 5,
    payload: { level: 'info', summary: 'Redacted fixture summary' },
    redaction: { policyId: 'fixture-policy', fieldsRemoved: 0 },
    ...overrides,
  };
}
