/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  buildFrame,
  extractStackErrors,
  parseFrames,
  parseThreadStacks,
} from './stack-parser.js';

const NATIVE_SYSTEM =
  '#00 pc 0000000000123456 /system/lib/ld-musl-aarch64.so.1(ak_malloc_internal+32)(7cb22b17eb24ea49c72d5b56cbb5ab075216a830)';
const NATIVE_APP =
  '#02 pc 0000000000009876 /data/storage/el1/bundle/libs/arm64/libentry.so(fun+8)(7cb22b17eb24ea49c72d5b56cbb5ab075216a830)';
const JS_FRAME = 'at foo (/data/storage/el1/bundle/ets/pages/Index.ets:10:15)';

describe('buildFrame', () => {
  it('native 系统帧：去编号/地址/buildid，标注 system', () => {
    const frame = buildFrame(NATIVE_SYSTEM);
    expect(frame.isNative).toBe(true);
    expect(frame.brief).toBe('/system/lib/ld-musl-aarch64.so.1(ak_malloc_internal+32)');
    expect(frame.area).toBe('system');
  });

  it('native 应用帧：/data 路径标注 app', () => {
    const frame = buildFrame(NATIVE_APP);
    expect(frame.brief).toBe('/data/storage/el1/bundle/libs/arm64/libentry.so(fun+8)');
    expect(frame.area).toBe('app');
  });

  it('libarkweb_engine.so 归为系统帧', () => {
    const frame = buildFrame(
      '#00 pc 000000000000abcd /data/storage/el1/bundle/libs/arm64/libarkweb_engine.so(call+4)'
    );
    expect(frame.area).toBe('system');
  });

  it('js 帧：保留文件行列，标注 app', () => {
    const frame = buildFrame(JS_FRAME);
    expect(frame.isNative).toBe(false);
    expect(frame.brief).toBe(JS_FRAME);
    expect(frame.area).toBe('app');
  });

  it('js 框架帧（/foundation/arkui）标注 system', () => {
    const frame = buildFrame('at baz (/foundation/arkui/stateMgmt.js:1:2)');
    expect(frame.area).toBe('system');
  });
});

describe('parseFrames', () => {
  it('混合收集 native + js 帧', () => {
    const frames = parseFrames([NATIVE_SYSTEM, 'noise', JS_FRAME, NATIVE_APP]);
    expect(frames).toHaveLength(3);
    expect(frames[1].raw).toBe(JS_FRAME);
  });
});

describe('parseThreadStacks', () => {
  it('按 Tid 头拆分线程，重复 tid 后者覆盖', () => {
    const stacks = parseThreadStacks([
      'Tid:100, Name:main',
      NATIVE_SYSTEM,
      'Tid:200, Name:xxx',
      NATIVE_APP,
      'Tid:100, Name:main',
      JS_FRAME,
    ]);
    expect(stacks.size).toBe(2);
    expect(stacks.get('100')?.frames).toHaveLength(1);
    expect(stacks.get('100')?.frames[0].raw).toBe(JS_FRAME);
    expect(stacks.get('200')?.name).toBe('xxx');
  });
});

describe('extractStackErrors', () => {
  it('提取报错行并附含义说明，重复行去重', () => {
    const errors = extractStackErrors([
      'Failed to dump normal stacktrace, fault thread is 1234',
      'Failed to dump normal stacktrace, fault thread is 1234',
      'normal line',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Failed to dump normal stacktrace');
    expect(errors[0]).toContain('正常抓栈失败');
  });
});
