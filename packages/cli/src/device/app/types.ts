/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface AppEntry {
  bundleName: string;
  label?: string;
}

export interface ForegroundAppInfo {
  bundleName?: string;
  abilityName?: string;
}

export interface AppInfoFields {
  bundleName: unknown;
  entryModuleName: unknown;
  mainAbility: unknown;
  versionCode: unknown;
  versionName: unknown;
}
