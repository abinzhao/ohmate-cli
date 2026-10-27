/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { isRecord } from './common/typeGuards.js';
// isStringArray 经 lspTypeGuards 的 re-export 导入，同时锁定转发关系。
import {
  isContentChange,
  isPosition,
  isStringArray,
  isTextDocument,
} from './lspTypeGuards.js';

describe('isRecord', () => {
  it.each([
    { value: {}, expected: true, desc: '普通对象' },
    { value: [], expected: true, desc: '数组也通过（typeof 判定）' },
    { value: 'str', expected: false, desc: '字符串' },
    { value: 42, expected: false, desc: '数字' },
    { value: null, expected: false, desc: 'null' },
    { value: undefined, expected: false, desc: 'undefined' },
  ])('$desc', ({ value, expected }) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('isStringArray', () => {
  it.each([
    { value: [], expected: true, desc: '空数组' },
    { value: ['a', 'b'], expected: true, desc: '字符串数组' },
    { value: ['a', 1], expected: false, desc: '混合类型数组' },
    { value: [null], expected: false, desc: '含 null' },
    { value: 'abc', expected: false, desc: '非数组' },
  ])('$desc', ({ value, expected }) => {
    expect(isStringArray(value)).toBe(expected);
  });
});

describe('isPosition', () => {
  it.each([
    { value: { line: 0, character: 0 }, expected: true, desc: '合法 Position' },
    {
      value: { line: 0, character: 0, extra: 1 },
      expected: true,
      desc: '多余键不拒绝',
    },
    {
      value: { line: '0', character: 0 },
      expected: false,
      desc: 'line 非数字',
    },
    { value: { line: 0 }, expected: false, desc: '缺 character' },
    { value: null, expected: false, desc: 'null' },
  ])('$desc', ({ value, expected }) => {
    expect(isPosition(value)).toBe(expected);
  });
});

describe('isTextDocument', () => {
  const valid = {
    uri: 'file:///a.ets',
    text: 'let x = 1;',
    languageId: 'ets',
    version: 1,
  };

  it.each([
    { value: valid, expected: true, desc: '合法 TextDocument' },
    { value: { ...valid, uri: 1 }, expected: false, desc: 'uri 非字符串' },
    { value: { ...valid, text: 2 }, expected: false, desc: 'text 非字符串' },
    {
      value: { ...valid, languageId: 3 },
      expected: false,
      desc: 'languageId 非字符串',
    },
    {
      value: { ...valid, version: '1' },
      expected: false,
      desc: 'version 非数字',
    },
    {
      value: { uri: 'file:///a.ets', text: 'x', languageId: 'ets' },
      expected: false,
      desc: '缺 version',
    },
    { value: null, expected: false, desc: 'null' },
  ])('$desc', ({ value, expected }) => {
    expect(isTextDocument(value)).toBe(expected);
  });
});

describe('isContentChange', () => {
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 0 },
  };

  it.each([
    { value: { text: 'x', range }, expected: true, desc: '合法变更' },
    {
      value: { text: 'x', range, extra: 1 },
      expected: true,
      desc: '多余键不拒绝',
    },
    { value: { range }, expected: false, desc: '缺 text' },
    { value: { text: 1, range }, expected: false, desc: 'text 非字符串' },
    { value: { text: 'x' }, expected: false, desc: '缺 range' },
    {
      value: {
        text: 'x',
        range: { start: { line: '0', character: 0 }, end: range.end },
      },
      expected: false,
      desc: 'range.start 非法',
    },
    {
      value: { text: 'x', range: { start: range.start } },
      expected: false,
      desc: 'range.end 缺失',
    },
    { value: null, expected: false, desc: 'null' },
  ])('$desc', ({ value, expected }) => {
    expect(isContentChange(value)).toBe(expected);
  });
});
