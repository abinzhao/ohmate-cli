/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * js_error（JSCrash）faultlog 解析。
 *
 * jscrash 无独立参考脚本，按 analyzer.md 的字段契约实现：
 * 头部字段（Reason / Error name / Error message / ...）+ 'Stacktrace:' 帧区段。
 */
import { searchFields } from './log-text.js';
import { THREAD_HEADER_RE } from './stack-parser.js';
import { FaultLogError } from '../faultlog-error.js';

const FIELD_RES: Record<string, RegExp> = {
  module_name: /Module name:(.*)/,
  process_name: /Process name:(.*)/,
  package_name: /Package name:(.*)/,
  pid: /Pid:(.*)/,
  uid: /Uid:(.*)/,
  fault_time: /Fault time:(.*)/,
  timestamp: /Timestamp:(.*)/,
  reason: /Reason:(.*)/,
  error_name: /Error name:(.*)/,
  error_message: /Error message:(.*)/,
  error_code: /Error code:(.*)/,
  page: /page:(.*)/,
  app_version: /Version:(.*)/,
  fingerprint: /Fingerprint:(.*)/,
};

/** js 帧行：'at foo (/path/file.ets:10:15)' 或 '#00 at foo (...)'。 */
const JS_FRAME_RE = /^\s*(?:#\d+\s+)?at\s+\S+\s*\(.*:\d+:\d+\)/;

export interface JsErrorLog {
  header: {
    module_name: string;
    process_name: string;
    package_name: string;
    pid: string;
    uid: string;
    fault_time: string;
    timestamp: string;
    reason: string;
    error_name: string;
    error_message: string;
    error_code: string;
    page: string;
    app_version: string;
    fingerprint: string;
  };
  /** 'Fault thread info:' 存在时取其 Tid，否则为空。 */
  faultTid: string;
  faultThreadName: string;
  /** 'Stacktrace:' 区段的原始帧行。 */
  frames: string[];
}

/** 解析入口：js_error 日志行 -> JsErrorLog。 */
export function parseJsErrorLog(lines: string[]): JsErrorLog {
  if (lines.length === 0) {
    throw new FaultLogError('FILE_NOT_FOUND', '文件不存在或为空');
  }
  const fields = searchFields(lines, FIELD_RES);
  let faultTid = '';
  let faultThreadName = '';
  for (const line of lines) {
    const headerMatch = THREAD_HEADER_RE.exec(line);
    if (headerMatch !== null) {
      faultTid = headerMatch[1];
      faultThreadName = headerMatch[2].trim();
      break;
    }
  }
  return {
    header: {
      module_name: fields.module_name ?? '',
      process_name: fields.process_name ?? '',
      package_name: fields.package_name ?? '',
      pid: fields.pid ?? '',
      uid: fields.uid ?? '',
      fault_time: fields.fault_time ?? '',
      timestamp: fields.timestamp ?? '',
      reason: fields.reason ?? '',
      error_name: fields.error_name ?? '',
      error_message: fields.error_message ?? '',
      error_code: fields.error_code ?? '',
      page: fields.page ?? '',
      app_version: fields.app_version ?? '',
      fingerprint: fields.fingerprint ?? '',
    },
    faultTid,
    faultThreadName,
    frames: collectStacktrace(lines),
  };
}

/**
 * 从 'Stacktrace:' 行开始收集帧，遇到首个非空非帧行结束
 * （后续的 SubmitterStacktrace 等区段不会误入）。
 */
function collectStacktrace(lines: string[]): string[] {
  let startIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() === 'Stacktrace:') {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) {
    return [];
  }
  const frames: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === '') {
      continue;
    }
    if (!JS_FRAME_RE.test(line)) {
      break;
    }
    frames.push(line);
  }
  return frames;
}
