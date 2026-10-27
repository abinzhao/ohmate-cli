/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { createInitialStatus } from './index-state.js';

describe('createInitialStatus', () => {
  it('marks the build as installing in phase 1', () => {
    const status = createInitialStatus('Starting documentation setup…');
    expect(status.state).toBe('installing');
    expect(status.phase).toBe(1);
    expect(status.phaseLabel).toBe('Preparing documentation index');
  });

  it('carries the provided message with no error', () => {
    const status = createInitialStatus('hello');
    expect(status.message).toBe('hello');
    expect(status.error).toBeNull();
  });

  it('zeroes progress counters', () => {
    const status = createInitialStatus('m');
    expect(status.current).toBe(0);
    expect(status.total).toBe(0);
  });

  it('stamps startedAt and updatedAt with the same recent timestamp', () => {
    const before = Date.now();
    const status = createInitialStatus('m');
    const after = Date.now();
    expect(status.startedAt).toBeGreaterThanOrEqual(before);
    expect(status.startedAt).toBeLessThanOrEqual(after);
    expect(status.updatedAt).toBe(status.startedAt);
  });
});
