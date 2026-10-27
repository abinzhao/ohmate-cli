/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// ============ Types for Authentication ============

export interface UserInfo {
  userId: string;
  userName: string;
  accessToken: string;
  refreshToken: string;
  jwtToken: string;
  countryCode: string;
  language: string;
  isRealName: boolean;
}

export interface LoginResult {
  success: boolean;
  userInfo?: UserInfo;
  error?: string;
}

export interface TokenCheckResponse {
  status: boolean;
  userInfo?: {
    accessToken: string;
    refreshToken?: string;
    nationalCode: string;
    realName: string;
    name?: string;
    userId?: string;
  };
}

export interface LoginConfig {
  baseUrl: string;
  authUrl: string;
  tempTokenCheckUrl: string;
  jwtTokenCheckUrl: string;
  successRedirectUrl: string;
  failedRedirectUrl: string;
  logoutUrl: string;
  agcTeamListUrl: string;
  appId: string;
  timeout: number;
  countryCode?: string;
}

export interface CallbackData {
  tempToken: string;
  siteId: string;
  quit?: string;
}

/**
 * JWT Payload 基础结构
 */
export interface JwtPayload {
  userId: string;
  userName: string;
  exp?: number;
  iat?: number;
}

// ============ Types for Team List ============

export interface Team {
  id: string;
  upSiteId: number;
  name: string;
  countryCode: string;
  siteId: number;
  userType: number;
  lastLoginTime: string;
  isMirror: boolean;
}

export interface AgcRet {
  code: number;
  msg?: string;
}

export interface AgcTeamListResponse {
  ret?: AgcRet;
  teams?: Team[];
}

export const AGC_SUCCESS_CODE = 0;

export interface TeamListResult {
  userId: string;
  teamList: Team[];
}
