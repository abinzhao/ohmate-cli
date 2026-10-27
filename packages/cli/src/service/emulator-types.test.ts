/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { normalizeListNameKey, supportsHotBoot } from './emulator-types.js';

describe('normalizeListNameKey', () => {
  it('collapses repeated whitespace and trims', () => {
    expect(normalizeListNameKey('  My   Emulator ')).toBe('My Emulator');
    expect(normalizeListNameKey('a\tb\nc')).toBe('a b c');
  });

  it('normalizes full-width characters to ASCII (NFKC)', () => {
    expect(normalizeListNameKey('ＡＢＣ')).toBe('ABC');
    expect(normalizeListNameKey('　Ａ　Ｂ　')).toBe('A B');
  });

  it('returns the same key for equivalent unicode spellings', () => {
    expect(normalizeListNameKey('ＡＢＣ ｄｅｖ')).toBe(
      normalizeListNameKey('ABC dev')
    );
  });
});

describe('supportsHotBoot', () => {
  it('enables hot boot for API 26 and later', () => {
    expect(supportsHotBoot('6.0.1(26)')).toBe(true);
    expect(supportsHotBoot('6.0.1(26.1)')).toBe(true);
    expect(supportsHotBoot('7.0(31)')).toBe(true);
  });

  it('disables hot boot below API 26', () => {
    expect(supportsHotBoot('6.0.1(25)')).toBe(false);
    expect(supportsHotBoot('5.0.0(21)')).toBe(false);
  });

  it('disables hot boot when no API level is present', () => {
    expect(supportsHotBoot('6.0.1')).toBe(false);
    expect(supportsHotBoot('')).toBe(false);
    expect(supportsHotBoot('(26')).toBe(false);
  });

  it('reads full-width digits and parentheses via NFKC', () => {
    expect(supportsHotBoot('６.０.１（２８）')).toBe(true);
    expect(supportsHotBoot('６.０.１（２５）')).toBe(false);
  });
});
