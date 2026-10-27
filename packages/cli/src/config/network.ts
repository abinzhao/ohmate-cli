/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export const TimeConstants = {
  /** 登录超时时间：10 分钟 */
  LOGIN_TIMEOUT_MS: 600000,

  /** HTTP 请求默认超时：20 秒 */
  HTTP_TIMEOUT_MS: 20000,

  /** Token 有效期：30 天 */
  TOKEN_VALIDITY_DAYS: 30,
} as const;

/**
 * 网络相关常量
 */
export const NetworkConstants = {
  /** HTTP User-Agent */
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  /** 默认接受语言 */
  ACCEPT_LANGUAGE: 'zh-CN',
} as const;
