/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export type { AppEntry, ForegroundAppInfo, AppInfoFields } from './app/types.js';
export {
  parseForegroundApp,
  parseAppList,
  parseAppInfo,
  extractAppInfoFields,
  AppControlAdapter,
} from './app/index.js';

export { SystemAdapter } from './system/index.js';

export type { DisplaySize } from './screen/types.js';
export { parseDisplaySize, parseScreenState, ScreenAdapter } from './screen/index.js';

export { ClipboardAdapter } from './clipboard/index.js';

export { ViewmodeAdapter } from './viewmode/index.js';

export { FileAdapter } from './file/index.js';

export { FontAdapter } from './font/index.js';
