/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { triggerFileExt } from './tool-metrics.js';

describe('triggerFileExt', () => {
  it.each([
    {
      args: { files: ['entry/src/main/a.ets'] },
      expected: 'ets',
      desc: '取 files[0] 的扩展名',
    },
    {
      args: { file: 'src/b.ts' },
      expected: 'ts',
      desc: '无 files 时回退到 file',
    },
    {
      args: { files: ['a.ets'], file: 'b.ts' },
      expected: 'ets',
      desc: 'files 优先于 file',
    },
    {
      args: { files: [], file: 'b.ts' },
      expected: undefined,
      desc: '空 files 数组不回退到 file',
    },
    {
      args: { files: [42], file: 'b.ts' },
      expected: undefined,
      desc: 'files[0] 非字符串不回退到 file',
    },
    {
      args: { files: 'a.ets' },
      expected: undefined,
      desc: 'files 非数组且无 file',
    },
    { args: { file: 'lib/a.CPP' }, expected: 'cpp', desc: '扩展名小写化' },
    {
      args: { file: 'a.spec.ts' },
      expected: 'ts',
      desc: '多级扩展名取最后一段',
    },
    {
      args: { file: 'README' },
      expected: undefined,
      desc: '无扩展名返回 undefined',
    },
    {
      args: { file: 'a.' },
      expected: undefined,
      desc: '以点结尾返回 undefined',
    },
    {
      args: { file: '.gitignore' },
      expected: undefined,
      desc: '隐藏文件视为无扩展名',
    },
    { args: { file: '' }, expected: undefined, desc: '空字符串返回 undefined' },
    { args: {}, expected: undefined, desc: '无文件入参返回 undefined' },
    {
      args: { query: 'foo' },
      expected: undefined,
      desc: '无关入参返回 undefined',
    },
  ])('$desc', ({ args, expected }) => {
    expect(triggerFileExt(args)).toBe(expected);
  });
});
