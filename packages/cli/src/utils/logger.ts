/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/** Log when `DEVECO_CLI_DEBUG` is set. Pass a supplier to defer expensive string construction. */
export function debugLog(message: string | (() => string)): void {
  if (process.env.DEVECO_CLI_DEBUG) {
    const msg = typeof message === 'function' ? message() : message;
    console.log(`[DEBUG] ${msg}`);
  }
}
