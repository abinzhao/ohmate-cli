/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { expect, it } from 'vitest';
import { meetsMinimum } from '../runtime/resolve.js';

it('awaits the lazy version comparator for equal, newer and older runtimes', async () => {
  expect(await meetsMinimum('1.2.3', '1.2.3')).toBe(true);
  expect(await meetsMinimum('2.0.0', '1.2.3')).toBe(true);
  expect(await meetsMinimum('1.2.2', '1.2.3')).toBe(false);
  expect(await meetsMinimum('1.2.3-rc.1', '1.2.3')).toBe(false);
  expect(await meetsMinimum(null, '1.2.3')).toBe(false);
});
