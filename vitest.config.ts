/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worker tests own subprocesses and large fixture copies; bound CPU/I/O contention.
    maxWorkers: 4,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/cli/mcp/src-server/**/*.test.ts',
    ],
  },
});
