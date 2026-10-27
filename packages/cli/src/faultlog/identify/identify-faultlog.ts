/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * identify 适配层：文件/文本内容 -> FaultLogVerdict。
 *
 * 契约（与 identify_fault_log.py 一致）：
 * - 超过 20MB 直接报错拒绝，绝不静默截断；
 * - 512KB 以内整体判定，512KB-20MB 之间取头尾结构采样（256KB 头 + 256KB 尾）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { FaultLogError } from '../faultlog-error.js';
import type { FaultLogVerdict } from '../types.js';
import { classifyFaultLog } from './classify.js';

/** 单个日志最大 20MB，超出直接拒绝。 */
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
const SAMPLE_HEAD = 256 * 1024;
const SAMPLE_TAIL = 256 * 1024;

function normalizeCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripBom(text: string): string {
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/**
 * 字节采样：超过 size 时取头尾各一半，中间以固定标记衔接（标记串与 Python 版一致）。
 * Node 的 UTF-8 解码对非法字节以替换字符兜底，等价于 errors="replace"。
 */
export function sampleBytes(data: Buffer, size: number): string {
  const total = data.length;
  let text: string;
  if (total <= size) {
    text = data.toString('utf8');
  } else {
    const half = Math.floor(size / 2);
    const head = data.subarray(0, half).toString('utf8');
    const tail = data.subarray(Math.max(0, total - half)).toString('utf8');
    text = `${head}\n…（中段省略）…\n${tail}`;
  }
  return stripBom(normalizeCrlf(text));
}

/** 判定本地 faultlog 文件。文件不存在、非普通文件或超限时抛错。 */
export function identifyFaultLogFile(filePath: string, filenameHint?: string): FaultLogVerdict {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new FaultLogError('FILE_NOT_FOUND', `Fault log not found or not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_LOG_BYTES) {
    throw new FaultLogError(
      'INPUT_OVERSIZED',
      `Fault log exceeds ${MAX_LOG_BYTES / 1024 / 1024}MB limit (size=${stat.size}). ` +
        'Provide a smaller or complete file.'
    );
  }
  const data = fs.readFileSync(filePath);
  const verdict = classifyFaultLog(sampleBytes(data, SAMPLE_HEAD + SAMPLE_TAIL));
  verdict.filename_hint = filenameHint ?? path.basename(filePath);
  return verdict;
}

/** 判定文本内容（如从设备拉取的 faultlog 文本）。超限时抛错。 */
export function identifyFaultLogContent(content: string, filenameHint = 'pasted.log'): FaultLogVerdict {
  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_LOG_BYTES) {
    throw new FaultLogError(
      'INPUT_OVERSIZED',
      `Fault log content exceeds ${MAX_LOG_BYTES / 1024 / 1024}MB limit (size=${data.length}). ` +
        'Provide a smaller or complete log.'
    );
  }
  const verdict = classifyFaultLog(sampleBytes(data, SAMPLE_HEAD + SAMPLE_TAIL));
  verdict.filename_hint = filenameHint;
  return verdict;
}
