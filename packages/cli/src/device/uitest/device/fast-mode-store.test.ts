/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { Config } from '../common/config.js';
import { FastModeStore } from './fast-mode-store.js';

describe('FastModeStore directory configuration', () => {
  it('uses the configured path or explicit override', () => {
    const config = new Config({ device: { fastModeDir: '/test/configured' } });
    expect(new FastModeStore({ config }).dir).toBe('/test/configured');
    expect(new FastModeStore({ config, dir: '/test/explicit' }).dir).toBe('/test/explicit');
  });

  it.each([42, {}, [], true].map((value) => ({ value })))('rejects non-string path $value before filesystem operations', ({ value }) => {
    const config = new Config({ device: { fastModeDir: value } });
    expect(() => new FastModeStore({ config }).pathFor('test-device')).toThrow(/fastModeDir.*string/);
  });
});
