/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SERVER_MAX_SIZE_BASE_MB,
  SERVER_MAX_SIZE_MODULE_THRESHOLD,
  SERVER_MAX_SIZE_PER_EXTRA_MODULE_GB,
  SERVER_MAX_SIZE_PHYSICAL_CAP_RATIO,
} from './constant.js';
import {
  computeLspServerMaxSize,
  getBuildProfilePath,
  getOsType,
  isString,
  normalizePath,
  toFileUri,
  toUnixPath,
} from './utils.js';
import { initMcpLogger } from '../utils/mcp-logger.js';

describe('isString', () => {
  it.each([
    { value: 'x', expected: true, desc: '字符串' },
    { value: '', expected: true, desc: '空字符串' },
    { value: 1, expected: false, desc: '数字' },
    { value: null, expected: false, desc: 'null' },
    { value: undefined, expected: false, desc: 'undefined' },
  ])('$desc', ({ value, expected }) => {
    expect(isString(value)).toBe(expected);
  });
});

describe('normalizePath', () => {
  it('反斜杠转正斜杠', () => {
    expect(normalizePath('a\\b\\c')).toBe('a/b/c');
  });

  it('正斜杠路径原样返回', () => {
    expect(normalizePath('a/b/c')).toBe('a/b/c');
  });

  it('混合分隔符统一', () => {
    expect(normalizePath('a\\b/c')).toBe('a/b/c');
  });

  it('空字符串原样返回', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('toUnixPath', () => {
  it('相对路径保持原样', () => {
    expect(toUnixPath('a\\b\\c')).toBe('a/b/c');
  });
});

describe('getBuildProfilePath', () => {
  it('拼接 build-profile.json5', () => {
    expect(getBuildProfilePath('D:/proj')).toBe(
      path.join('D:/proj', 'build-profile.json5')
    );
  });

  it('空根路径退化为文件名', () => {
    expect(getBuildProfilePath('')).toBe('build-profile.json5');
  });
});

describe('computeLspServerMaxSize', () => {
  // 计算过程会写 mcp 日志：切 console 模式，避免测试向用户数据目录写文件。
  beforeAll(() => {
    initMcpLogger(true);
  });

  /** 与实现同源的动态期望：物理上限截断 + 末尾四舍五入。 */
  const expectSize = (rawMb: number): number => {
    const physicalTotalMb = Math.floor(os.totalmem() / (1024 * 1024));
    const physicalCapMb = Math.floor(
      physicalTotalMb * SERVER_MAX_SIZE_PHYSICAL_CAP_RATIO
    );
    const capped =
      physicalCapMb > 0 && rawMb > physicalCapMb ? physicalCapMb : rawMb;
    return Math.round(capped);
  };

  it('模块数低于阈值取基准值', () => {
    expect(computeLspServerMaxSize(1)).toBe(
      expectSize(SERVER_MAX_SIZE_BASE_MB)
    );
  });

  it('模块数等于阈值仍取基准值（边界为严格大于）', () => {
    expect(computeLspServerMaxSize(SERVER_MAX_SIZE_MODULE_THRESHOLD)).toBe(
      expectSize(SERVER_MAX_SIZE_BASE_MB)
    );
  });

  it('超过阈值按模块数追加', () => {
    const raw =
      SERVER_MAX_SIZE_BASE_MB + 1 * SERVER_MAX_SIZE_PER_EXTRA_MODULE_GB * 1024;
    expect(computeLspServerMaxSize(SERVER_MAX_SIZE_MODULE_THRESHOLD + 1)).toBe(
      expectSize(raw)
    );
  });

  it('大量模块按公式线性增长', () => {
    const raw =
      SERVER_MAX_SIZE_BASE_MB +
      100 * SERVER_MAX_SIZE_PER_EXTRA_MODULE_GB * 1024;
    expect(
      computeLspServerMaxSize(SERVER_MAX_SIZE_MODULE_THRESHOLD + 100)
    ).toBe(expectSize(raw));
  });

  it('有效 override 直接生效', () => {
    expect(computeLspServerMaxSize(1, 4096)).toBe(expectSize(4096));
  });

  it('override 优先于模块数公式', () => {
    expect(computeLspServerMaxSize(500, 2048)).toBe(expectSize(2048));
  });

  it('超大 override 被物理上限截断', () => {
    expect(computeLspServerMaxSize(1, 2 ** 20)).toBe(expectSize(2 ** 20));
  });

  it.each([
    { override: 0, desc: '零' },
    { override: -100, desc: '负数' },
    { override: Number.NaN, desc: 'NaN' },
    { override: Number.POSITIVE_INFINITY, desc: 'Infinity' },
  ])('无效 override（$desc）回退到公式', ({ override }) => {
    expect(computeLspServerMaxSize(1, override)).toBe(
      expectSize(SERVER_MAX_SIZE_BASE_MB)
    );
  });
});
