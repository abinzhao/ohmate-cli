/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { TimeConstants } from '../config/network';

/**
 * 应用配置常量
 */
export const AppConfig = {
  /** 应用 ID */
  APP_ID: '1009',

  /** 配置目录名称 */
  CONFIG_DIR_NAME: '.config',

  /** 应用名称 */
  APP_NAME: 'deveco-cli',

  /** Token 文件名 */
  TOKEN_FILE_NAME: 'token.enc',

  /** 密钥文件名 */
  KEY_FILE_NAME: 'token.dek',

  /** API 版本号 */
  API_VERSION: '1.0.0',

  /** 外部认证源标识 */
  AUTH_SOURCE_DEVECO_CODE: 'deveco-code',
} as const;

export const ApiEndpoints = {
  LOGIN_URL: 'https://devecostudio.huawei.com',

  CN_LOGIN_URL: 'https://cn.devecostudio.huawei.com',

  AUTH_APPLY_PATH: 'console/DevEcoIDE/apply',

  TEMP_TOKEN_CHECK_PATH: 'authrouter/auth/api/temptoken/check',

  JWT_TOKEN_CHECK_PATH: 'authrouter/auth/api/jwToken/check',

  LOGIN_SUCCESS_PATH: 'console/DevEcoCLI/loginSuccess',

  LOGIN_FAILED_PATH: 'console/DevEcoCLI/loginFailed',

  LOGOUT_PATH: 'authrouter/auth/api/logout',

  AGC_TEAM_LIST_URL:
    'https://connect-api.cloud.huawei.com/api/ups/user-permission-service/v1/user-team-list',
} as const;

export const CryptoConstants = {
  /** 加密算法 */
  ALGORITHM: 'aes-256-gcm',

  /** KEK/DEK 密钥长度（字节） */
  KEY_LENGTH: 32,

  /** IV 长度（字节） */
  IV_LENGTH: 12,

  /** KEK 版本列表 */
  KEK_VERSIONS: ['kek-v1', 'kek-v2', 'kek-v3'] as const,
} as const;

export const AgreementConfig = {
  /** TMS 协议服务 URL */
  TMS_URL: 'https://terms-drcn.platform.dbankcloud.cn/agreementservice/user',

  /** 隐私协议 ID */
  PRIVACY_ID: '20000257',

  /** 隐私声明 URL */
  PRIVACY_URL:
    'https://legal.cloud.huawei.com/terms/scope/huawei/deveco-cli/privacy-statement.htm?code=CN&language=zh-CN&branchid=0&contenttag=default',
} as const;

/**
 * 默认登录配置
 */
export const DEFAULT_LOGIN_CONFIG = {
  baseUrl: ApiEndpoints.LOGIN_URL,
  authUrl: ApiEndpoints.AUTH_APPLY_PATH,
  tempTokenCheckUrl: ApiEndpoints.TEMP_TOKEN_CHECK_PATH,
  jwtTokenCheckUrl: ApiEndpoints.JWT_TOKEN_CHECK_PATH,
  successRedirectUrl: ApiEndpoints.LOGIN_SUCCESS_PATH,
  failedRedirectUrl: ApiEndpoints.LOGIN_FAILED_PATH,
  logoutUrl: ApiEndpoints.LOGOUT_PATH,
  agcTeamListUrl: ApiEndpoints.AGC_TEAM_LIST_URL,
  appId: AppConfig.APP_ID,
  timeout: TimeConstants.LOGIN_TIMEOUT_MS,
  countryCode: 'CN',
} as const;
