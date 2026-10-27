/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export { ArkUiDumpAdapter } from './layout/dump-adapter.js';
export type { ArkUiNode } from './layout/types.js';
export { findNodesInTree } from './layout/parsers.js';
export { ArkUiFindAdapter, decodeSelector, findUnknownKeys, flushWarnings } from './layout/find-adapter.js';
export type { FindMatch, FindOptions } from './layout/find-adapter.js';
export {
  parseSelector,
  parseSelectorB64,
  matchNodes,
  resolveIndex,
} from './layout/selector-parser.js';
export type {
  ParsedSelector,
  SelectorClause,
  SelectorOperator,
  MatchableNode,
} from './layout/selector-parser.js';
export { WindowAdapter } from './window/fetcher.js';
export type { WindowInfo } from './window/types.js';
export { ScreenshotCapturer } from './screenshot/screenshot-capturer.js';
export { ScreenRecordAdapter } from './screenrecord/screen-record-adapter.js';
export { ScreenRecordError } from './screenrecord/types.js';
export type {
  FinalizeResult,
  InteractiveHooks,
  RecordingSession,
  RecordingStatus,
  SavedRecording,
  StartedRecording,
} from './screenrecord/types.js';
export * from './input/index.js';
