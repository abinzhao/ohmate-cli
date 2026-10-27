/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * 确定性 faultlog 类型判定（identify_fault_log.py 的 1:1 移植）。
 *
 * 只看日志内容结构，不看文件名、不看用户描述；相同输入永远得到相同判定。
 * 判定优先级：完整 faultlog（头部区域）> 采样栈结构标记 > 片段模式命中。
 */
import {
  FAULT_LOG_FAMILIES,
  type CandidateInfo,
  type ExcludedInfo,
  type FaultConfidence,
  type FaultLogFamily,
  type FaultLogVerdict,
  type MemoryCorruptionInfo,
  type OutOfScopeInfo,
} from '../types.js';
import { FaultLogError } from '../faultlog-error.js';

const NATIVE_FRAME = /^\s*#\d+\s+pc\s+[0-9a-fA-F]+\s+\S+/;
const JS_FRAME = /^\s*at\s+\S+\s*\([^)]*\.(ets|ts|js):\d+:\d+\)/;
const HEADER_REASON = /(?:^|\n)\s*Reason\s*:([^\n]*)/;
const HEADER_REGISTERS = /(?:^|\n)\s*Registers\s*:/i;
const HEADER_TIMESTAMP = /(?:^|\n)\s*Timestamp\s*:/i;
const HEADER_PID = /(?:^|\n)\s*(?:Pid|Process)\s*:/i;
const HEADER_FAULT_THREAD = /(?:^|\n)\s*Fault thread info\s*:/i;
const HEADER_PROCESS_LIFE = /(?:^|\n)\s*Process life time\s*:/i;
const HEADER_ERROR_MESSAGE = /(?:^|\n)\s*Error message\s*:/i;
const HEADER_STACKTRACE = /(?:^|\n)\s*Stacktrace\s*:/i;
const HEADER_MSG = /(?:^|\n)\s*MSG\s*(?::|=)/i;
const FREEZE_EVENT = /\b(THREAD_BLOCK_6S|APP_INPUT_BLOCK|LIFECYCLE_TIMEOUT)\b/;
const THREAD_SECTION = /(?:^|\n)\s*(?:Tid|Name)\s*:/;
const SIGNAL_REASON = /\b(SIGSEGV|SIGABRT|SIGBUS|SIGILL|SIGFPE|SIGPIPE|Signal)\b/i;
const JS_ERROR_REASON = /\b(TypeError|SyntaxError|RangeError|ReferenceError|EvalError|URIError|Error)\b/;
const HILOG_LINE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+/;
/** 其他平台流水日志的行首特征。 */
const OTHER_PLATFORM_LOG =
  /^(-+\s+beginning\s+of\s+\w+\s+-+$|\[\s*\d+-\d+\s+\d+:\d+:\d+\.\d+\s+\d+:\d+\s+\w\/)/;

/** 采样栈（增强日志，freeze-cpuinfo-ext-*）结构标记；命中不足 2 项不判。 */
const SAMPLE_STACK_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/#Basic Statistical/i, '#Basic Statistical 统计段'],
  [/#CpuFreq Usage/i, '#CpuFreq Usage 频点段'],
  [/#ThreadInfos\s+Tid\s*:/i, '#ThreadInfos Tid 线程信息头'],
  [/(?:^|\n)\s*SnapshotTime\s*:/i, 'SnapshotTime 快照时间戳字段'],
  [/SubmitterStacktrace/, 'SubmitterStacktrace 提交者栈段'],
  [/(?:^|\n)\s*StaticsDuration\s*:/i, 'StaticsDuration 统计时长字段'],
];

interface DetectionHit {
  type: FaultLogFamily;
  evidence: string[];
}

function matchOne(text: string, pattern: RegExp): string | null {
  const m = pattern.exec(text);
  return m !== null && m[1] !== undefined && m[1] !== '' ? m[1].trim() : null;
}

function hasHeaderRegion(sample: string): boolean {
  let hits = 0;
  const patterns = [
    HEADER_REASON,
    HEADER_REGISTERS,
    HEADER_TIMESTAMP,
    HEADER_PID,
    HEADER_FAULT_THREAD,
    HEADER_PROCESS_LIFE,
    HEADER_ERROR_MESSAGE,
    HEADER_STACKTRACE,
    HEADER_MSG,
    FREEZE_EVENT,
  ];
  for (const pattern of patterns) {
    if (pattern.test(sample)) {
      hits += 1;
    }
  }
  return hits >= 2;
}

function collectNativeFrames(sample: string): string[] {
  const out: string[] = [];
  for (const line of sample.split('\n')) {
    if (NATIVE_FRAME.test(line)) {
      out.push(line.trim());
    }
    if (out.length >= 3) {
      break;
    }
  }
  return out;
}

function collectJsFrames(sample: string): string[] {
  const out: string[] = [];
  for (const line of sample.split('\n')) {
    if (JS_FRAME.test(line)) {
      out.push(line.trim());
    }
    if (out.length >= 3) {
      break;
    }
  }
  return out;
}

function countThreadSections(sample: string): number {
  return sample.split('\n').filter((line) => THREAD_SECTION.test(line)).length;
}

function detectCppCrash(sample: string, full: boolean): DetectionHit | null {
  const evidence: string[] = [];
  const reason = matchOne(sample, HEADER_REASON);
  if (reason !== null && SIGNAL_REASON.test(reason)) {
    evidence.push(`Reason 字段为 Signal 形态：${reason}`);
  }
  if (HEADER_REGISTERS.test(sample)) {
    evidence.push('存在 Registers 段');
  }
  if (HEADER_FAULT_THREAD.test(sample)) {
    evidence.push('存在 Fault thread info 段');
  }
  if (HEADER_PROCESS_LIFE.test(sample)) {
    evidence.push('存在 Process life time 段');
  }
  const frames = collectNativeFrames(sample);
  if (frames.length > 0) {
    evidence.push(`Native 栈帧形如 #NN pc <地址> <路径>（命中 ${frames.length} 帧）`);
  }

  if (full) {
    if (reason !== null && SIGNAL_REASON.test(reason) && evidence.length >= 3) {
      return { type: 'cpp_crash', evidence };
    }
    return null;
  }
  // 片段模式：只看正向特征，缺失字段不作为排除依据。
  return frames.length > 0 ? { type: 'cpp_crash', evidence } : null;
}

function detectJsError(sample: string, full: boolean): DetectionHit | null {
  const evidence: string[] = [];
  const reason = matchOne(sample, HEADER_REASON);
  if (reason !== null && JS_ERROR_REASON.test(reason)) {
    evidence.push(`Reason 字段为 JS 错误类名：${reason}`);
  }
  if (HEADER_ERROR_MESSAGE.test(sample)) {
    evidence.push('存在 Error message 字段');
  }
  if (HEADER_STACKTRACE.test(sample)) {
    evidence.push('存在 Stacktrace 字段');
  }
  const frames = collectJsFrames(sample);
  if (frames.length > 0) {
    evidence.push(`JS 栈帧形如 at f(path.ets:行:列)（命中 ${frames.length} 帧）`);
  }

  if (full) {
    if (reason !== null && JS_ERROR_REASON.test(reason) && evidence.length >= 3) {
      return { type: 'js_error', evidence };
    }
    return null;
  }
  return frames.length > 0 ? { type: 'js_error', evidence } : null;
}

function detectAppFreeze(sample: string, full: boolean): DetectionHit | null {
  const evidence: string[] = [];
  const m = FREEZE_EVENT.exec(sample);
  if (m !== null) {
    evidence.push(`Reason/事件名为冻屏类型：${m[1]}`);
  }
  if (HEADER_MSG.test(sample)) {
    evidence.push('存在 MSG 字段（承载主线程队列）');
  }
  const sections = countThreadSections(sample);
  if (sections >= 2) {
    evidence.push('多线程分节结构（Tid/Name 分块）');
  }

  if (full) {
    if (m !== null && evidence.length >= 3) {
      return { type: 'app_freeze', evidence };
    }
    return null;
  }
  return sections >= 2 || m !== null ? { type: 'app_freeze', evidence } : null;
}

/** 检出采样栈（增强日志）结构标记；返回命中的标记描述。 */
function detectSampleStack(sample: string): string[] {
  return SAMPLE_STACK_MARKERS.filter(([pattern]) => pattern.test(sample)).map(([, label]) => label);
}

/**
 * 越界输入检测。已检出完整故障日志头部（full=true）时跳过流水占比等越界判定：
 * cppcrash/jscrash/appfreeze 日志常内嵌大段 HiLog 区段，属正常结构而非流水输入。
 */
function detectOutOfScope(sample: string, full: boolean): OutOfScopeInfo | null {
  if (sample.trim() === '') {
    return { reason: 'empty', detail: '输入为空文件或无内容' };
  }

  const lines = sample.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return { reason: 'empty', detail: '输入为空文件或无内容' };
  }

  if (full) {
    return null;
  }

  const hilogHits = lines.filter((line) => HILOG_LINE.test(line)).length;
  if (hilogHits / lines.length > 0.6) {
    return {
      reason: 'hilog_stream',
      detail: '输入为 HiLog 流水日志，非 FaultLog，无法进行故障类型分诊',
    };
  }
  if (OTHER_PLATFORM_LOG.test(lines[0])) {
    return { reason: 'other_platform', detail: '输入为其他平台日志，非本平台故障日志' };
  }
  return null;
}

function detectMemoryCorruption(
  sample: string,
  faultType: FaultLogFamily
): MemoryCorruptionInfo | null {
  if (faultType !== 'cpp_crash') {
    return null;
  }
  const evidence: string[] = [];
  const reason = matchOne(sample, HEADER_REASON) ?? '';
  if (/\bsigsegv\b/i.test(reason)) {
    const addr = /0x[0-9a-fA-F]+/i.exec(reason);
    if (addr !== null) {
      const value = Number.parseInt(addr[0], 16);
      if (value > 0 && value < 0x10000) {
        evidence.push(`崩溃地址 ${addr[0]} 落在低地址区间，疑似踩内存目标`);
      }
    }
  }
  if (/0x[a-fA-F0-9]{8}\b/i.test(sample)) {
    const fill = /\b0x(61616161|deadbeef|beefbeef|00)+\b/i.exec(sample);
    if (fill !== null) {
      evidence.push(`疑似填充模式命中：0x${fill[1]}`);
    }
  }
  if (/SIGABRT/i.test(reason) && /stack|overflow|corrupt/i.test(sample)) {
    evidence.push('SIGABRT 且上下文含 stack/corrupt 关键字');
  }
  if (evidence.length === 0) {
    return { suspected: false, confidence: 'low', evidence: ['未命中踩内存正向特征'] };
  }
  return { suspected: true, confidence: evidence.length >= 2 ? 'medium' : 'low', evidence };
}

function confidenceFor(hit: DetectionHit, full: boolean, arbitrated: boolean): FaultConfidence {
  if (!full) {
    return arbitrated ? 'medium' : 'low';
  }
  if (hit.type === 'app_freeze') {
    return hit.evidence.length >= 3 ? 'high' : 'medium';
  }
  return hit.evidence.length >= 4 ? 'high' : 'medium';
}

function exclusionReason(faultType: FaultLogFamily, sample: string, full: boolean): string {
  if (!full) {
    if (faultType === 'cpp_crash') {
      return '未命中 Native 栈帧正向特征';
    }
    if (faultType === 'js_error') {
      return '未命中 JS 栈帧正向特征';
    }
    return '未命中多线程分节或冻屏事件名正向特征';
  }

  const reason = matchOne(sample, HEADER_REASON);
  const missing: string[] = [];
  if (faultType === 'cpp_crash') {
    if (!(reason !== null && SIGNAL_REASON.test(reason))) {
      missing.push('Signal 形态的 Reason');
    }
    if (!HEADER_REGISTERS.test(sample)) {
      missing.push('Registers 段');
    }
    if (collectNativeFrames(sample).length === 0) {
      missing.push('Native 栈帧');
    }
  } else if (faultType === 'js_error') {
    if (!(reason !== null && JS_ERROR_REASON.test(reason))) {
      missing.push('JS 错误类名的 Reason');
    }
    if (!HEADER_ERROR_MESSAGE.test(sample)) {
      missing.push('Error message 字段');
    }
    if (!HEADER_STACKTRACE.test(sample)) {
      missing.push('Stacktrace 字段');
    }
    if (collectJsFrames(sample).length === 0) {
      missing.push('JS 栈帧');
    }
  } else {
    if (!FREEZE_EVENT.test(sample)) {
      missing.push('冻屏事件名');
    }
    if (!HEADER_MSG.test(sample)) {
      missing.push('MSG 字段');
    }
    if (countThreadSections(sample) < 2) {
      missing.push('多线程分节');
    }
  }
  return missing.length > 0 ? `缺少：${missing.join('、')}` : '正向特征未达到完整日志判定阈值';
}

function buildExcluded(hits: DetectionHit[], full: boolean, sample: string): ExcludedInfo[] {
  const present = new Set(hits.map((hit) => hit.type));
  return FAULT_LOG_FAMILIES.filter((family) => !present.has(family)).map((family) => ({
    type: family,
    reason: exclusionReason(family, sample, full),
  }));
}

function requireHit(hits: DetectionHit[], type: FaultLogFamily): DetectionHit {
  const hit = hits.find((candidate) => candidate.type === type);
  if (hit === undefined) {
    throw new FaultLogError('INTERNAL_ERROR', `identify 内部错误：缺少 ${type} 检测命中`);
  }
  return hit;
}

function singleHitVerdict(hit: DetectionHit, full: boolean, sample: string): FaultLogVerdict {
  const result: FaultLogVerdict = {
    type: hit.type,
    confidence: confidenceFor(hit, full, false),
    completeness: full ? 'full' : 'fragment',
    evidence: hit.evidence,
    excluded: buildExcluded([hit], full, sample),
    candidates: [],
    filename_hint: '',
  };
  if (hit.type === 'cpp_crash') {
    result.memory_corruption_suspect = detectMemoryCorruption(sample, hit.type) ?? undefined;
  }
  if (hit.type === 'app_freeze') {
    const m = FREEZE_EVENT.exec(sample);
    if (m !== null) {
      result.subtype = m[1];
    }
  }
  return result;
}

/** 片段双栈（native + js）仲裁：优先 cpp_crash。 */
function dualStackVerdict(hits: DetectionHit[], sample: string): FaultLogVerdict {
  const primary = requireHit(hits, 'cpp_crash');
  const secondary = requireHit(hits, 'js_error');
  return {
    type: 'cpp_crash',
    confidence: 'medium',
    completeness: 'fragment',
    evidence: primary.evidence,
    excluded: buildExcluded([primary, secondary], false, sample),
    candidates: [
      { type: 'js_error', confidence: 'low', evidence: secondary.evidence, arbitrable: true },
    ],
    memory_corruption_suspect: detectMemoryCorruption(sample, 'cpp_crash') ?? undefined,
    filename_hint: '',
  };
}

function verdictFromHits(hits: DetectionHit[], full: boolean, sample: string): FaultLogVerdict {
  // 单命中：直接定类。
  if (hits.length === 1) {
    return singleHitVerdict(hits[0], full, sample);
  }

  const types = new Set(hits.map((hit) => hit.type));
  if (types.has('cpp_crash') && types.has('js_error') && !full) {
    return dualStackVerdict(hits, sample);
  }

  // 多候选且无确定性仲裁规则：交给上层澄清。
  return {
    type: 'unknown',
    confidence: 'low',
    completeness: full ? 'full' : 'fragment',
    evidence: [],
    excluded: buildExcluded(hits, full, sample),
    candidates: hits.map(
      (hit): CandidateInfo => ({
        type: hit.type,
        confidence: confidenceFor(hit, full, false),
        evidence: hit.evidence,
        arbitrable: false,
      })
    ),
    filename_hint: '',
  };
}

function outOfScopeVerdict(outOfScope: OutOfScopeInfo): FaultLogVerdict {
  return {
    type: 'unknown',
    confidence: 'low',
    completeness: 'fragment',
    evidence: [],
    excluded: [],
    candidates: [],
    filename_hint: '',
    out_of_scope: outOfScope,
  };
}

function collectDetectionHits(sample: string, full: boolean): DetectionHit[] {
  const hits: DetectionHit[] = [];
  for (const detect of [detectCppCrash, detectJsError, detectAppFreeze]) {
    const hit = detect(sample, full);
    if (hit !== null) {
      hits.push(hit);
    }
  }
  return hits;
}

function sampleStackVerdict(sampleMarkers: string[]): FaultLogVerdict {
  const strong = sampleMarkers.length >= 3;
  return {
    type: 'sample_stack',
    confidence: strong ? 'high' : 'medium',
    completeness: strong ? 'full' : 'fragment',
    evidence: [`采样栈(增强日志)结构标记：${sampleMarkers.join('、')}`],
    excluded: [
      {
        type: 'cpp_crash',
        reason: '输入为采样栈(增强日志)：native 帧为周期快照，非崩溃 faultlog',
      },
      {
        type: 'js_error',
        reason: '输入为采样栈(增强日志)：无 JS 错误 Reason / Stacktrace 结构',
      },
      {
        type: 'app_freeze',
        reason: '输入为采样栈(增强日志)：无冻屏事件名 / MSG 字段，需配套冻屏 faultlog 定类',
      },
    ],
    candidates: [],
    filename_hint: '',
  };
}

function unknownNoHitVerdict(full: boolean, sample: string): FaultLogVerdict {
  return {
    type: 'unknown',
    confidence: 'low',
    completeness: full ? 'full' : 'fragment',
    evidence: [],
    excluded: buildExcluded([], full, sample),
    candidates: [],
    filename_hint: '',
  };
}

/** 对（已采样的）日志文本执行类型判定。 */
export function classifyFaultLog(sample: string): FaultLogVerdict {
  const full = hasHeaderRegion(sample);
  const outOfScope = detectOutOfScope(sample, full);
  if (outOfScope !== null) {
    return outOfScopeVerdict(outOfScope);
  }

  const sampleMarkers = detectSampleStack(sample);
  const hits = collectDetectionHits(sample, full);

  // 完整 faultlog 与采样栈标记共存时，faultlog 类型优先，采样栈只作配套证据。
  if (hits.length > 0 && full) {
    const result = verdictFromHits(hits, full, sample);
    if (sampleMarkers.length > 0) {
      result.evidence = [
        ...result.evidence,
        `同时检出采样栈(增强日志)结构标记（${sampleMarkers.length} 项），可作为冻屏分析配套证据`,
      ];
    }
    return result;
  }

  // 采样栈标记存在而无完整 faultlog：片段模式的故障命中一律让位于 sample_stack 判定
  //（其 native 帧是周期快照采样，不能作为崩溃证据）；命中不足 2 项标记不判为采样文件。
  if (sampleMarkers.length >= 2) {
    return sampleStackVerdict(sampleMarkers);
  }

  if (hits.length === 0) {
    return unknownNoHitVerdict(full, sample);
  }

  return verdictFromHits(hits, full, sample);
}
