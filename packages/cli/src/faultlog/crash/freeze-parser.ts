/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * appfreeze faultlog 解析（freeze/faultlog.py + sections.py 关键路径的移植）。
 *
 * faultlog 结构：头部（Device info / Reason 等，以一行 '****...' 结束）；
 * warning 部分（第一次上报：MSG、线程堆栈等）；可选 block 部分（第二次抓栈，
 * 以另一行 '****...' 开头）。binder / CPU / FFRT 在全文中只出现一次，全文定位。
 */
import type { BinderInfo } from './binder-chain.js';
import { parseBinder } from './binder-chain.js';
import { findSection, lastSegment, parseTime, searchFields } from './log-text.js';
import { extractStackErrors, parseThreadStacks, type ThreadStack } from './stack-parser.js';
import { FaultLogError } from '../faultlog-error.js';

/** 头部结束 / warning 与 block 的分隔行：整行星号。 */
const SEPARATOR_RE = /^\*{3,}\s*$/;
/** 主进程堆栈区段的结束标志（防止误把 binder 对端堆栈并进来）。 */
const STACK_END_RE = /Catche stack trace end time:|BinderCatcher --|PeerBinderCatcher|^-{5,}\s*$/;
const STACK_START_RE = /^Tid:\d+(?:,|\s)+Name:/;
const CPU_ROW_RE = /\s+(\d+)\s+(\d+\.\d+)%\s+\d+\.\d+%\s+\d+\.\d+%\s+\d+\s+\d+\s+(.*)/;

const HEADER_FIELD_RES: Record<string, RegExp> = {
  module_name: /Module name:(.*)/,
  reason: /Reason:(.*)/,
  process_name: /(?:PROCESS_NAME|Process name):(.*)/,
  pid: /(?:PID = |Pid:|pid=)(.*)/,
};

const MSG_FIELD_RES: Record<string, RegExp> = {
  start_time: /start time:(.*)/,
  event_name: /EVENTNAME = (.*)/,
  timestamp: /TIMESTAMP = (.*)/,
  pid: /(?:PID = |Pid:|pid=)(.*)/,
  tid: /(?:TID = |Tid:|tid=)(.*)/,
  uid: /(?:UID = |Uid:|uid=)(.*)/,
  module_name: /MODULE_NAME = (.*)/,
  process_name: /(?:PROCESS_NAME = |PROCESS_NAME:)(.*)/,
  msg: /MSG =(.*)/,
  fault_time: /Fault time:(.*)/,
};

export interface FreezeHeader {
  reason: string;
  module_name: string;
  process_name: string;
  pid: string;
}

export interface FreezeMsg {
  start_time: string;
  event_name: string;
  timestamp: string;
  pid: string;
  tid: string;
  uid: string;
  module_name: string;
  process_name: string;
  msg: string;
  fault_time: string;
}

/** 一次上报抓取的内容（warning 或 block）。 */
export interface FreezePart {
  msg: FreezeMsg;
  stacks: Map<string, ThreadStack>;
  stack_errors: string[];
}

export interface FreezeLog {
  reason: string;
  header: FreezeHeader;
  warning: FreezePart;
  block: FreezePart | null;
  binder: BinderInfo;
  cpuProcessNames: Map<string, string>;
  ffrtTid: string;
  /** {pid: 进程名}（binder 节点命名用）。 */
  processNames: Map<string, string>;
}

function emptyMsg(): FreezeMsg {
  return {
    start_time: '',
    event_name: '',
    timestamp: '',
    pid: '',
    tid: '',
    uid: '',
    module_name: '',
    process_name: '',
    msg: '',
    fault_time: '',
  };
}

/** 解析文件头部。只扫描到第一个 'start time:' 之前，避免误读 MSG 区段。 */
function parseHeader(lines: string[]): FreezeHeader {
  let endIndex = lines.length;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].includes('start time:')) {
      endIndex = index;
      break;
    }
  }
  const fields = searchFields(lines.slice(0, endIndex), HEADER_FIELD_RES);
  return {
    reason: fields.reason ?? '',
    module_name: fields.module_name ?? '',
    process_name: fields.process_name ?? '',
    pid: fields.pid ?? '',
  };
}

/** 解析事件上报区段：'start time:' 到 'MSG = ' 后两行。 */
function parseMsg(lines: string[]): FreezeMsg {
  let startIndex = -1;
  let endIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (startIndex < 0 && /start time:/.test(lines[index])) {
      startIndex = index;
    }
    if (/MSG =/.test(lines[index])) {
      endIndex = index + 2;
      break;
    }
  }
  if (startIndex < 0 || endIndex < 0) {
    return emptyMsg();
  }
  const fields = searchFields(lines.slice(startIndex, endIndex), MSG_FIELD_RES);
  return {
    start_time: fields.start_time ?? '',
    event_name: fields.event_name ?? '',
    timestamp: fields.timestamp ?? '',
    pid: fields.pid ?? '',
    tid: fields.tid ?? '',
    uid: fields.uid ?? '',
    module_name: fields.module_name ?? '',
    process_name: fields.process_name ?? '',
    msg: fields.msg ?? '',
    fault_time: fields.fault_time ?? '',
  };
}

