/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * faultlog 领域公共类型。
 *
 * FaultLogVerdict 与 dfx-analyzer identify_fault_log.py 的输出结构 1:1
 * （键名保持 snake_case，作为 CLI JSON 契约的一部分对外暴露）。
 */

/** identify 判定支持的日志类型。sample_stack 为冻屏增强日志（采样栈），非独立故障日志。 */
export type FaultLogType = 'cpp_crash' | 'js_error' | 'app_freeze' | 'sample_stack' | 'unknown';

/** 三类可解析的 faultlog 家族（识别/收集/分析共用，唯一维护点）。 */
export const FAULT_LOG_FAMILIES = ['cpp_crash', 'js_error', 'app_freeze'] as const;

/** 三类可解析的 faultlog 家族类型。 */
export type FaultLogFamily = (typeof FAULT_LOG_FAMILIES)[number];

/** 判定类型字符串是否属于可解析家族。 */
export function isFaultLogFamily(type: string): type is FaultLogFamily {
  return (FAULT_LOG_FAMILIES as readonly string[]).includes(type);
}

export type FaultConfidence = 'high' | 'medium' | 'low';

export type FaultCompleteness = 'full' | 'fragment';

export interface OutOfScopeInfo {
  reason: 'empty' | 'hilog_stream' | 'other_platform';
  detail: string;
}

export interface ExcludedInfo {
  type: FaultLogFamily;
  reason: string;
}

export interface CandidateInfo {
  type: FaultLogFamily;
  confidence: FaultConfidence;
  evidence: string[];
  arbitrable: boolean;
}

export interface MemoryCorruptionInfo {
  suspected: boolean;
  confidence: 'medium' | 'low';
  evidence: string[];
}

/** 日志类型判定结果（snake_case 键与 identify_fault_log.py 契约一致）。 */
export interface FaultLogVerdict {
  type: FaultLogType;
  subtype?: string;
  confidence: FaultConfidence;
  completeness: FaultCompleteness;
  evidence: string[];
  excluded: ExcludedInfo[];
  candidates: CandidateInfo[];
  memory_corruption_suspect?: MemoryCorruptionInfo;
  filename_hint: string;
  out_of_scope?: OutOfScopeInfo;
}

// ------------------------------------------------------------ --crash 输出契约

export interface CrashCandidateInfo {
  path: string;
  type: FaultLogFamily;
  confidence: FaultConfidence;
  completeness: FaultCompleteness;
}

export interface CrashSourceInfo {
  kind: 'file' | 'directory' | 'device';
  path: string;
  /** 目录模式下按相关性排序的全部候选。 */
  candidates?: CrashCandidateInfo[];
}

export interface KeyReportThread {
  role: 'fault' | 'fault-secondary';
  tid: string;
  name: string;
  /** 原始栈帧行（含 pc 偏移，供进一步 addr2line 等分析）。 */
  frames: string[];
  /** 抓栈失败等补充说明。 */
  note?: string;
}

export interface KeyReportBinderEdge {
  from: string;
  to: string;
  relation: '同步等待';
  'wait-seconds': number;
  code: string;
  'frz-state'?: string;
}

export interface CrashKeyReport {
  /** 有序键值：故障时间 / PID / 进程名 / 故障类型 / 类型附加字段。 */
  'basic-info': Record<string, string>;
  threads: KeyReportThread[];
  binders: KeyReportBinderEdge[];
  'binder-notes'?: string[];
  /** 死锁环渲染结果（节点标签 -> 连接）。 */
  cycles?: string[];
  /** cpp_crash 专有：GWP-ASan 报告原文。 */
  'gwp-asan'?: string;
}

export interface CrashAnalysisResult {
  schemaVersion: '1.0.0';
  logType: FaultLogFamily;
  subtype?: string;
  source: CrashSourceInfo;
  identify: FaultLogVerdict;
  'key-report': CrashKeyReport;
}

// ---------------------------------------------------------- --stack 输出契约

export interface SampleStackSourceInfo {
  kind: 'file' | 'device';
  path: string;
}

export interface SampleStackSummary {
  'statics-duration-ms': number;
  'cpu-time-ms': number;
  /** {cpu 序号: 使用率百分比}。 */
  'cpu-usage': Record<string, number>;
  'snapshot-count': number;
}

export interface SampleStackChainInfo {
  /** 格式化后的快照时间 YYYY-MM-DD HH:MM:SS.mmm。 */
  timestamp: string;
  /** 自底向上（父节点在前）的业务调用链。 */
  calls: string[];
}

export interface SampleStackHotspot {
  'parent-node': string;
  count: number;
  'total-snapshots': number;
  chains: SampleStackChainInfo[];
}

export interface SampleStackAnalysisResult {
  schemaVersion: '1.0.0';
  logType: 'sample_stack';
  source: SampleStackSourceInfo;
  identify: FaultLogVerdict;
  summary: SampleStackSummary;
  hotspots: SampleStackHotspot[];
}
