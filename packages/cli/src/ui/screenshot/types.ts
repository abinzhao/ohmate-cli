/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Per-capture execution context (hdc binary, target device, paths). */
export interface ScreenshotContext {
  hdcPath: string;
  serial: string;
  localPath: string;
  remotePath: string;
  display?: string;
}

/** Node fs error shape used by destination validation. */
export interface FileSystemError extends Error {
  code?: string;
}
