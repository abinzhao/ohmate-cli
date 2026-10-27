/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  DIRECTION_MAP,
  assertCoord,
  assertOptionalCoord,
  assertCoordsPair,
  assertNonEmpty,
  assertSpeed,
  assertWindowId,
  assertTargetRule,
  assertTargetParams,
} from './types.js';

describe('DIRECTION_MAP', () => {
  it('pins the direction codes', () => {
    expect(DIRECTION_MAP).toEqual({
      left: '0',
      right: '1',
      up: '2',
      down: '3',
    });
  });
});

describe('assertCoord', () => {
  it('accepts positive integers', () => {
    expect(() => assertCoord('1', 'x')).not.toThrow();
    expect(() => assertCoord('999', 'y')).not.toThrow();
  });

  it('rejects zero, negatives, floats and non-numbers', () => {
    expect(() => assertCoord('0', 'x')).toThrow('x must be a positive integer');
    expect(() => assertCoord('-5', 'x')).toThrow(
      'x must be a positive integer'
    );
    expect(() => assertCoord('1.5', 'x')).toThrow(
      'x must be a positive integer'
    );
    expect(() => assertCoord('abc', 'x')).toThrow(
      'x must be a positive integer'
    );
    expect(() => assertCoord('', 'x')).toThrow('x must be a positive integer');
  });
});

describe('assertOptionalCoord', () => {
  it('skips undefined values', () => {
    expect(() => assertOptionalCoord(undefined, 'x')).not.toThrow();
  });

  it('validates provided values', () => {
    expect(() => assertOptionalCoord('10', 'x')).not.toThrow();
    expect(() => assertOptionalCoord('0', 'x')).toThrow();
  });
});

describe('assertCoordsPair', () => {
  it('accepts both-or-neither', () => {
    expect(() => assertCoordsPair(undefined, undefined)).not.toThrow();
    expect(() => assertCoordsPair('1', '2')).not.toThrow();
  });

  it('rejects half pairs', () => {
    expect(() => assertCoordsPair('1', undefined)).toThrow(
      'x and y must be provided together'
    );
    expect(() => assertCoordsPair(undefined, '2')).toThrow(
      'x and y must be provided together'
    );
  });
});

describe('assertNonEmpty', () => {
  it('accepts undefined and non-empty strings', () => {
    expect(() => assertNonEmpty(undefined, '--id')).not.toThrow();
    expect(() => assertNonEmpty('win-1', '--id')).not.toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => assertNonEmpty('', '--id')).toThrow('--id must not be empty');
  });
});

describe('assertSpeed', () => {
  it('returns undefined when not provided', () => {
    expect(assertSpeed(undefined)).toBeUndefined();
  });

  it('accepts integers within [200, 40000] and echoes the raw text', () => {
    expect(assertSpeed('200')).toBe('200');
    expect(assertSpeed('40000')).toBe('40000');
    expect(assertSpeed('1000')).toBe('1000');
  });

  it('rejects out-of-range, float and non-integer values', () => {
    expect(() => assertSpeed('199')).toThrow(
      '--speed must be an integer between 200 and 40000'
    );
    expect(() => assertSpeed('40001')).toThrow(
      '--speed must be an integer between 200 and 40000'
    );
    expect(() => assertSpeed('1.5')).toThrow(
      '--speed must be an integer between 200 and 40000'
    );
    expect(() => assertSpeed('fast')).toThrow(
      '--speed must be an integer between 200 and 40000'
    );
  });
});

describe('assertWindowId', () => {
  it('accepts letters, digits, dashes and underscores', () => {
    expect(() => assertWindowId(undefined)).not.toThrow();
    expect(() => assertWindowId('main-Window_1')).not.toThrow();
  });

  it('rejects other characters', () => {
    expect(() => assertWindowId('bad id')).toThrow(
      '--window must consist of letters, digits, - or _'
    );
    expect(() => assertWindowId('win/1')).toThrow(
      '--window must consist of letters, digits, - or _'
    );
    expect(() => assertWindowId('')).toThrow(
      '--window must consist of letters, digits, - or _'
    );
  });
});

describe('assertTargetRule', () => {
  it('accepts coordinates or id targets', () => {
    expect(() => assertTargetRule(true, false, false)).not.toThrow();
    expect(() => assertTargetRule(false, true, false)).not.toThrow();
    expect(() => assertTargetRule(false, true, true)).not.toThrow();
  });

  it('rejects --window without --id', () => {
    expect(() => assertTargetRule(true, false, true)).toThrow(
      '--window must be used with --id'
    );
    expect(() => assertTargetRule(false, false, true)).toThrow(
      '--window must be used with --id'
    );
  });

  it('rejects coordinates combined with --id', () => {
    expect(() => assertTargetRule(true, true, false)).toThrow(
      'Coordinates and --id are mutually exclusive'
    );
  });

  it('requires a target unless requireOne is false', () => {
    expect(() => assertTargetRule(false, false, false)).toThrow(
      'Either provide x y coordinates or use --id'
    );
    expect(() => assertTargetRule(false, false, false, false)).not.toThrow();
  });
});

describe('assertTargetParams', () => {
  it('accepts a coordinate pair', () => {
    expect(() =>
      assertTargetParams('10', '20', undefined, undefined)
    ).not.toThrow();
  });

  it('accepts an id with a window', () => {
    expect(() =>
      assertTargetParams(undefined, undefined, 'id-1', 'win_1')
    ).not.toThrow();
  });

  it('enforces pair completeness before the target rule', () => {
    expect(() =>
      assertTargetParams('10', undefined, undefined, undefined)
    ).toThrow('x and y must be provided together');
  });

  it('rejects window without id', () => {
    expect(() =>
      assertTargetParams(undefined, undefined, undefined, 'win')
    ).toThrow('--window must be used with --id');
  });

  it('rejects coordinates and id together', () => {
    expect(() => assertTargetParams('10', '20', 'id-1', undefined)).toThrow(
      'Coordinates and --id are mutually exclusive'
    );
  });

  it('rejects invalid coordinate values', () => {
    expect(() => assertTargetParams('0', '20', undefined, undefined)).toThrow(
      'x must be a positive integer'
    );
  });

  it('allows no target when requireOne is false', () => {
    expect(() =>
      assertTargetParams(undefined, undefined, undefined, undefined, false)
    ).not.toThrow();
  });
});
