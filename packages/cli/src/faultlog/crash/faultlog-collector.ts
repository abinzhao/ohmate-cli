/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * faultlog 目录收集（cppcrash/collector.py 的泛化移植：三族统一参选）。
 *
 * 递归扫描目录，对每个文件做类型判定，仅保留 cpp_crash/js_error/app_freeze；
 * 排序：置信度 -> 完整性 -> 故障时间（新优先） -> 路径。
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  FaultCompleteness,
  FaultConfidence,
  FaultLogFamily,
} from '../types.js';
import { isFaultLogFamily } from '../types.js';
import { identifyFaultLogFile } from '../identify/identify-faultlog.js';
import { FaultLogError } from '../faultlog-error.js';

/** 收集到的一条候选。 */
export interface CollectedFaultLog {
  path: string;
  type: FaultLogFamily;
  confidence: FaultConfidence;
  completeness: FaultCompleteness;
  /** 故障时间（文件名时间戳优先，回退修改时间），仅用于排序。 */
  timeMs: number;
}

export interface CollectResult {
  candidates: CollectedFaultLog[];
  /** 扫描文件数按判定类型统计（含不可读文件），用于无候选时的报错信息。 */
  typeCounts: Record<string, number>;
}

const CONFIDENCE_ORDER: Record<FaultConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const COMPLETENESS_ORDER: Record<FaultCompleteness, number> = {
  full: 0,
  fragment: 1,
};

/** 标准命名尾部 14 位日期时间，或 temp 命名尾部 13 位 epoch 毫秒。 */
const NAME_TIME_RE = /(\d{13,17})(?:\D*)$/;

/** 文件名时间戳：14 位 yyyyMMddHHmmSS[mmm] 或 13 位 epoch 毫秒；无法解析返回 null。 */
function parseFilenameTimestamp(value: string): number | null {
  if (value.length >= 14 && (value.startsWith('19') || value.startsWith('20'))) {
    const month = Number.parseInt(value.slice(4, 6), 10);
    const day = Number.parseInt(value.slice(6, 8), 10);
    const hour = Number.parseInt(value.slice(8, 10), 10);
    const minute = Number.parseInt(value.slice(10, 12), 10);
    const second = Number.parseInt(value.slice(12, 14), 10);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    const fraction = value.slice(14, 17);
    let ms = 0;
    if (fraction !== '') {
      ms = Math.round((Number.parseInt(fraction, 10) * 1000) / 10 ** fraction.length);
    }
    const date = new Date(
      Number.parseInt(value.slice(0, 4), 10),
      month - 1,
      day,
      hour,
      minute,
      second,
      ms
    );
    // Python strptime 对无效日期抛 ValueError；JS Date 会回卷，用组件校验兜底
    if (Number.isNaN(date.getTime()) || date.getDate() !== day) {
      return null;
    }
    return date.getTime();
  }
  if (value.length === 13) {
    const epoch = Number.parseInt(value, 10);
    return Number.isNaN(epoch) ? null : epoch;
  }
  return null;
}

/** 日志时间：文件名尾部时间戳优先，无法解析时回退文件修改时间。 */
function logTimeMs(filePath: string): number {
  const match = NAME_TIME_RE.exec(path.basename(filePath));
  if (match !== null) {
    const parsed = parseFilenameTimestamp(match[1]);
    if (parsed !== null) {
      return parsed;
    }
  }
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  return stat !== undefined ? stat.mtimeMs : 0;
}

/** 递归收集目录下全部文件路径。 */
function walkFiles(dir: string, out: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, out);
    } else if (entry.isFile()) {
      out.push(entryPath);
    }
  }
}

/** 单文件判定；超过 20MB / 不可读 / 二进制文件按 unreadable 计。 */
function identifyCandidateFields(
  file: string
): { type: string; confidence: FaultConfidence; completeness: FaultCompleteness } {
  try {
    const verdict = identifyFaultLogFile(file);
    return {
      type: verdict.type,
      confidence: verdict.confidence,
      completeness: verdict.completeness,
    };
  } catch {
    return { type: 'unreadable', confidence: 'low', completeness: 'fragment' };
  }
}

/** 排序：置信度 -> 完整性 -> 故障时间（新优先） -> 路径。 */
function compareCandidates(a: CollectedFaultLog, b: CollectedFaultLog): number {
  const byConfidence = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
  if (byConfidence !== 0) {
    return byConfidence;
  }
  const byCompleteness = COMPLETENESS_ORDER[a.completeness] - COMPLETENESS_ORDER[b.completeness];
  if (byCompleteness !== 0) {
    return byCompleteness;
  }
  if (a.timeMs !== b.timeMs) {
    return b.timeMs - a.timeMs;
  }
  return a.path.localeCompare(b.path);
}

/** 收集并排序；目录不存在时抛错。 */
export function collectFaultLogs(dirPath: string): CollectResult {
  const stat = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (stat === undefined) {
    throw new FaultLogError('FILE_NOT_FOUND', `路径不存在: ${dirPath}`);
  }
  if (stat.isFile()) {
    throw new FaultLogError('INVALID_INPUT', `预期为目录: ${dirPath}`);
  }
  const files: string[] = [];
  walkFiles(dirPath, files);
  const candidates: CollectedFaultLog[] = [];
  const typeCounts: Record<string, number> = {};
  for (const file of files) {
    const fields = identifyCandidateFields(file);
    typeCounts[fields.type] = (typeCounts[fields.type] ?? 0) + 1;
    if (isFaultLogFamily(fields.type)) {
      candidates.push({
        path: file,
        type: fields.type,
        confidence: fields.confidence,
        completeness: fields.completeness,
        timeMs: logTimeMs(file),
      });
    }
  }
  candidates.sort(compareCandidates);
  return { candidates, typeCounts };
}
