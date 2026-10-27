/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * 采样栈分析（appfreeze/scripts/sample_stack_analyzer.py 的移植）。
 *
 * 解析 sample_stacks 快照：基本信息（采样时长/CPU）+ 按快照时间分组的调用栈，
 * 统计各父节点（栈底业务帧）出现次数，输出热点排行与各快照的业务调用链。
 * 与参考实现的差异：调用链保持父节点在前（自底向上），符合 CLI 契约样例。
 */
import type {
  FaultLogVerdict,
  SampleStackAnalysisResult,
  SampleStackHotspot,
} from '../types.js';
import { identifyFaultLogContent, identifyFaultLogFile } from '../identify/identify-faultlog.js';
import { FaultLogError } from '../faultlog-error.js';
import { fmtTime, parseTime, readFileLines, splitLogLines } from '../crash/log-text.js';
import { parseFrames, type StackFrame } from '../crash/stack-parser.js';

/** 分析输入：本地文件路径或文本内容（二选一）。 */
export interface SampleStackInput {
  path?: string;
  content?: string;
}

interface SnapshotInfo {
  date: Date;
  frames: StackFrame[];
}

const MARKER_BASIC = '#Basic Statistical';
const MARKER_CPU = '#CpuFreq Usage';
const MARKER_TID = '#ThreadInfos Tid:';
const STATICS_DURATION_RE = /^StaticsDuration:\s+(\d+)\s+ms/;
const CPU_TIME_RE = /^CpuTime:\s+(\d+)\s+ms/;
// 点号不转义，与参考实现保持一致
const CPU_USAGE_RE = /^cpu(\d+) Usage (\d+.\d+)%/;

/** 分析采样栈文件。hotspotLimit 限制输出的热点数量（默认全部）。 */
export function analyzeSampleStack(
  input: SampleStackInput,
  hotspotLimit?: number
): SampleStackAnalysisResult {
  let verdict: FaultLogVerdict;
  let lines: string[];
  let sourcePath: string;
  if (input.path !== undefined) {
    verdict = identifyFaultLogFile(input.path);
    lines = readFileLines(input.path);
    sourcePath = input.path;
  } else if (input.content !== undefined) {
    verdict = identifyFaultLogContent(input.content);
    lines = splitLogLines(input.content);
    sourcePath = verdict.filename_hint;
  } else {
    throw new FaultLogError('INVALID_INPUT', '必须提供采样栈文件路径或采样栈内容');
  }
  if (verdict.type !== 'sample_stack') {
    throw new FaultLogError(
      'INVALID_INPUT',
      `该日志不是采样栈文件（判定为 ${verdict.type}），--stack 仅支持采样栈日志`
    );
  }
  const snapshots = buildSnapshots(lines);
  return {
    schemaVersion: '1.0.0',
    logType: 'sample_stack',
    source: { kind: 'file', path: sourcePath },
    identify: verdict,
    summary: summarize(lines, snapshots.size),
    hotspots: collectHotspots(snapshots, hotspotLimit),
  };
}

/** 定位三个结构标记（取最后一次出现；缺失为 -1）。 */
function findMarkers(lines: string[]): [number, number, number] {
  let basicStart = -1;
  let cpuStart = -1;
  let tidStart = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.includes(MARKER_BASIC)) {
      basicStart = index;
    }
    if (line.includes(MARKER_CPU)) {
      cpuStart = index;
    }
    if (line.includes(MARKER_TID)) {
      tidStart = index;
    }
  }
  return [basicStart, cpuStart, tidStart];
}

function summarize(lines: string[], snapshotCount: number): SampleStackAnalysisResult['summary'] {
  const [basicStart, cpuStart, tidStart] = findMarkers(lines);
  let staticsDuration = 0;
  let cpuTime = 0;
  if (basicStart >= 0) {
    const durationEnd = cpuStart >= 0 ? cpuStart : lines.length;
    for (const line of lines.slice(basicStart, durationEnd)) {
      const durationMatch = STATICS_DURATION_RE.exec(line);
      if (durationMatch !== null) {
        staticsDuration = Number.parseInt(durationMatch[1], 10);
      }
      const cpuTimeMatch = CPU_TIME_RE.exec(line);
      if (cpuTimeMatch !== null) {
        cpuTime = Number.parseInt(cpuTimeMatch[1], 10);
      }
    }
  }
  const cpuUsage: Record<string, number> = {};
  if (cpuStart >= 0) {
    const usageEnd = tidStart >= 0 ? tidStart : lines.length;
    for (const line of lines.slice(cpuStart, usageEnd)) {
      const usageMatch = CPU_USAGE_RE.exec(line);
      if (usageMatch !== null) {
        cpuUsage[usageMatch[1]] = Number.parseFloat(usageMatch[2]);
      }
    }
  }
  return {
    'statics-duration-ms': staticsDuration,
    'cpu-time-ms': cpuTime,
    'cpu-usage': cpuUsage,
    'snapshot-count': snapshotCount,
  };
}

