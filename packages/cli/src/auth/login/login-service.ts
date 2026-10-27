/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as crypto from 'crypto';
import { LocalAuthServer } from './local-auth-server';
import { tokenStorage, isDevecoCodeAuth } from '../utils/token-storage';
import type { UserInfo, LoginConfig } from '../types/auth-types';
import { DEFAULT_LOGIN_CONFIG, ApiEndpoints } from '../auth-config';
import { openBrowser } from './browser';
import { userInfoFetcher } from './user-info-fetcher';
import { tokenChecker } from '../utils/token-checker';
import { httpClient } from '../../utils/http-client';
import { DefinedError } from '../utils/errors.js';
import { debugLog } from '../../utils/logger';
import { reportAgreementSigned } from './agreement-sign';

/**
 * 登录服务类
 * 负责处理用户认证、Token 管理和会话维护
 *
 */
export class LoginService {
  private config: LoginConfig;
  private server: LocalAuthServer | null = null;

  /**
   * 创建登录服务实例
   * @param config 可选的配置参数，会与默认配置合并
   */
  constructor(config?: Partial<LoginConfig>) {
    this.config = { ...DEFAULT_LOGIN_CONFIG, ...config };
  }

  /**
   * 更新配置（用于动态更改国家代码等）
   */
  public updateConfig(config: Partial<LoginConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  public getConfig(): LoginConfig {
    return { ...this.config };
  }

  /**
   * 执行登录流程
   * 1. 启动本地认证服务器
   * 2. 打开浏览器登录页面
   * 3. 等待用户完成登录
   * 4. 获取并保存 JWT Token
   * @returns 用户信息
   * @throws 如果登录过程中发生错误
   */
  public async login(): Promise<UserInfo> {
    try {
      debugLog(`Login started, isDevecoCodeAuth: ${isDevecoCodeAuth()}`);
      const clientSecret = this.generateClientSecret();

      this.server = new LocalAuthServer(
        clientSecret,
        ApiEndpoints.CN_LOGIN_URL,
        this.config.successRedirectUrl,
        this.config.failedRedirectUrl
      );
      await this.server.start();
      debugLog(`Local auth server started on port ${this.server.getPort()}`);

      await this.openLoginPage(this.server.getPort(), clientSecret);
      debugLog('Browser opened for authentication');

      const callbackData = await this.server.waitForCallback(
        this.config.timeout
      );
      debugLog(`Callback received: siteId=${callbackData.siteId}`);

      // 海外账户不在支持范围内
      if (callbackData.siteId !== '1') {
        throw new DefinedError('Non-China accounts are not supported.');
      }

      const jwtToken = await userInfoFetcher.getJwtToken(
        callbackData.tempToken,
        callbackData.siteId,
        ApiEndpoints.CN_LOGIN_URL,
        this.config.tempTokenCheckUrl,
        this.config.appId
      );
      debugLog('JWT token received');

      const userInfo = await tokenChecker.getUserInfoFromJwt(
        jwtToken,
        ApiEndpoints.CN_LOGIN_URL
      );
      if (!userInfo) {
        throw new DefinedError('Login failed: failed to get user info');
      }
      debugLog(`User info received: ${userInfo.userName}`);

      // 保存 jwtToken 到磁盘
      await tokenStorage.saveJwtToken(jwtToken);
      debugLog('JWT token saved');

      reportAgreementSigned(userInfo.accessToken);
      return userInfo;
    } finally {
      if (this.server) {
        // 不等待 stop() 完成，让它在后台异步执行
        await this.server.stop();
        this.server = null;
      }
    }
  }

  /**
   * 检查用户是否已登录
   * @returns 如果已登录返回 true，否则返回 false
   */
  public async isLoggedIn(): Promise<boolean> {
    const userInfo = await this.getUserInfo(true);
    return userInfo !== null;
  }

  /**
   * 执行登出操作
   * 清除本地存储的 Token
   * @throws If not logged in
   */
  public async logout(): Promise<boolean> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return false;
    }
    const regionalizedBaseUrl = ApiEndpoints.CN_LOGIN_URL;
    const logoutUrl = `${regionalizedBaseUrl}/${this.config.logoutUrl}?jwtToken=${jwtToken}`;
    try {
      await httpClient.post(logoutUrl, { timeout: 5000 });
    } catch {
      // 网络异常，服务器通知失败，本地清除成功即可
      debugLog('Logout: server notification failed, local token cleared');
    } finally {
      await tokenStorage.clearToken();
    }
    return true;
  }

  /**
   * 获取当前会话信息
   * @param refreshToken 是否刷新 accessToken，默认 true
   * @returns 会话信息对象，如果未登录则返回 null
   */
  public async getUserInfo(refreshToken: boolean = true): Promise<UserInfo | null> {
    return tokenChecker.fetchUserInfo(ApiEndpoints.CN_LOGIN_URL, refreshToken);
  }

  /**
   * 生成客户端密钥
   * @returns UUID 格式的密钥（去除连字符）
   */
  private generateClientSecret(): string {
    return crypto.randomUUID().replace(/-/g, '');
  }

  /**
   * 打开浏览器登录页面
   * @param port 本地认证服务器端口
   * @param clientSecret 客户端密钥
   */
  private async openLoginPage(
    port: number,
    clientSecret: string
  ): Promise<void> {
    const regionalizedBaseUrl = ApiEndpoints.CN_LOGIN_URL;
    const loginUrl = `${regionalizedBaseUrl}/${this.config.authUrl}?port=${port}&appid=${this.config.appId}&code=${clientSecret}`;
    await openBrowser(loginUrl);
  }

  /**
   * 刷新 accessToken
   * 从磁盘加载 JWT Token 并刷新
   */
  async refreshToken(): Promise<{
    accessToken: string;
    refreshToken: string;
  } | null> {
    return tokenChecker.refreshToken(ApiEndpoints.CN_LOGIN_URL);
  }
}

// ============ Singleton instance ============
export const loginService = new LoginService();
