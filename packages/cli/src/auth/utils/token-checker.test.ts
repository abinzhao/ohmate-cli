/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.hoisted(() => vi.fn());
const parseJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/http-client', () => ({
  httpClient: { get: httpGetMock, parseJson: parseJsonMock },
}));

const loadJwtTokenMock = vi.hoisted(() => vi.fn());
const clearTokenMock = vi.hoisted(() => vi.fn());
vi.mock('./token-storage', () => ({
  tokenStorage: { loadJwtToken: loadJwtTokenMock, clearToken: clearTokenMock },
}));

import { ApiEndpoints } from '../auth-config.js';
import { TokenChecker } from './token-checker.js';
import type { TokenCheckResponse } from '../types/auth-types.js';

const BASE_URL = 'https://default.example.com';
const CHECK_URL = `${BASE_URL}/${ApiEndpoints.JWT_TOKEN_CHECK_PATH}`;

function okResponse(body: TokenCheckResponse): {
  statusCode: number;
  body: TokenCheckResponse;
} {
  return { statusCode: 200, body };
}

describe('TokenChecker', () => {
  let checker: TokenChecker;

  beforeEach(() => {
    checker = new TokenChecker();
    httpGetMock.mockReset();
    parseJsonMock.mockReset();
    loadJwtTokenMock.mockReset();
    clearTokenMock.mockReset();
  });

  describe('checkJwtToken', () => {
    it('GETs the check path with the token header and returns the parsed body', async () => {
      const body: TokenCheckResponse = {
        status: true,
        userInfo: {
          accessToken: 'at',
          nationalCode: 'CN',
          realName: 'true',
        },
      };
      const response = okResponse(body);
      httpGetMock.mockResolvedValue(response);
      parseJsonMock.mockReturnValue(body);

      await expect(checker.checkJwtToken('jwt-1', BASE_URL)).resolves.toBe(
        body
      );

      expect(httpGetMock).toHaveBeenCalledWith(CHECK_URL, {
        headers: { refresh: 'false', jwtToken: 'jwt-1' },
      });
      expect(parseJsonMock).toHaveBeenCalledWith(response);
    });

    it('propagates refresh=true as the refresh header', async () => {
      httpGetMock.mockResolvedValue(okResponse({ status: true }));
      await checker.checkJwtToken('jwt-1', BASE_URL, true);
      expect(httpGetMock).toHaveBeenCalledWith(CHECK_URL, {
        headers: { refresh: 'true', jwtToken: 'jwt-1' },
      });
    });

    it('throws on a non-200 status code', async () => {
      httpGetMock.mockResolvedValue({ statusCode: 500 });
      await expect(checker.checkJwtToken('jwt-1', BASE_URL)).rejects.toThrow(
        'Failed to check jwtToken: 500'
      );
      expect(parseJsonMock).not.toHaveBeenCalled();
    });
  });

  describe('refreshToken', () => {
    it('returns null when no jwt token is stored on disk', async () => {
      loadJwtTokenMock.mockResolvedValue(null);
      await expect(checker.refreshToken(BASE_URL)).resolves.toBe(null);
      expect(httpGetMock).not.toHaveBeenCalled();
    });

    it('refreshes the stored token and returns the new token pair', async () => {
      loadJwtTokenMock.mockResolvedValue('jwt-1');
      const body: TokenCheckResponse = {
        status: true,
        userInfo: {
          accessToken: 'new-at',
          refreshToken: 'new-rt',
          nationalCode: 'CN',
          realName: 'true',
        },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);

      await expect(checker.refreshToken(BASE_URL)).resolves.toEqual({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });
      expect(httpGetMock).toHaveBeenCalledWith(CHECK_URL, {
        headers: { refresh: 'true', jwtToken: 'jwt-1' },
      });
    });
  });

  describe('refreshTokenWithToken', () => {
    it('returns null on a non-200 status code', async () => {
      httpGetMock.mockResolvedValue({ statusCode: 401 });
      await expect(
        checker.refreshTokenWithToken('jwt-1', BASE_URL)
      ).resolves.toBe(null);
    });

    it('returns null when the check reports failure or no user info', async () => {
      httpGetMock.mockResolvedValue(okResponse({ status: false }));
      parseJsonMock.mockReturnValue({ status: false });
      await expect(
        checker.refreshTokenWithToken('jwt-1', BASE_URL)
      ).resolves.toBe(null);

      httpGetMock.mockResolvedValue(okResponse({ status: true }));
      parseJsonMock.mockReturnValue({ status: true });
      await expect(
        checker.refreshTokenWithToken('jwt-1', BASE_URL)
      ).resolves.toBe(null);
    });

    it('defaults a missing refreshToken to an empty string', async () => {
      const body: TokenCheckResponse = {
        status: true,
        userInfo: { accessToken: 'at', nationalCode: 'CN', realName: 'true' },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);
      await expect(
        checker.refreshTokenWithToken('jwt-1', BASE_URL)
      ).resolves.toEqual({ accessToken: 'at', refreshToken: '' });
    });

    it('logs and returns null when the request itself fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      httpGetMock.mockRejectedValue(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      );
      await expect(
        checker.refreshTokenWithToken('jwt-1', BASE_URL)
      ).resolves.toBe(null);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to refresh token')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ECONNRESET')
      );
      errorSpy.mockRestore();
    });
  });

  describe('getUserInfoFromJwt', () => {
    it('maps a valid check response into UserInfo', async () => {
      const body: TokenCheckResponse = {
        status: true,
        userInfo: {
          accessToken: 'at',
          refreshToken: 'rt',
          nationalCode: 'RU',
          realName: 'true',
          name: 'Alice',
          userId: 'u-1',
        },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);

      await expect(
        checker.getUserInfoFromJwt('jwt-1', BASE_URL)
      ).resolves.toEqual({
        userId: 'u-1',
        userName: 'Alice',
        accessToken: 'at',
        refreshToken: 'rt',
        jwtToken: 'jwt-1',
        countryCode: 'RU',
        language: 'ru_RU',
        isRealName: true,
      });
      expect(clearTokenMock).not.toHaveBeenCalled();
    });

    it('defaults optional fields and flags non-real-name accounts', async () => {
      const body: TokenCheckResponse = {
        status: true,
        userInfo: {
          accessToken: 'at',
          nationalCode: 'CN',
          realName: 'false',
        },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);

      const userInfo = await checker.getUserInfoFromJwt('jwt-1', BASE_URL);
      expect(userInfo).toEqual({
        userId: '',
        userName: '',
        accessToken: 'at',
        refreshToken: '',
        jwtToken: 'jwt-1',
        countryCode: 'CN',
        language: 'zh_CN',
        isRealName: false,
      });
    });

    it('clears the stored token and returns null when the token is invalid', async () => {
      const body: TokenCheckResponse = {
        status: false,
        userInfo: {
          accessToken: '',
          nationalCode: 'CN',
          realName: 'true',
        },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);

      await expect(checker.getUserInfoFromJwt('jwt-1', BASE_URL)).resolves.toBe(
        null
      );
      expect(clearTokenMock).toHaveBeenCalledTimes(1);
    });

    it('clears the stored token when the response lacks an accessToken', async () => {
      const body: TokenCheckResponse = {
        status: true,
        userInfo: {
          accessToken: '',
          nationalCode: 'CN',
          realName: 'true',
        },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);

      await expect(checker.getUserInfoFromJwt('jwt-1', BASE_URL)).resolves.toBe(
        null
      );
      expect(clearTokenMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchUserInfo', () => {
    it('returns null without a request when nothing is stored', async () => {
      loadJwtTokenMock.mockResolvedValue(null);
      await expect(checker.fetchUserInfo(BASE_URL, false)).resolves.toBe(null);
      expect(httpGetMock).not.toHaveBeenCalled();
    });

    it('loads the stored token and forwards the refresh flag', async () => {
      loadJwtTokenMock.mockResolvedValue('jwt-1');
      const body: TokenCheckResponse = {
        status: true,
        userInfo: {
          accessToken: 'at',
          refreshToken: 'rt',
          nationalCode: 'CN',
          realName: 'true',
          name: 'Alice',
          userId: 'u-1',
        },
      };
      httpGetMock.mockResolvedValue(okResponse(body));
      parseJsonMock.mockReturnValue(body);

      const userInfo = await checker.fetchUserInfo(BASE_URL, true);
      expect(userInfo?.userName).toBe('Alice');
      expect(httpGetMock).toHaveBeenCalledWith(CHECK_URL, {
        headers: { refresh: 'true', jwtToken: 'jwt-1' },
      });
    });
  });
});