/** {快照时间毫秒: 快照}；同一时间重复出现时后值覆盖（与参考实现一致）。 */
function buildSnapshots(lines: string[]): Map<number, SnapshotInfo> {
  const [, , tidStart] = findMarkers(lines);
  const stackLines = tidStart >= 0 ? lines.slice(tidStart) : [];
  const markerIndexes: number[] = [];
  const markerTimes: Array<Date | null> = [];
  let submitterStart = -1;
  for (let index = 0; index < stackLines.length; index++) {
    const line = stackLines[index];
    if (line.includes('Timestamp:') || line.includes('SnapshotTime:')) {
      markerIndexes.push(index);
      markerTimes.push(parseTime(line.slice(line.indexOf(':') + 1).trim()));
      continue;
    }
    if (submitterStart < 0 && line.includes('SubmitterStacktrace')) {
      submitterStart = index;
    }
  }
  const snapshots = new Map<number, SnapshotInfo>();
  for (let order = 0; order < markerIndexes.length; order++) {
    const date = markerTimes[order];
    if (date === null || date === undefined) {
      continue;
    }
    const start = markerIndexes[order] + 1;
    // 最后一个快照止于 SubmitterStacktrace 区段或文件末尾，避免混入提交者调用帧。
    const end =
      order + 1 < markerIndexes.length
        ? markerIndexes[order + 1]
        : submitterStart >= 0
          ? submitterStart
          : stackLines.length;
    snapshots.set(date.getTime(), { date, frames: parseFrames(stackLines.slice(start, end)) });
  }
  return snapshots;
}

/** 单个快照的业务调用链（父节点在前）；无业务帧返回 null。 */
function snapshotBusinessChain(snapshot: SnapshotInfo): string[] | null {
  // 从栈底（最大编号）向上取业务帧：首个命中的即父节点，调用链父节点在前
  const calls: string[] = [];
  for (let index = snapshot.frames.length - 1; index >= 0; index--) {
    const frame = snapshot.frames[index];
    if (frame.area === 'system') {
      continue;
    }
    if (frame.brief.includes('anonymous')) {
      continue;
    }
    calls.push(frame.brief);
  }
  return calls.length > 0 ? calls : null;
}

function collectHotspots(
  snapshots: Map<number, SnapshotInfo>,
  hotspotLimit?: number
): SampleStackHotspot[] {
  const parentTimes = new Map<string, Date[]>();
  const chainByTime = new Map<number, string[]>();
  const orderedTimes = [...snapshots.keys()].sort((a, b) => a - b);
  for (const timeKey of orderedTimes) {
    const snapshot = snapshots.get(timeKey);
    if (snapshot === undefined) {
      continue;
    }
    const calls = snapshotBusinessChain(snapshot);
    if (calls === null) {
      continue;
    }
    const parent = calls[0];
    const times = parentTimes.get(parent);
    if (times === undefined) {
      parentTimes.set(parent, [snapshot.date]);
    } else {
      times.push(snapshot.date);
    }
    chainByTime.set(timeKey, calls);
  }
  const hotspots: SampleStackHotspot[] = [...parentTimes.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([parent, times]) => ({
      'parent-node': parent,
      count: times.length,
      'total-snapshots': snapshots.size,
      chains: times
        .sort((a, b) => a.getTime() - b.getTime())
        .map((date) => ({
          timestamp: fmtTime(date),
          calls: chainByTime.get(date.getTime()) ?? [],
        })),
    }));
  return hotspotLimit !== undefined ? hotspots.slice(0, hotspotLimit) : hotspots;
}

/** 渲染文本报告（--format report / default）。 */
export function renderSampleStackReport(result: SampleStackAnalysisResult): string {
  const summary = result.summary;
  const lines: string[] = [
    '='.repeat(24),
    '采样栈分析报告',
    '='.repeat(24),
    '【基本信息】',
    `StaticsDuration: ${summary['statics-duration-ms']}ms`,
    `CpuTime: ${summary['cpu-time-ms']}ms`,
  ];
  const cpuEntries = Object.entries(summary['cpu-usage']);
  if (cpuEntries.length === 0) {
    lines.push('CPU使用率: 未获取到');
  } else {
    lines.push('CPU使用率:');
    for (const [cpu, usage] of cpuEntries) {
      lines.push(`  CPU${cpu}: ${usage}%`);
    }
  }
  lines.push(`快照总数: ${summary['snapshot-count']}`);
  lines.push('【父节点统计】');
  if (result.hotspots.length === 0) {
    lines.push('未解析到业务帧热点');
  } else {
    appendHotspotLines(lines, result.hotspots);
  }
  return lines.join('\n');
}

/** 父节点热点段：名称对齐 + 每热点编号调用链。 */
function appendHotspotLines(lines: string[], hotspots: SampleStackHotspot[]): void {
  const nameWidth = Math.max(...hotspots.map((hotspot) => hotspot['parent-node'].length)) + 2;
  hotspots.forEach((hotspot, index) => {
    if (index > 0) {
      lines.push('');
    }
    const percent = (hotspot.count * 100) / hotspot['total-snapshots'];
    const percentText = Number.isInteger(percent)
      ? `${percent}%`
      : `${percent.toFixed(1)}%`;
    lines.push(
      `${hotspot['parent-node'].padEnd(nameWidth)}出现次数: ${hotspot.count}/${hotspot['total-snapshots']}  占比: ${percentText}`
    );
    lines.push('  调用链:');
    hotspot.chains.forEach((chain, chainIndex) => {
      lines.push(`    [快照${chainIndex + 1}] ${chain.calls.join(' -> ')}`);
    });
  });
}
