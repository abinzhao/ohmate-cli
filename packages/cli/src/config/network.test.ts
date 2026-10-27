/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { TimeConstants, NetworkConstants } from './network.js';

describe('TimeConstants', () => {
  it('pins the timeout and validity values', () => {
    expect(TimeConstants.LOGIN_TIMEOUT_MS).toBe(600000);
    expect(TimeConstants.HTTP_TIMEOUT_MS).toBe(20000);
    expect(TimeConstants.TOKEN_VALIDITY_DAYS).toBe(30);
  });
});

describe('NetworkConstants', () => {
  it('pins a Chrome user agent and the accept language', () => {
    expect(NetworkConstants.USER_AGENT.startsWith('Mozilla/5.0')).toBe(true);
    expect(NetworkConstants.USER_AGENT).toContain('Chrome/131.0.0.0');
    expect(NetworkConstants.ACCEPT_LANGUAGE).toBe('zh-CN');
  });
});
