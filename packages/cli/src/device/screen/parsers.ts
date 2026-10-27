/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { DisplaySize } from './types.js';

/**
 * Parse the `[DISPLAY INFO]` section from `hidumper -s DisplayManagerService
 * -a -a` output, extracting `Width:` and `Height:` values. Returns `null`
 * when the section or fields are not found.
 */
export function parseDisplaySize(output: string): DisplaySize | null {
  const match = output.match(
    /\[DISPLAY INFO\][\s\S]*?Width:\s*(\d+)[\s\S]*?Height:\s*(\d+)/
  );
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Parse `Current State:` from `hidumper -s PowerManagerService -a -s`
 * output. Returns the state string (e.g. `AWAKE`, `SLEEP`) or `null`.
 */
export function parseScreenState(output: string): string | null {
  const match = output.match(/Current State:\s*(\w+)/);
  return match ? match[1] : null;
}
