/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { sha256Text } from './hash-utils.js';

describe('sha256Text', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'The quick brown fox jumps over the lazy dog',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    ],
  ])('sha256Text(%s) → known digest', (input, expected) => {
    expect(sha256Text(input)).toBe(expected);
  });

  it('encodes input as utf-8 (multibyte characters)', () => {
    // sha256 of the utf-8 bytes of '多字节字符'
    expect(sha256Text('多字节字符')).toBe(
      '1fad32a58a1c6aa6adf170a31c00e12814f471ea236562fda9664dd6c8cd7b1c'
    );
  });

  it('is deterministic across repeated calls', () => {
    const input = 'x'.repeat(1000);
    expect(sha256Text(input)).toBe(sha256Text(input));
  });

  it('produces 64-character lowercase hex', () => {
    expect(sha256Text('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
