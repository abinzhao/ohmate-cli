/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { Diagnostic } from './Diagnostic.js';
import type { LspDiagnostic } from './LspProtocols.js';

describe('Diagnostic', () => {
  it('构造时保存 uri 且初始诊断为空', () => {
    const d = new Diagnostic('file:///a.ets');
    expect(d.uri).toBe('file:///a.ets');
    expect(d.get()).toEqual([]);
  });

  it('set 保存数组引用，get 原样返回', () => {
    const d = new Diagnostic('file:///a.ets');
    const items: LspDiagnostic[] = [];
    d.set(items);
    expect(d.get()).toBe(items);
  });

  it('再次 set 覆盖前值', () => {
    const d = new Diagnostic('file:///a.ets');
    const first: LspDiagnostic[] = [];
    const second: LspDiagnostic[] = [];
    d.set(first);
    d.set(second);
    expect(d.get()).toBe(second);
  });

  it('clear 清空诊断', () => {
    const d = new Diagnostic('file:///a.ets');
    const items: LspDiagnostic[] = [];
    d.set(items);
    d.clear();
    expect(d.get()).toEqual([]);
    expect(d.get()).not.toBe(items);
  });

  it('实例之间互不影响', () => {
    const d1 = new Diagnostic('file:///a.ets');
    const d2 = new Diagnostic('file:///a.ets');
    const items: LspDiagnostic[] = [];
    d1.set(items);
    expect(d2.get()).toEqual([]);
  });
});
