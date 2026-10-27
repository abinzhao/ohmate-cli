/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * cppcrash faultlog 解析（cppcrash/crash_log.py 的移植，按 CLI 契约裁剪）。
 *
 * 保留：头部字段、故障线程堆栈（复用 freeze 的堆栈解析）、
 * GWP-ASan 报告原文。
 * 不含：llvm-addr2line 所需的寄存器/maps 等符号化输入（如需可用 default 格式输出原文）。
 */
import { splitByMarkers } from './log-text.js';
import { searchFields } from './log-text.js';
import { FaultLogError } from '../faultlog-error.js';
import { parseThreadStacks, type ThreadStack } from './stack-parser.js';

export const CPP_SECTION_MARKERS: readonly string[] = [
  'Fault thread info:',
  'Registers:',
  'Other thread info:',
  'Memory near registers:',
  'FaultStack:',
  'Maps:',
  'OpenFiles:',
  'HiLog:',
];

const HEADER_FIELD_RES: Record<string, RegExp> = {
  device_info: /Device info:(.*)/,
  build_version: /Build info:(.*)/,
  module_name: /Module name:(.*)/,
  app_version: /Version:(.*)/,
  is_pre_installed: /PreInstalled:(.*)/,
  foreground: /Foreground:(.*)/,
  pid: /Pid:(.*)/,
  uid: /Uid:(.*)/,
  process_name: /Process name:(.*)/,
  process_life_time: /Process life time:(.*)/,
  timestamp: /Timestamp:(.*)/,
  reason: /Reason:(.*)/,
  last_fatal_message: /LastFatalMessage:(.*)/,
};

export interface CppCrashHeader {
  device_info: string;
  build_version: string;
  module_name: string;
  app_version: string;
  is_pre_installed: string;
  foreground: string;
  pid: string;
  uid: string;
  process_name: string;
  process_life_time: string;
  timestamp: string;
  reason: string;
  last_fatal_message: string;
}

export interface CppCrashLog {
  header: CppCrashHeader;
  /** 'Fault thread info:' 区段的首个线程。 */
  faultStack: ThreadStack | null;
  /** GWP-ASan 检测报告原文（含违规/释放/申请调用栈）。 */
  gwpAsanText: string;
}

/** 提取 GWP-ASan 报告：从检测标记行到结束标记行（含），去尾部空行。 */
function extractGwpAsan(lines: string[]): string {
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].includes('*** GWP-ASan detected a memory error ***')) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return '';
  }
  let end = lines.length;
  for (let index = start; index < lines.length; index++) {
    if (lines[index].includes('* End GWP-ASan report *')) {
      end = index + 1;
      break;
    }
  }
  return lines
    .slice(start, end)
    .join('\n')
    .replace(/\n+$/, '');
}

/** 解析入口：cppcrash 日志行 -> CppCrashLog。 */
export function parseCppCrashLog(lines: string[]): CppCrashLog {
  if (lines.length === 0) {
    throw new FaultLogError('FILE_NOT_FOUND', '文件不存在或为空');
  }
  const sections = splitByMarkers(lines, [...CPP_SECTION_MARKERS]);
  const fields = searchFields(sections.get('') ?? [], HEADER_FIELD_RES);
  const faultThreads = parseThreadStacks(sections.get('Fault thread info:') ?? []);
  return {
    header: {
      device_info: fields.device_info ?? '',
      build_version: fields.build_version ?? '',
      module_name: fields.module_name ?? '',
      app_version: fields.app_version ?? '',
      is_pre_installed: fields.is_pre_installed ?? '',
      foreground: fields.foreground ?? '',
      pid: fields.pid ?? '',
      uid: fields.uid ?? '',
      process_name: fields.process_name ?? '',
      process_life_time: fields.process_life_time ?? '',
      timestamp: fields.timestamp ?? '',
      reason: fields.reason ?? '',
      last_fatal_message: fields.last_fatal_message ?? '',
    },
    faultStack: faultThreads.size > 0 ? [...faultThreads.values()][0] : null,
    gwpAsanText: extractGwpAsan(lines),
  };
}
