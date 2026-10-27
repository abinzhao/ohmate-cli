/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  buildCamelCaseCompound,
  isApiCompoundSuffix,
  isOhosModuleQuery,
  isSingleApiLikeQuery,
  isSingleCamelCaseApiQuery,
  isSinglePascalCaseApiQuery,
  shouldSkipSynonymExpansion,
} from './api-identifiers.js';

describe('isOhosModuleQuery', () => {
  it.each([
    ['@ohos.hilog', true],
    ['@ohos.file.picker', true],
    ['@Ohos.Hilog', true],
    ['@ohos.hiLog', true],
    ['@ohos.x', false],
    ['@ohos.', false],
    ['ohos.hilog', false],
    ['@module.logger', false],
    ['@ohos.hilog extra', false],
  ])('isOhosModuleQuery(%s) → %s', (input, expected) => {
    expect(isOhosModuleQuery(input)).toBe(expected);
  });
});

describe('isSingleCamelCaseApiQuery', () => {
  it.each([
    ['getUserAgent', true],
    ['wifiManager', true],
    ['getUserAgent12', true],
    ['getUI', false],
    ['foobar', false],
    ['GetUser', false],
    ['getUser agent', false],
    ['', false],
  ])('isSingleCamelCaseApiQuery(%s) → %s', (input, expected) => {
    expect(isSingleCamelCaseApiQuery(input)).toBe(expected);
  });
});

describe('isSinglePascalCaseApiQuery', () => {
  it.each([
    ['Navigation', true],
    ['UIAbility', true],
    ['Nav', true],
    ['navigation', false],
    ['lowerUpper', false],
    ['Nav igation', false],
  ])('isSinglePascalCaseApiQuery(%s) → %s', (input, expected) => {
    expect(isSinglePascalCaseApiQuery(input)).toBe(expected);
  });
});

describe('isSingleApiLikeQuery', () => {
  it.each([
    ['@ohos.hilog', true],
    ['getUserAgent', true],
    ['Navigation', true],
    ['hello world', false],
    ['', false],
  ])('isSingleApiLikeQuery(%s) → %s', (input, expected) => {
    expect(isSingleApiLikeQuery(input)).toBe(expected);
  });
});

describe('isApiCompoundSuffix', () => {
  it.each([
    ['picker', true],
    ['Manager', true],
    [' manager ', true],
    ['ability', false],
    ['service', false],
    [' handler ', false],
    ['xyz', false],
  ])('isApiCompoundSuffix(%s) → %s', (input, expected) => {
    expect(isApiCompoundSuffix(input)).toBe(expected);
  });
});

describe('buildCamelCaseCompound', () => {
  it.each([
    ['wifi', 'manager', 'wifiManager'],
    ['camera', 'PICKER', 'cameraPicker'],
    [' wifi ', ' manager ', 'wifiManager'],
    ['a', 'b', 'aB'],
  ])('buildCamelCaseCompound(%s, %s) → %s', (first, second, expected) => {
    expect(buildCamelCaseCompound(first, second)).toBe(expected);
  });
});

describe('shouldSkipSynonymExpansion', () => {
  it.each([
    ['Navigation', true],
    ['@ohos.hilog', true],
    ['how to use navigation', false],
    ['', false],
  ])('shouldSkipSynonymExpansion(%s) → %s', (input, expected) => {
    expect(shouldSkipSynonymExpansion(input)).toBe(expected);
  });
});
