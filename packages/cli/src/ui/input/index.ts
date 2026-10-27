/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export { DIRECTION_MAP } from './types.js';
export type { ClickOptions, SwipeOptions, TextOptions } from './types.js';
export {
  assertCoord,
  assertOptionalCoord,
  assertCoordsPair,
  assertNonEmpty,
  assertSpeed,
  assertWindowId,
  assertTargetRule,
  assertTargetParams,
} from './types.js';
export {
  initDevice,
  resolveTarget,
  runHdcShell,
} from './adapter.js';
