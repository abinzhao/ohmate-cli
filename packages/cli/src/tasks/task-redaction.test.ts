/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { redactTaskValue } from './task-redaction.js';

describe('task output redaction', () => {
  it('removes token and authorization values from structured results and log text', () => {
    const result = redactTaskValue({
      accessToken: 'fixture-token', refresh_token: 'fixture-refresh',
      text: 'access_token=fixture-token {"authorization":"Bearer fixture-bearer"} password="fixture password"',
      tokenBudget: 100, keyEnv: 'OHMATE_FIXTURE_KEY',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('fixture-token');
    expect(text).not.toContain('fixture-refresh');
    expect(text).not.toContain('fixture-bearer');
    expect(text).not.toContain('fixture password');
    expect(result).toMatchObject({ tokenBudget: 100, keyEnv: 'OHMATE_FIXTURE_KEY' });
  });
});
