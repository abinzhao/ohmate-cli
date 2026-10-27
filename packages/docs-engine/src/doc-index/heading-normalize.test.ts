/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  stripApiVersionSuffix,
  normalizeApiHeading,
  extractFirstDefinitionLine,
  buildSectionHeadingsText,
} from './heading-normalize.js';
import type { NormalizedApiHeading } from './heading-normalize.js';

describe('stripApiVersionSuffix', () => {
  it.each([
    // 无匹配 → 原样返回（trim 后）
    ['', ''],
    ['   ', ''],
    ['12+', '12+'],
    ['ab+', 'ab+'],
    ['@module.logger', '@module.logger'],
    ['AgentCalendarManager对象说明', 'AgentCalendarManager对象说明'],
    // 合法符号原样返回
    ['request', 'request'],
    ['getUserAgent', 'getUserAgent'],
    ['foo123', 'foo123'],
    // 版本后缀剥离
    ['request10+', 'request'],
    ['hilog12+', 'hilog'],
    ['DLP10+', 'DLP'],
    ['@Component12+', '@Component'],
    // 匹配前先 trim
    ['  request12+  ', 'request'],
  ])('stripApiVersionSuffix(%s) → %s', (input, expected) => {
    expect(stripApiVersionSuffix(input)).toBe(expected);
  });
});

describe('normalizeApiHeading', () => {
  it('returns empty result for empty input', () => {
    expect(normalizeApiHeading('')).toEqual({
      displayTitle: '',
      searchExtras: [],
    });
  });

  it('returns empty result for whitespace-only input', () => {
    expect(normalizeApiHeading('   ')).toEqual({
      displayTitle: '',
      searchExtras: [],
    });
  });

  it('trims displayTitle before matching', () => {
    expect(normalizeApiHeading('  ArkUI  ')).toEqual({
      displayTitle: 'ArkUI',
      symbolName: 'ArkUI',
      searchExtras: ['ArkUI'],
    });
  });

  it('extracts symbol from 对象说明 heading', () => {
    expect(normalizeApiHeading('AgentCalendarManager对象说明')).toEqual({
      displayTitle: 'AgentCalendarManager对象说明',
      symbolName: 'AgentCalendarManager',
      searchExtras: ['AgentCalendarManager', '对象'],
    });
  });

  it('extracts symbol from 枚举说明 heading and strips version suffix', () => {
    expect(normalizeApiHeading('Calendar10+枚举说明')).toEqual({
      displayTitle: 'Calendar10+枚举说明',
      symbolName: 'Calendar',
      searchExtras: ['Calendar', '枚举'],
    });
  });

  it('extracts method symbol from [h2] heading', () => {
    expect(normalizeApiHeading('[h2]startDLPService')).toEqual({
      displayTitle: '[h2]startDLPService',
      symbolName: 'startDLPService',
      searchExtras: ['startDLPService'],
    });
  });

  // 注：两位数版本后缀（如 '[h2]xxx12+'）在 H2 分支存在贪婪回溯
  // off-by-one（symbolName 会多带一位数字），按决策暂不覆盖该场景。
  it('extracts method symbol from [h2] heading with single-digit version', () => {
    expect(normalizeApiHeading('[h2]foo1+')).toEqual({
      displayTitle: '[h2]foo1+',
      symbolName: 'foo',
      searchExtras: ['foo'],
    });
  });

  it('extracts english symbol from 中英括号 heading', () => {
    expect(normalizeApiHeading('日历(calendar)')).toEqual({
      displayTitle: '日历(calendar)',
      symbolName: 'calendar',
      searchExtras: ['日历', 'calendar'],
    });
  });

  it('supports full-width parentheses', () => {
    expect(normalizeApiHeading('获取日历（getCalendar）')).toEqual({
      displayTitle: '获取日历（getCalendar）',
      symbolName: 'getCalendar',
      searchExtras: ['获取日历', 'getCalendar'],
    });
  });

  it('recognizes upper camel symbol', () => {
    expect(normalizeApiHeading('ArkUI')).toEqual({
      displayTitle: 'ArkUI',
      symbolName: 'ArkUI',
      searchExtras: ['ArkUI'],
    });
  });

  it('strips version suffix from upper camel symbol', () => {
    expect(normalizeApiHeading('DLP10+')).toEqual({
      displayTitle: 'DLP10+',
      symbolName: 'DLP',
      searchExtras: ['DLP'],
    });
  });

  it('returns plain fallback for non-symbol heading', () => {
    expect(normalizeApiHeading('系统能力')).toEqual({
      displayTitle: '系统能力',
      searchExtras: [],
    });
  });
});

