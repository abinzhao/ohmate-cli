/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { httpClient } from '../../utils/http-client';
import { isValidJwtFormat } from '../utils/jwt';
import { getCountryCodeBySiteId } from '../utils/region';
import { AppConfig } from '../auth-config';

/**
 * 用户信息获取服务
 * 负责从临时 Token 换取 JWT Token
 */
export class UserInfoFetcher {
  /**
   * 获取 JWT Token
   * 使用临时 Token 和站点 ID 从服务器换取 JWT Token
   * @param tempToken 临时 Token
   * @param siteId 站点 ID
   * @param regionalizedBaseUrl 区域化基础 URL
   * @param tempTokenCheckUrl 临时 Token 检查 URL 路径
   * @param appId 应用 ID
   * @returns JWT Token 字符串
   */
  async getJwtToken(
    tempToken: string,
    siteId: string,
    regionalizedBaseUrl: string,
    tempTokenCheckUrl: string,
    appId: string
  ): Promise<string> {
    const actualTempToken = tempToken.split('&')[0];

    const countryCode = getCountryCodeBySiteId(siteId);

    const params = {
      tempToken: actualTempToken,
      site: countryCode,
      version: AppConfig.API_VERSION,
      appid: appId,
    };

    const url = `${regionalizedBaseUrl}/${tempTokenCheckUrl}`;
    const response = await httpClient.get(url, { params });

    if (response.statusCode !== 200) {
      throw new Error(`Failed to get jwtToken: status=${response.statusCode}`);
    }

    const jwtToken = response.data.trim();

    if (!isValidJwtFormat(jwtToken)) {
      throw new Error(`Invalid jwtToken format`);
    }

    return jwtToken;
  }
}

// 单例导出
export const userInfoFetcher = new UserInfoFetcher();
