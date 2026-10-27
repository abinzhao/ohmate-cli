/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { httpClient } from '../../utils/http-client';
import { tokenStorage } from './token-storage';
import type { TokenCheckResponse, UserInfo } from '../types/auth-types';
import { ApiEndpoints } from '../auth-config';
import { getLanguageByCountryCode } from './region';
import { debugLog } from '../../utils/logger';

/**
 * Token 检查服务
 * 负责 JWT Token 的有效性检查和刷新
 */
export class TokenChecker {
  /**
   * 检查 JWT Token 有效性
   * @param jwtToken JWT Token 字符串
   * @param regionalizedBaseUrl 区域化基础 URL
   * @param refresh 是否刷新 accessToken，默认 false
   * @returns Token 检查响应，包含用户信息和状态
   */
  async checkJwtToken(
    jwtToken: string,
    regionalizedBaseUrl: string,
    refresh: boolean = false
  ): Promise<TokenCheckResponse> {
    const headers = {
      refresh: String(refresh),
      jwtToken: jwtToken,
    };

    const url = `${regionalizedBaseUrl}/${ApiEndpoints.JWT_TOKEN_CHECK_PATH}`;
    const response = await httpClient.get(url, { headers });

    if (response.statusCode !== 200) {
      throw new Error(`Failed to check jwtToken: ${response.statusCode}`);
    }

    const result = httpClient.parseJson<TokenCheckResponse>(response);
    return result;
  }

  /**
   * 刷新 accessToken
   * 从磁盘加载 JWT Token 并刷新
   * @param regionalizedBaseUrl 区域化基础 URL
   * @returns 刷新后的 Token 对，如果失败返回 null
   */
  async refreshToken(
    regionalizedBaseUrl: string
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return null;
    }
    return this.refreshTokenWithToken(jwtToken, regionalizedBaseUrl);
  }

  /**
   * 使用指定的 JWT Token 刷新 accessToken
   * @param jwtToken JWT Token 字符串
   * @param regionalizedBaseUrl 区域化基础 URL
   * @returns 刷新后的 Token 对，如果失败返回 null
   */
  async refreshTokenWithToken(
    jwtToken: string,
    regionalizedBaseUrl: string
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const headers: Record<string, string> = {
        refresh: 'true',
        jwtToken: jwtToken,
      };

      const url = `${regionalizedBaseUrl}/${ApiEndpoints.JWT_TOKEN_CHECK_PATH}`;
      const response = await httpClient.get(url, { headers });

      if (response.statusCode !== 200) {
        return null;
      }

      const result = httpClient.parseJson<TokenCheckResponse>(response);
      if (!result.status || !result.userInfo) {
        return null;
      }

      return {
        accessToken: result.userInfo.accessToken,
        refreshToken: result.userInfo.refreshToken ?? '',
      };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.error(
        `Failed to refresh token: ${e.code ?? ''} ${e.message ?? ''}`
      );
      return null;
    }
  }

  /**
   * 从 JWT Token 获取用户信息
   * @param jwtToken JWT Token 字符串
   * @param regionalizedBaseUrl 区域化基础 URL
   * @param refresh 是否刷新 accessToken，默认 false
   * @returns 用户信息对象，失效返回 null
   */
  async getUserInfoFromJwt(jwtToken: string, regionalizedBaseUrl: string, refresh: boolean = false): Promise<UserInfo | null> {
    const tokenInfo = await this.checkJwtToken(jwtToken, regionalizedBaseUrl, refresh);
    if (!tokenInfo.status || !tokenInfo.userInfo || !tokenInfo.userInfo.accessToken) {
      debugLog('jwtToken invalid.');
      await tokenStorage.clearToken();
      return null;
    }

    const userInfo: UserInfo = {
      userId: tokenInfo.userInfo.userId ?? '',
      userName: tokenInfo.userInfo.name ?? '',
      accessToken: tokenInfo.userInfo.accessToken,
      refreshToken: tokenInfo.userInfo.refreshToken ?? '',
      jwtToken: jwtToken,
      countryCode: tokenInfo.userInfo.nationalCode,
      language: getLanguageByCountryCode(tokenInfo.userInfo.nationalCode),
      isRealName: String(tokenInfo.userInfo.realName) === 'true',
    };

    return userInfo;
  }

  /**
   * 从磁盘加载 JWT Token 并获取用户信息
   * @param regionalizedBaseUrl 区域化基础 URL
   * @param refresh 是否刷新 accessToken
   * @returns 用户信息，未登录返回 null
   */
  async fetchUserInfo(
    regionalizedBaseUrl: string,
    refresh: boolean
  ): Promise<UserInfo | null> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return null;
    }
    return this.getUserInfoFromJwt(jwtToken, regionalizedBaseUrl, refresh);
  }
}

// 单例导出
export const tokenChecker = new TokenChecker();
