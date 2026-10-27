/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  findSection,
  fmtTime,
  lastSegment,
  parseTime,
  searchFields,
  splitByMarkers,
  splitLogLines,
} from './log-text.js';

describe('splitLogLines', () => {
  it('统一 CRLF/CR 换行并去除 BOM', () => {
    const text = '\ufeffa\r\nb\rc\nd';
    expect(splitLogLines(text)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('lastSegment', () => {
  it('取最后一段路径', () => {
    expect(lastSegment('/system/lib/libxxx.so')).toBe('libxxx.so');
    expect(lastSegment('com.example.app')).toBe('com.example.app');
    expect(lastSegment('')).toBe('');
  });
});

describe('findSection', () => {
  const lines = ['head', 'START', 'a', 'END', 'tail'];

  it('定位区段并默认包含起始行', () => {
    const [section, startIndex] = findSection(lines, /^START$/, /^END$/);
    expect(section).toEqual(['START', 'a']);
    expect(startIndex).toBe(1);
  });

  it('不包含起始行', () => {
    const [section] = findSection(lines, /^START$/, /^END$/, false);
    expect(section).toEqual(['a']);
  });

  it('找不到起始行返回空', () => {
    const [section, startIndex] = findSection(lines, /^NOPE$/, /^END$/);
    expect(section).toEqual([]);
    expect(startIndex).toBe(-1);
  });

  it('找不到结束行时截取到末尾', () => {
    const [section] = findSection(lines, /^START$/, /^NOPE$/);
    expect(section).toEqual(['START', 'a', 'END', 'tail']);
  });
});

describe('searchFields', () => {
  it('提取并 trim 首个命中，跳过空值', () => {
    const fields = searchFields(
      ['Pid: 1234  ', 'Reason:', 'Reason: real reason'],
      { pid: /Pid:(.*)/, reason: /Reason:(.*)/ }
    );
    expect(fields.pid).toBe('1234');
    expect(fields.reason).toBe('real reason');
  });
});

describe('splitByMarkers', () => {
  it('按顺序标记切段，头部进空键', () => {
    const lines = ['head', 'A:', 'a1', 'B:', 'b1', 'b2'];
    const sections = splitByMarkers(lines, ['A:', 'B:']);
    expect(sections.get('')).toEqual(['head']);
    expect(sections.get('A:')).toEqual(['A:', 'a1']);
    expect(sections.get('B:')).toEqual(['B:', 'b1', 'b2']);
  });

  it('缺失的标记对应空数组', () => {
    const sections = splitByMarkers(['only head'], ['A:', 'B:']);
    expect(sections.get('A:')).toEqual([]);
    expect(sections.get('B:')).toEqual([]);
  });
});

describe('parseTime', () => {
  it('解析标准日期时间（毫秒）', () => {
    const date = parseTime('2026-09-01 12:00:00.123');
    expect(date).not.toBeNull();
    expect(fmtTime(date)).toBe('2026-09-01 12:00:00.123');
  });

  it('解析无分隔数字串与横线变体', () => {
    expect(fmtTime(parseTime('20260901120000'))).toBe('2026-09-01 12:00:00.000');
    expect(fmtTime(parseTime('2026-09-01-12-00-00.500'))).toBe('2026-09-01 12:00:00.500');
  });

  it('解析英文时间（SERVICE_BLOCK MSG）', () => {
    expect(fmtTime(parseTime('Thu May 21 07:55:59 2025'))).toBe('2025-05-21 07:55:59.000');
  });

  it('非法输入返回 null', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('not a time')).toBeNull();
    expect(parseTime('2026-13-40 12:00:00')).toBeNull();
  });
});

describe('fmtTime', () => {
  it('null 安全', () => {
    expect(fmtTime(null)).toBe('');
  });
});
