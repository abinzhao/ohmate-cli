/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { DefinedError } from './errors.js';

describe('DefinedError', () => {
  it('is an Error carrying its message', () => {
    const error = new DefinedError('login cancelled by user');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DefinedError);
    expect(error.message).toBe('login cancelled by user');
  });

  it('reports DefinedError as its name', () => {
    expect(new DefinedError('boom').name).toBe('DefinedError');
  });

  it('is catchable via instanceof narrowing', () => {
    const thrower = (): void => {
      throw new DefinedError('not logged in');
    };
    expect(thrower).toThrow(DefinedError);
    expect(thrower).toThrow('not logged in');
  });
});
