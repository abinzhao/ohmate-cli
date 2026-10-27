/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { maskTeamName, parseTeamListResponse } from './team-service.js';
import {
  AGC_SUCCESS_CODE,
  type AgcTeamListResponse,
} from '../types/auth-types.js';

describe('maskTeamName', () => {
  it('keeps the first half of the name and masks the rest with four asterisks', () => {
    expect(maskTeamName('李四')).toBe('李****');
    expect(maskTeamName('李寅生')).toBe('李****');
    // 'Yin****' 与 auth login/status 对账号 Yinsen 的服务端脱敏输出一致
    expect(maskTeamName('Yinsen')).toBe('Yin****');
    expect(maskTeamName('Alice')).toBe('Al****');
    expect(maskTeamName('A')).toBe('A****');
  });

  it('returns an empty string for empty names', () => {
    expect(maskTeamName('')).toBe('');
  });
});

describe('parseTeamListResponse', () => {
  const raw: AgcTeamListResponse = {
    ret: { code: AGC_SUCCESS_CODE },
    teams: [
      {
        id: '1001',
        upSiteId: 1,
        name: '李四',
        countryCode: 'CN',
        siteId: 1,
        userType: 0,
        lastLoginTime: '2026-01-01 00:00:00',
        isMirror: false,
      },
    ],
  };

  it('masks personal names in team entries', () => {
    const teams = parseTeamListResponse(raw);
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe('李****');
    expect(teams[0].id).toBe('1001');
  });

  it('returns an empty list for non-object payloads or missing teams', () => {
    expect(parseTeamListResponse(null)).toEqual([]);
    expect(parseTeamListResponse('oops')).toEqual([]);
    expect(parseTeamListResponse({ ret: { code: AGC_SUCCESS_CODE } })).toEqual(
      []
    );
  });

  it('throws when the API reports a failure code', () => {
    expect(() =>
      parseTeamListResponse({ ret: { code: 1001, msg: 'denied' } })
    ).toThrow('team list request failed: code=1001, msg=denied');
  });

  it('drops entries without an id and defaults a missing name to empty', () => {
    const teams = parseTeamListResponse({
      ret: { code: AGC_SUCCESS_CODE },
      teams: [
        { id: '', name: '李四' },
        { id: '2', name: undefined },
        'not-a-team',
      ],
    });
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe('2');
    expect(teams[0].name).toBe('');
  });
});
