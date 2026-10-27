/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface CheckResult {
  passed: boolean;
  message: string;
}

export interface CheckContext {
  productName: string;
  teamId?: string;
  type?: string;
}
