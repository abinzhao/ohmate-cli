/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

// Barrel export — commands import update-module symbols only from here
export { UpdateNotifier } from './update-notifier.js';
export {
  getPackageName,
  getCurrentVersion,
  getPublishTag,
  getSupportedDocsApi,
  getUpdateDisableMode,
  type UpdateDisableMode,
  DOCS_PKG_NAME,
} from './constants.js';
