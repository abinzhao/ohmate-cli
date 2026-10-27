/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import { ApiEndpoints } from '../auth-config.js';
import {
  CountryCode,
  getCountryCodeBySiteId,
  getLanguageByCountryCode,
  getRegionalizedBaseUrl,
  getValidCountryCodes,
  isValidCountryCode,
} from './region.js';

describe('getLanguageByCountryCode', () => {
  it('maps each known country to its site language', () => {
    expect(getLanguageByCountryCode('CN')).toBe('zh_CN');
    expect(getLanguageByCountryCode('RU')).toBe('ru_RU');
    expect(getLanguageByCountryCode('EU')).toBe('de_DE');
  });

  it('defaults Singapore to Chinese', () => {
    expect(getLanguageByCountryCode('SG')).toBe('zh_CN');
  });

  it('falls back to Chinese for unknown country codes', () => {
    expect(getLanguageByCountryCode('US')).toBe('zh_CN');
    expect(getLanguageByCountryCode('')).toBe('zh_CN');
  });
});

describe('getCountryCodeBySiteId', () => {
  it('maps each site id to its country', () => {
    expect(getCountryCodeBySiteId('1')).toBe('CN');
    expect(getCountryCodeBySiteId('5')).toBe('SG');
    expect(getCountryCodeBySiteId('7')).toBe('EU');
    expect(getCountryCodeBySiteId('8')).toBe('RU');
  });

  it('falls back to China for unknown site ids', () => {
    expect(getCountryCodeBySiteId('999')).toBe(CountryCode.CHINA);
    expect(getCountryCodeBySiteId('')).toBe(CountryCode.CHINA);
  });
});

describe('getRegionalizedBaseUrl', () => {
  it('routes the China site to the CN login URL', () => {
    expect(getRegionalizedBaseUrl('CN', 'https://default.example.com')).toBe(
      ApiEndpoints.CN_LOGIN_URL
    );
  });

  it('treats the country code case-insensitively', () => {
    expect(getRegionalizedBaseUrl('cn', 'https://default.example.com')).toBe(
      ApiEndpoints.CN_LOGIN_URL
    );
  });

  it('keeps the default base URL for all other regions', () => {
    const fallback = 'https://default.example.com';
    expect(getRegionalizedBaseUrl('RU', fallback)).toBe(fallback);
    expect(getRegionalizedBaseUrl('SG', fallback)).toBe(fallback);
    expect(getRegionalizedBaseUrl('EU', fallback)).toBe(fallback);
    expect(getRegionalizedBaseUrl('US', fallback)).toBe(fallback);
  });
});

describe('isValidCountryCode', () => {
  it('accepts every known country code in any casing', () => {
    for (const code of getValidCountryCodes()) {
      expect(isValidCountryCode(code)).toBe(true);
      expect(isValidCountryCode(code.toLowerCase())).toBe(true);
    }
  });

  it('rejects unknown or empty codes', () => {
    expect(isValidCountryCode('US')).toBe(false);
    expect(isValidCountryCode('XYZ')).toBe(false);
    expect(isValidCountryCode('')).toBe(false);
  });
});

describe('getValidCountryCodes', () => {
  it('lists exactly the supported country codes', () => {
    expect(getValidCountryCodes()).toEqual(['CN', 'RU', 'SG', 'EU']);
  });
});
