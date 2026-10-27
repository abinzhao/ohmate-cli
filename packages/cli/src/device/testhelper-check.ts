/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { HdcCommandResult } from '../utils/hdc-param.js';

/**
 * Check if testhelper is available on the device. Throws a friendly error
 * if testhelper is not found (old device version). Should be called by
 * adapters that use `hdc shell testhelper <command>`.
 */
export function assertTesthelperAvailable(result: HdcCommandResult): void {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/testhelper.*(?:not found|inaccessible)/i.test(combined)) {
    throw new Error(
      'testhelper is not available on this device. Please upgrade the device system version to support this command.'
    );
  }
}
