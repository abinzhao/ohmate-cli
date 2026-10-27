/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.plugin/tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
