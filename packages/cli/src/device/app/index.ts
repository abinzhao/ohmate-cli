/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export type {
  AppEntry,
  ForegroundAppInfo,
  AppInfoFields,
} from './types.js';
export {
  parseForegroundApp,
  parseAppList,
  parseAppInfo,
  extractAppInfoFields,
  parseStartAppResult,
} from './parsers.js';
export { AppControlAdapter } from './app-control-adapter.js';
