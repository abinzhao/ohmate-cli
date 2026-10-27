/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { SmokeJudge } from './smoke-judge.js';
import { SmokeFormatter } from './smoke-formatter.js';
import { SmokeStatus, type SmokeEvidence } from './types.js';

const judge = new SmokeJudge();
const formatter = new SmokeFormatter();

describe('SmokeJudge', () => {
  it('FAIL_CRASH when process is dead', () => {
    const v = judge.judge({ processAlive: false, phashBlank: null });
    expect(v.passed).toBe(false);
    expect(v.status).toBe(SmokeStatus.FAIL_CRASH);
  });

  it('FAIL_BLANK when phash is blank', () => {
    const v = judge.judge({
      processAlive: true,
      phashBlank: true,
      phash: 'abc',
      phashHamming: 3,
      screenshotPath: '/tmp/x.png',
    });
    expect(v.passed).toBe(false);
    expect(v.status).toBe(SmokeStatus.FAIL_BLANK);
  });

  it('PASS when phash is not blank', () => {
    const v = judge.judge({
      processAlive: true,
      phashBlank: false,
      phashHamming: 24,
    });
    expect(v.passed).toBe(true);
    expect(v.status).toBe(SmokeStatus.PASS);
  });

  it('PASS when screenshot failed (phashBlank null)', () => {
    const evidence: SmokeEvidence = {
      processAlive: true,
      phashBlank: null,
      screenshotSkipped: true,
    };
    const v = judge.judge(evidence);
    expect(v.passed).toBe(true);
    expect(v.status).toBe(SmokeStatus.PASS);
  });

  it('PASS when the process check was unavailable (transport failure)', () => {
    const evidence: SmokeEvidence = {
      processAlive: true,
      phashBlank: null,
      processCheckSkipped: true,
    };
    const v = judge.judge(evidence);
    expect(v.passed).toBe(true);
    expect(v.status).toBe(SmokeStatus.PASS);
    expect(formatter.formatPass(v)).toBe(
      'Smoke: PASS (process check unavailable, smoke skipped)'
    );
  });
});

describe('SmokeFormatter', () => {
  const ctx = {
    targetDeviceId: '127.0.0.1:5555',
    bundleName: 'com.example.app',
  };

  it('failure output is Smoke: FAIL_CRASH with crash_log path', () => {
    const verdict = judge.judge({
      processAlive: false,
      phashBlank: null,
      crashLogPath: '/tmp/smoke-crash.log',
    });
    const text = formatter.formatFailure(verdict, ctx);
    expect(text.startsWith(`Smoke: ${SmokeStatus.FAIL_CRASH}`)).toBe(true);
    expect(text).toContain('crash_log: /tmp/smoke-crash.log');
    expect(text).not.toContain('crash_log_tail');
    expect(text).not.toContain('next_action');
    const err = formatter.toTraceError(verdict, ctx);
    expect(err.traceMessage).toBe(SmokeStatus.FAIL_CRASH);
  });

  it('FAIL_CRASH without crash log evidence omits the crash_log line', () => {
    const verdict = judge.judge({ processAlive: false, phashBlank: null });
    const text = formatter.formatFailure(verdict, ctx);
    expect(text.startsWith(`Smoke: ${SmokeStatus.FAIL_CRASH}`)).toBe(true);
    expect(text).not.toContain('crash_log');
  });

  it('failure output is Smoke: FAIL_BLANK', () => {
    const verdict = judge.judge({
      processAlive: true,
      phashBlank: true,
      phashHamming: 2,
      screenshotPath: '/tmp/s.png',
    });
    const text = formatter.formatFailure(verdict, ctx);
    expect(text.startsWith(`Smoke: ${SmokeStatus.FAIL_BLANK}`)).toBe(true);
    expect(text).toContain('screenshot: /tmp/s.png');
    expect(text).not.toContain('phash_hamming');
    expect(text).not.toContain('next_action');
  });
});
