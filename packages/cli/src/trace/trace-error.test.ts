/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { TraceError, toTraceErrorCode } from './trace-error.js';

describe('TraceError', () => {
  it('defaults traceMessage to the original message', () => {
    const err = new TraceError('boom');
    expect(err.message).toBe('boom');
    expect(err.traceMessage).toBe('boom');
    expect(err.name).toBe('TraceError');
    expect(err instanceof Error).toBe(true);
  });

  it('keeps the raw message separate from the sanitized trace message', () => {
    const err = new TraceError('/home/user/secret/path failed', 'io failure');
    expect(err.message).toBe('/home/user/secret/path failed');
    expect(err.traceMessage).toBe('io failure');
  });
});

describe('toTraceErrorCode', () => {
  it('uses the sanitized traceMessage for TraceError', () => {
    expect(toTraceErrorCode(new TraceError('raw', 'safe'))).toBe('safe');
    expect(toTraceErrorCode(new TraceError('raw'))).toBe('raw');
  });

  it('prefers the error code for plain Errors', () => {
    const err = new Error(
      'no such file: /secret/path'
    ) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    expect(toTraceErrorCode(err)).toBe('ENOENT');
  });

  it('falls back to the error name when the code is missing or empty', () => {
    expect(toTraceErrorCode(new Error('no code'))).toBe('Error');
    const named = new Error('custom');
    named.name = 'ValidationError';
    expect(toTraceErrorCode(named)).toBe('ValidationError');
    const empty = new Error('empty code') as NodeJS.ErrnoException;
    empty.code = '';
    expect(toTraceErrorCode(empty)).toBe('Error');
  });

  it('maps non-Error values to UnknownError', () => {
    expect(toTraceErrorCode('string')).toBe('UnknownError');
    expect(toTraceErrorCode(undefined)).toBe('UnknownError');
    expect(toTraceErrorCode({ code: 'ENOENT' })).toBe('UnknownError');
  });
});
