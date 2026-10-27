/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { isValidJwtFormat, parseJwtPayload } from './jwt.js';
import type { JwtPayload } from '../types/auth-types.js';

/** Build a three-part token whose payload encodes `value` as base64url. */
function tokenWithPayload(value: unknown): string {
  const json = JSON.stringify(value);
  const payload = Buffer.from(json, 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

const PAYLOAD: JwtPayload = {
  userId: 'u-123',
  userName: '中文用户',
  exp: 1893456000,
  iat: 1600000000,
};

describe('parseJwtPayload', () => {
  it('decodes the payload of a well-formed token', () => {
    expect(parseJwtPayload(tokenWithPayload(PAYLOAD))).toEqual(PAYLOAD);
  });

  it('decodes payload JSON of every base64 padding class', () => {
    // JSON of 1, 2 and 3 bytes exercises all three base64 padding amounts.
    expect(parseJwtPayload(tokenWithPayload(1))).toBe(1);
    expect(parseJwtPayload(tokenWithPayload(12))).toBe(12);
    expect(parseJwtPayload(tokenWithPayload(123))).toBe(123);
  });

  it('keeps UTF-8 (Chinese) field values intact', () => {
    const token = tokenWithPayload({ name: '鸿蒙开发者' });
    expect(parseJwtPayload<{ name: string }>(token)).toEqual({
      name: '鸿蒙开发者',
    });
  });

  it('returns null when the token does not have exactly three parts', () => {
    expect(parseJwtPayload('')).toBe(null);
    expect(parseJwtPayload('onlyheader')).toBe(null);
    expect(parseJwtPayload('header.payload')).toBe(null);
    expect(parseJwtPayload('a.b.c.d')).toBe(null);
  });

  it('returns null when the payload is empty', () => {
    expect(parseJwtPayload('h..s')).toBe(null);
  });

  it('returns null when the payload is not valid JSON', () => {
    const garbage = Buffer.from('not json at all', 'utf8').toString(
      'base64url'
    );
    expect(parseJwtPayload(`h.${garbage}.s`)).toBe(null);
  });

  it('returns null when the payload contains no decodable base64', () => {
    // Characters invalid in base64 are dropped by the decoder, leaving an
    // empty buffer that JSON.parse cannot read.
    expect(parseJwtPayload('h.!!!.s')).toBe(null);
  });
});

describe('isValidJwtFormat', () => {
  it('accepts a token with three non-empty segments', () => {
    expect(isValidJwtFormat('header.payload.signature')).toBe(true);
  });

  it('rejects tokens without exactly three segments', () => {
    expect(isValidJwtFormat('')).toBe(false);
    expect(isValidJwtFormat('payload')).toBe(false);
    expect(isValidJwtFormat('header.payload')).toBe(false);
    expect(isValidJwtFormat('a.b.c.d')).toBe(false);
  });

  it('rejects tokens with empty segments', () => {
    expect(isValidJwtFormat('..')).toBe(false);
    expect(isValidJwtFormat('header.payload.')).toBe(false);
    expect(isValidJwtFormat('header..signature')).toBe(false);
    expect(isValidJwtFormat('.payload.signature')).toBe(false);
  });
});