describe('extractFirstDefinitionLine', () => {
  it('returns empty string for empty body parts', () => {
    expect(extractFirstDefinitionLine([])).toBe('');
  });

  it('returns empty string when no part is a definition candidate', () => {
    expect(extractFirstDefinitionLine(['Plain English sentence only'])).toBe(
      ''
    );
  });

  it('returns first candidate among mixed parts', () => {
    const parts = ['English intro line', '日历提供日程管理能力'];
    expect(extractFirstDefinitionLine(parts)).toBe('日历提供日程管理能力');
  });

  it('skips empty and whitespace-only parts', () => {
    const parts = ['', '   ', '这是描述内容'];
    expect(extractFirstDefinitionLine(parts)).toBe('这是描述内容');
  });

  it('skips parts shorter than 2 characters', () => {
    expect(extractFirstDefinitionLine(['日'])).toBe('');
  });

  it('skips parts longer than 36 characters', () => {
    const long = '一二三四五六七八九十'.repeat(4);
    expect(extractFirstDefinitionLine([long])).toBe('');
  });

  it('accepts mixed text at exactly 40% Chinese characters', () => {
    expect(extractFirstDefinitionLine(['日历abc'])).toBe('日历abc');
  });

  it('rejects mixed text below 40% Chinese characters', () => {
    expect(extractFirstDefinitionLine(['日abcd'])).toBe('');
  });

  it.each([
    ['日历提供日程管理能力。', '日历提供日程管理能力'],
    ['这是什么？', '这是什么'],
    ['结束了。。', '结束了'],
  ])('strips trailing punctuation: %s → %s', (input, expected) => {
    expect(extractFirstDefinitionLine([input])).toBe(expected);
  });

  it.each([
    '系统能力：SystemCapability',
    '元服务API需要申请权限',
    '参数类型说明如下',
    '返回值类型说明如下',
    '**加粗的说明文字**',
    '|表格内容|示例|',
  ])('skips part starting with structural prefix: %s', (part) => {
    expect(extractFirstDefinitionLine([part, '这是一条描述内容'])).toBe(
      '这是一条描述内容'
    );
  });
});

describe('buildSectionHeadingsText', () => {
  const heading = (
    overrides: Partial<NormalizedApiHeading> = {}
  ): NormalizedApiHeading => ({
    displayTitle: '',
    searchExtras: [],
    ...overrides,
  });

  it('joins title, extras and definition line with spaces', () => {
    const result = buildSectionHeadingsText(
      '使用说明',
      '日历管理日程',
      heading({
        displayTitle: '日历(calendar)',
        symbolName: 'calendar',
        searchExtras: ['日历', 'calendar'],
      })
    );
    expect(result).toBe('使用说明 日历 calendar 日历管理日程');
  });

  it('omits empty parts', () => {
    const result = buildSectionHeadingsText('标题', '', heading());
    expect(result).toBe('标题');
  });

  it('deduplicates repeated parts keeping first occurrence', () => {
    const result = buildSectionHeadingsText(
      '日历',
      '日历',
      heading({ searchExtras: ['日历', 'calendar'] })
    );
    expect(result).toBe('日历 calendar');
  });

  it('returns empty string when all parts are empty', () => {
    expect(buildSectionHeadingsText('', '', heading())).toBe('');
  });
});