/** 按星号分隔行拆出 warning / block 两部分（第 2 个分隔行之后是 block）。 */
function splitParts(lines: string[]): [string[], string[]] {
  const separatorIndexes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (SEPARATOR_RE.test(lines[index])) {
      separatorIndexes.push(index);
    }
  }
  if (separatorIndexes.length >= 2) {
    const splitAt = separatorIndexes[1];
    return [lines.slice(0, splitAt), lines.slice(splitAt)];
  }
  return [lines, []];
}

/** 解析一次上报的内容：MSG、线程堆栈。 */
function parsePart(lines: string[]): FreezePart {
  const msg = parseMsg(lines);
  const [stackLines] = findSection(lines, STACK_START_RE, STACK_END_RE);
  const stacks = parseThreadStacks(stackLines);
  const stackErrors = extractStackErrors(stackLines);
  return {
    msg,
    stacks,
    stack_errors: stackErrors,
  };
}

/** CPU 使用率区段（--[cpuusage]--）中的 {pid: 进程名}。 */
function parseCpuProcessNames(lines: string[]): Map<string, string> {
  const names = new Map<string, string>();
  const [section] = findSection(lines, /--\[cpuusage\]--/, /cpuusage end time:/);
  for (const line of section) {
    const rowMatch = CPU_ROW_RE.exec(line);
    if (rowMatch !== null) {
      const pid = rowMatch[1];
      const name = lastSegment(rowMatch[3].trim());
      if (!names.has(pid)) {
        names.set(pid, name);
      }
    }
  }
  return names;
}

/** FFRT 队列阻塞线程 tid（SERVICE_BLOCK 场景定位队列工作线程）。 */
function parseFfrtTid(lines: string[]): string {
  const [section] = findSection(
    lines,
    /FfrtCallback:|FfrtCatcher -- start time/,
    /FfrtCatcher -- end time/
  );
  for (const line of section) {
    const tidMatch = /worker tid (\d+) queue task is running, task id (\d+)/.exec(line);
    if (tidMatch !== null) {
      return tidMatch[1];
    }
  }
  return '';
}

/** 汇总 {pid: 进程名}：CPU 区段 + binder 对端 + 故障进程自身。 */
function buildProcessNames(log: FreezeLog): Map<string, string> {
  const names = new Map(log.cpuProcessNames);
  for (const [pid, peer] of log.binder.peers) {
    if (peer.processName !== '') {
      names.set(pid, lastSegment(peer.processName));
    }
  }
  const pid = freezePid(log);
  const processName = freezeProcessName(log);
  if (pid !== '' && processName !== '') {
    names.set(pid, lastSegment(processName));
  }
  return names;
}

export function freezePid(log: FreezeLog): string {
  return log.warning.msg.pid || log.header.pid;
}

export function freezeProcessName(log: FreezeLog): string {
  return log.warning.msg.process_name || log.header.process_name || log.header.module_name;
}

/** 卡死线程 tid：默认取上报的 TID；FFRT 队列阻塞时取队列工作线程。 */
export function freezeFaultTid(log: FreezeLog): string {
  if (log.ffrtTid !== '') {
    return log.ffrtTid;
  }
  return log.warning.msg.tid || freezePid(log);
}

/** 故障发生时间，缺失时依次回落到 MSG 中的英文时间、TIMESTAMP。 */
export function freezeFaultDatetime(log: FreezeLog): Date | null {
  const msg = log.warning.msg;
  return parseTime(msg.fault_time) || parseTime(msg.msg) || parseTime(msg.timestamp);
}

/** 解析入口：日志行 -> FreezeLog。 */
export function parseFreezeLog(lines: string[]): FreezeLog {
  if (lines.length === 0) {
    throw new FaultLogError('FILE_NOT_FOUND', '文件不存在或为空');
  }
  const header = parseHeader(lines);
  const [warningLines, blockLines] = splitParts(lines);
  const warning = parsePart(warningLines);
  const block = blockLines.length > 0 ? parsePart(blockLines) : null;
  const log: FreezeLog = {
    reason: header.reason || warning.msg.event_name,
    header,
    warning,
    block,
    binder: parseBinder(lines),
    cpuProcessNames: parseCpuProcessNames(lines),
    ffrtTid: parseFfrtTid(lines),
    processNames: new Map(),
  };
  log.processNames = buildProcessNames(log);
  return log;
}
