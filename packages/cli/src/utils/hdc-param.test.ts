/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { classifyPidofResult } from './hdc-param.js';

function result(
  stdout: string,
  stderr = '',
  exitCode = 0
): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr, exitCode };
}

describe('classifyPidofResult', () => {
  it('alive: clean exit with pid digits on stdout', () => {
    expect(classifyPidofResult(result('4321'))).toBe('alive');
    expect(classifyPidofResult(result('4321 8765\n'))).toBe('alive');
  });

  it('dead: pidof standard no-match (exit 1, no output)', () => {
    expect(classifyPidofResult(result('', '', 1))).toBe('dead');
  });

  it('dead: clean exit with empty stdout', () => {
    expect(classifyPidofResult(result(''))).toBe('dead');
  });

  it('query-failed: transient hdc text after retry budget', () => {
    expect(
      classifyPidofResult(
        result('', '[E000004] communication channel is being established', 1)
      )
    ).toBe('query-failed');
    expect(classifyPidofResult(result('', 'device offline', 1))).toBe(
      'query-failed'
    );
  });

  it('query-failed: fatal hdc text must not count as a dead process', () => {
    expect(
      classifyPidofResult(result('[Fail]Not found device target', '', 1))
    ).toBe('query-failed');
    expect(classifyPidofResult(result('', 'device unauthorized', 1))).toBe(
      'query-failed'
    );
    // shell-level "command not found" is a device/query problem, not a crash
    expect(classifyPidofResult(result('', 'sh: pidof: not found', 127))).toBe(
      'query-failed'
    );
  });

  it('query-failed: spawn failure or unexpected exit with stderr', () => {
    expect(classifyPidofResult(result('', 'spawn /hdc ENOENT', 1))).toBe(
      'query-failed'
    );
    expect(classifyPidofResult(result('', 'some hdc error', 255))).toBe(
      'query-failed'
    );
  });
});
