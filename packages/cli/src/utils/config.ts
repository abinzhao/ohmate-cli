/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export interface HilogOptions {
  deviceId?: string;
  isCrashLog?: boolean;
  level?: string;
  tag?: string;
  domain?: string;
  bundleName?: string;
  keyword?: string;
  logSize?: string;
  isFollow?: boolean;
  tail?: number;
  fromSeconds?: number;
  toSeconds?: number;
}
