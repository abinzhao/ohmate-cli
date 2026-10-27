/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * faultlog 领域入口：日志类型判定 + 崩溃/冻屏分析 + 采样栈分析。
 */
export type {
  CrashAnalysisResult,
  CrashCandidateInfo,
  CrashKeyReport,
  CrashSourceInfo,
  ExcludedInfo,
  FaultCompleteness,
  FaultConfidence,
  FaultLogFamily,
  FaultLogType,
  FaultLogVerdict,
  KeyReportBinderEdge,
  KeyReportThread,
  MemoryCorruptionInfo,
  OutOfScopeInfo,
  SampleStackAnalysisResult,
  SampleStackChainInfo,
  SampleStackHotspot,
  SampleStackSourceInfo,
  SampleStackSummary,
} from './types.js';
export { FAULT_LOG_FAMILIES, isFaultLogFamily } from './types.js';
export { FaultLogError, type FaultLogErrorCode } from './faultlog-error.js';
export { classifyFaultLog } from './identify/classify.js';
export {
  identifyFaultLogContent,
  identifyFaultLogFile,
  MAX_LOG_BYTES,
  sampleBytes,
} from './identify/identify-faultlog.js';
export {
  analyzeCrashLog,
  analyzeFaultLogDirectory,
  extractCrashHilog,
  renderCrashReport,
  type CrashLogInput,
} from './crash/crash-analyzer.js';
export {
  collectFaultLogs,
  type CollectResult,
  type CollectedFaultLog,
} from './crash/faultlog-collector.js';
export {
  analyzeSampleStack,
  renderSampleStackReport,
  type SampleStackInput,
} from './sample-stack/sample-stack-analyzer.js';
