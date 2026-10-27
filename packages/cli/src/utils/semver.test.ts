/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { compareVersions, compareNumericVersions } from './semver.js';

describe('compareVersions', () => {
  it('compares SemVer precedence', async () => {
    expect(await compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(await compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(await compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('orders pre-releases before their release', async () => {
    expect(await compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(await compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0);
  });

  it('throws on malformed versions', async () => {
    await expect(compareVersions('not-a-version', '1.0.0')).rejects.toThrow();
    await expect(compareVersions('6.1.0.999', '1.0.0')).rejects.toThrow();
  });
});

describe('compareNumericVersions', () => {
  it('compares 4-segment build versions that semver rejects', () => {
    expect(compareNumericVersions('6.1.0.310', '6.1.0.320')).toBeLessThan(0);
    expect(compareNumericVersions('6.1.1.310', '6.1.0.999')).toBeGreaterThan(0);
    expect(compareNumericVersions('6.1.0.600', '6.1.0.600')).toBe(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareNumericVersions('6.1', '6.1.0')).toBe(0);
    expect(compareNumericVersions('6.1', '6.1.1')).toBeLessThan(0);
    expect(compareNumericVersions('6.2', '6.1.9')).toBeGreaterThan(0);
  });

  it('compares short and long forms numerically', () => {
    expect(compareNumericVersions('5', '4.3.0.256')).toBeGreaterThan(0);
    expect(compareNumericVersions('0.0.1', '1')).toBeLessThan(0);
  });
});
