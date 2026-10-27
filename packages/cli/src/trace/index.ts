/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export { Telemetry } from './telemetry.js';
export { telemetry } from './telemetry-instance.js';
export { maybeSpawnTelemetryUpload } from './telemetry-upload-spawner.js';
export { isTelemetryDisabled } from './upload-state.js';
export { TraceError, toTraceErrorCode } from './trace-error.js';
export { EventType } from './events.js';
export type {
  BaseEvent,
  TrackMeasurement,
  TraceEvent,
  TraceEventProperties,
  TraceUploadPayload,
  CommandExecuted,
  LogTraceEvent,
  McpToolCall,
  CheckToolCall,
  HoverToolCall,
  DefinitionToolCall,
  ReferencesToolCall,
  ImplementationToolCall,
  DocumentSymbolToolCall,
  CallHierarchyToolCall,
  WorkspaceSymbolToolCall,
  SkillOperation,
  McpConfigOperation,
  SkillConfigOperation,
  DocSubAction,
  DocOperation,
  ServeLspOperation,
  CheckCommand,
} from './events.js';
