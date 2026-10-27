/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ApiEndpoints } from '../auth-config';

/**
 * 国家代码枚举
 */
export const CountryCode = {
  CHINA: 'CN',
  RUSSIA: 'RU',
  SINGAPORE: 'SG',
  EUROPE: 'EU',
} as const;

export type CountryCodeType = (typeof CountryCode)[keyof typeof CountryCode];

/**
 * 语言代码枚举
 */
export const LanguageCode = {
  CHINA: 'zh_CN',
  RUSSIA: 'ru_RU',
  EUROPE: 'de_DE',
} as const;

export type LanguageCodeType = (typeof LanguageCode)[keyof typeof LanguageCode];

/**
 * 站点 ID 枚举
 */
export const SiteId = {
  CHINA: '1',
  SINGAPORE: '5',
  EUROPE: '7',
  RUSSIA: '8',
} as const;

export type SiteIdType = (typeof SiteId)[keyof typeof SiteId];

/**
 * 国家代码到语言代码的映射
 */
const COUNTRY_TO_LANGUAGE: Record<CountryCodeType, LanguageCodeType> = {
  [CountryCode.CHINA]: LanguageCode.CHINA,
  [CountryCode.RUSSIA]: LanguageCode.RUSSIA,
  [CountryCode.EUROPE]: LanguageCode.EUROPE,
  [CountryCode.SINGAPORE]: LanguageCode.CHINA, // 新加坡默认使用中文
};

/**
 * 站点 ID 到国家代码的映射
 */
const SITE_TO_COUNTRY: Record<SiteIdType, CountryCodeType> = {
  [SiteId.CHINA]: CountryCode.CHINA,
  [SiteId.SINGAPORE]: CountryCode.SINGAPORE,
  [SiteId.EUROPE]: CountryCode.EUROPE,
  [SiteId.RUSSIA]: CountryCode.RUSSIA,
};

/**
 * 根据国家代码获取语言代码
 * @param countryCode 国家代码
 * @returns 对应的语言代码，默认返回中文
 */
export function getLanguageByCountryCode(
  countryCode: string
): LanguageCodeType {
  return (
    COUNTRY_TO_LANGUAGE[countryCode as CountryCodeType] ?? LanguageCode.CHINA
  );
}

/**
 * 根据站点 ID 获取国家代码
 * @param siteId 站点 ID
 * @returns 对应的国家代码，默认返回中国
 */
export function getCountryCodeBySiteId(siteId: string): CountryCodeType {
  return SITE_TO_COUNTRY[siteId as SiteIdType] ?? CountryCode.CHINA;
}

/**
 * 根据国家代码获取区域化的基础 URL
 * @param countryCode 国家代码
 * @param defaultBaseUrl 默认基础 URL
 * @returns 区域化的基础 URL
 */
export function getRegionalizedBaseUrl(
  countryCode: string,
  defaultBaseUrl: string
): string {
  const upperCountryCode = countryCode?.toUpperCase();

  // 中国站点使用特殊的域名
  if (upperCountryCode === CountryCode.CHINA) {
    return ApiEndpoints.CN_LOGIN_URL;
  }

  return defaultBaseUrl;
}

/**
 * 验证国家代码是否有效
 * @param countryCode 国家代码
 * @returns 如果有效返回 true，否则返回 false
 */
export function isValidCountryCode(countryCode: string): boolean {
  return Object.values(CountryCode).includes(
    countryCode.toUpperCase() as CountryCodeType
  );
}

/**
 * 获取所有有效的国家代码列表
 * @returns 国家代码数组
 */
export function getValidCountryCodes(): CountryCodeType[] {
  return Object.values(CountryCode);
}
