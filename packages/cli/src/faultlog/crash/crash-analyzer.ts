/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * 故障日志分析入口：identify 判定 -> 按族解析 -> 输出 CrashAnalysisResult。
 *
 * 三族日志共用同一输出契约（basic-info + threads + binders + 专项区段），
 * 报告渲染 renderCrashReport 与 JSON 的 key-report 同源。
 */
import type {
  CrashAnalysisResult,
  CrashCandidateInfo,
  CrashKeyReport,
  CrashSourceInfo,
  FaultLogFamily,
  FaultLogVerdict,
  KeyReportBinderEdge,
  KeyReportThread,
} from '../types.js';
import { isFaultLogFamily } from '../types.js';
import { identifyFaultLogContent, identifyFaultLogFile } from '../identify/identify-faultlog.js';
import { FaultLogError } from '../faultlog-error.js';
import { fmtTime, readFileLines, splitLogLines } from './log-text.js';
import {
  freezeFaultDatetime,
  freezeFaultTid,
  freezePid,
  freezeProcessName,
  parseFreezeLog,
  type FreezeLog,
} from './freeze-parser.js';
import { buildPropagation, dstNode, nodeLabel, srcNode, type BinderTrans } from './binder-chain.js';
import { parseCppCrashLog, type CppCrashLog } from './cppcrash-parser.js';
import { parseJsErrorLog, type JsErrorLog } from './jserror-parser.js';
import { extractHilogText } from './hilog-section.js';
import { collectFaultLogs } from './faultlog-collector.js';
import { buildFrame } from './stack-parser.js';

/** 分析输入：本地文件路径或文本内容（二选一）。 */
export interface CrashLogInput {
  path?: string;
  content?: string;
}

function requireFamily(verdict: FaultLogVerdict): FaultLogFamily {
  if (!isFaultLogFamily(verdict.type)) {
    const extra =
      verdict.out_of_scope !== undefined ? `（${verdict.out_of_scope.detail}）` : '';
    throw new FaultLogError(
      'UNRECOGNIZED_LOG',
      `无法解析该日志：识别为 ${verdict.type}，仅支持 cpp_crash / js_error / app_freeze${extra}`,
      verdict
    );
  }
  return verdict.type;
}

/** 分析单个故障日志（文件或内容）。 */
export function analyzeCrashLog(input: CrashLogInput): CrashAnalysisResult {
  if (input.path !== undefined) {
    const verdict = identifyFaultLogFile(input.path);
    const family = requireFamily(verdict);
    const lines = readFileLines(input.path);
    return buildResult(family, verdict, lines, { kind: 'file', path: input.path });
  }
  if (input.content !== undefined) {
    const verdict = identifyFaultLogContent(input.content);
    const family = requireFamily(verdict);
    const lines = splitLogLines(input.content);
    return buildResult(family, verdict, lines, { kind: 'file', path: verdict.filename_hint });
  }
  throw new FaultLogError('INVALID_INPUT', '必须提供日志文件路径或日志内容');
}

/** 分析目录：收集候选 -> 取排序最优的一个；全部候选随结果返回。 */
export function analyzeFaultLogDirectory(dirPath: string): CrashAnalysisResult {
  const { candidates, typeCounts } = collectFaultLogs(dirPath);
  if (candidates.length === 0) {
    const distribution = Object.entries(typeCounts)
      .map(([type, count]) => `${type}=${count}`)
      .join(', ');
    throw new FaultLogError(
      'UNRECOGNIZED_LOG',
      `未在 ${dirPath} 中找到可分析的故障日志（支持 cpp_crash / js_error / app_freeze）` +
        (distribution !== '' ? `；扫描文件判定分布：${distribution}` : '')
    );
  }
  const best = candidates[0];
  const result = analyzeCrashLog({ path: best.path });
  const candidateInfos: CrashCandidateInfo[] = candidates.map((candidate) => ({
    path: candidate.path,
    type: candidate.type,
    confidence: candidate.confidence,
    completeness: candidate.completeness,
  }));
  const source: CrashSourceInfo = {
    kind: 'directory',
    path: dirPath,
    candidates: candidateInfos,
  };
  result.source = source;
  return result;
}

/** 提取故障日志中的 HiLog 流水区段（--format hilog 用）。 */
export function extractCrashHilog(input: CrashLogInput): string {
  if (input.path !== undefined) {
    const text = extractHilogText(readFileLines(input.path));
    if (text === '') {
      throw new FaultLogError('INVALID_INPUT', '日志中未找到 HiLog 区段');
    }
    return text;
  }
  if (input.content !== undefined) {
    const text = extractHilogText(splitLogLines(input.content));
    if (text === '') {
      throw new FaultLogError('INVALID_INPUT', '日志中未找到 HiLog 区段');
    }
    return text;
  }
  throw new FaultLogError('INVALID_INPUT', '必须提供日志文件路径或日志内容');
}

function buildResult(
  family: FaultLogFamily,
  verdict: FaultLogVerdict,
  lines: string[],
  source: CrashSourceInfo
): CrashAnalysisResult {
  let keyReport: CrashKeyReport;
  if (family === 'app_freeze') {
    keyReport = buildFreezeKeyReport(parseFreezeLog(lines));
  } else if (family === 'cpp_crash') {
    keyReport = buildCppKeyReport(parseCppCrashLog(lines));
  } else {
    keyReport = buildJsKeyReport(parseJsErrorLog(lines));
  }
  return {
    schemaVersion: '1.0.0',
    logType: family,
    ...(verdict.subtype !== undefined ? { subtype: verdict.subtype } : {}),
    source,
    identify: verdict,
    'key-report': keyReport,
  };
}

// ------------------------------------------------------------ key report 构建

function toBinderEdge(
  edge: BinderTrans,
  processNames: Map<string, string>,
  threadNames: Map<string, string>
): KeyReportBinderEdge {
  const frzState = edge.frzState !== '' ? { 'frz-state': edge.frzState } : {};
  return {
    from: nodeLabel(srcNode(edge), processNames, threadNames),
    to: nodeLabel(dstNode(edge), processNames, threadNames),
    relation: '同步等待',
    'wait-seconds': edge.waitSeconds,
    code: edge.code,
    ...frzState,
  };
}

/** {(pid,tid): 线程名}：warning + block 两次抓栈的线程名。 */
function freezeThreadNames(log: FreezeLog, pid: string): Map<string, string> {
  const names = new Map<string, string>();
  const parts = log.block !== null ? [log.warning, log.block] : [log.warning];
  for (const part of parts) {
    for (const [tid, stack] of part.stacks) {
      if (stack.name !== '') {
        names.set(`${pid}:${tid}`, stack.name);
      }
    }
  }
  return names;
}

function freezeThread(
  role: 'fault' | 'fault-secondary',
  tid: string,
  stack: { tid: string; name: string; frames: Array<{ raw: string }> } | null,
  stackErrors: string[]
): KeyReportThread {
  const frames = stack !== null ? stack.frames.map((frame) => frame.raw) : [];
  const thread: KeyReportThread = {
    role,
    tid,
    name: stack !== null ? stack.name : '',
    frames,
  };
  if (frames.length === 0) {
    thread.note =
      stackErrors.length > 0 ? stackErrors.join('；') : '未抓到该线程堆栈';
  }
  return thread;
}

function buildFreezeKeyReport(log: FreezeLog): CrashKeyReport {
  const pid = freezePid(log);
  const processName = freezeProcessName(log);
  const faultTid = freezeFaultTid(log);
  const faultDatetime = freezeFaultDatetime(log);

  const basicInfo: Record<string, string> = {
    故障时间:
      faultDatetime !== null
        ? fmtTime(faultDatetime)
        : log.warning.msg.fault_time || log.warning.msg.timestamp,
    PID: pid,
    进程名: processName,
    故障类型: 'appfreeze',
    ...(log.reason !== '' ? { 故障原因: log.reason } : {}),
  };

  const threads: KeyReportThread[] = [
    freezeThread('fault', faultTid, log.warning.stacks.get(faultTid) ?? null, log.warning.stack_errors),
  ];
  if (log.block !== null) {
    threads.push(
      freezeThread('fault-secondary', faultTid, log.block.stacks.get(faultTid) ?? null, log.block.stack_errors)
    );
  }

  const propagation = buildPropagation(log.binder, pid, faultTid);
  const threadNames = freezeThreadNames(log, pid);
  const keyReport: CrashKeyReport = {
    'basic-info': basicInfo,
    threads,
    binders:
      propagation.chain !== null
        ? propagation.chain.edges.map((edge) => toBinderEdge(edge, log.processNames, threadNames))
        : [],
  };
  if (propagation.notes.length > 0) {
    keyReport['binder-notes'] = propagation.notes;
  }
  if (propagation.chain !== null && propagation.chain.cycles.length > 0) {
    keyReport.cycles = propagation.chain.cycles.map((cycle) => {
      const labels = cycle.map((node) => nodeLabel(node, log.processNames, threadNames));
      return `${labels.join(' -> ')} -> ${labels[0]}`;
    });
  }
  return keyReport;
}

function buildCppKeyReport(crash: CppCrashLog): CrashKeyReport {
  const basicInfo: Record<string, string> = {
    故障时间: crash.header.timestamp,
    PID: crash.header.pid,
    进程名: crash.header.process_name || crash.header.module_name,
    故障类型: 'cppcrash',
    ...(crash.header.reason !== '' ? { 故障原因: crash.header.reason } : {}),
    ...(crash.header.last_fatal_message !== ''
      ? { LastFatalMessage: crash.header.last_fatal_message }
      : {}),
  };
  const fault = crash.faultStack;
  const keyReport: CrashKeyReport = {
    'basic-info': basicInfo,
    threads: [
      {
        role: 'fault',
        tid: fault !== null ? fault.tid : '',
        name: fault !== null ? fault.name : '',
        frames: fault !== null ? fault.frames.map((frame) => frame.raw) : [],
        ...(fault === null || fault.frames.length === 0
          ? { note: '未解析到崩溃线程堆栈' }
          : {}),
      },
    ],
    binders: [],
  };
  if (crash.gwpAsanText !== '') {
    keyReport['gwp-asan'] = crash.gwpAsanText;
  }
  return keyReport;
}

function buildJsKeyReport(log: JsErrorLog): CrashKeyReport {
  const basicInfo: Record<string, string> = {
    故障时间: log.header.fault_time || log.header.timestamp,
    PID: log.header.pid,
    进程名: log.header.process_name || log.header.package_name || log.header.module_name,
    故障类型: 'jserror',
    ...(log.header.reason !== '' || log.header.error_name !== ''
      ? { 故障原因: log.header.reason || log.header.error_name }
      : {}),
    ...(log.header.error_message !== '' ? { 错误信息: log.header.error_message } : {}),
  };
  return {
    'basic-info': basicInfo,
    threads: [
      {
        role: 'fault',
        tid: log.faultTid,
        name: log.faultThreadName,
        frames: log.frames,
        ...(log.frames.length === 0 ? { note: '未解析到 Stacktrace 帧' } : {}),
      },
    ],
    binders: [],
  };
}

// ------------------------------------------------------------ 报告渲染

/**
 * 渲染文本报告（--format report）：
 * 基本信息 / 故障线程堆栈 / binder 传播链 / GWP-ASan 原始报告。
 */
export function renderCrashReport(result: CrashAnalysisResult): string {
  const report = result['key-report'];
  const lines: string[] = ['='.repeat(60)];
  lines.push('【基本信息】');
  lines.push(...renderBasicInfo(report['basic-info']));
  for (const thread of report.threads) {
    lines.push(
      ...renderThreadLines(
        thread.role === 'fault' ? '故障线程堆栈' : '故障线程堆栈（二次抓栈）',
        thread
      )
    );
  }
  lines.push(...renderBinderLines(report));
  if (report['gwp-asan'] !== undefined && report['gwp-asan'] !== '') {
    lines.push('【GWP-ASan 原始报告】');
    lines.push(report['gwp-asan']);
  }
  return lines.join('\n');
}

function renderBasicInfo(basic: Record<string, string>): string[] {
  const lines: string[] = [];
  const processName = basic['进程名'] ?? '';
  for (const [key, value] of Object.entries(basic)) {
    if (key === '进程名') {
      continue;
    }
    if (key === 'PID') {
      if (value !== '' && processName !== '') {
        lines.push(`PID：${value}  进程名：${processName}`);
      } else if (value !== '') {
        lines.push(`PID：${value}`);
      } else if (processName !== '') {
        lines.push(`进程名：${processName}`);
      }
      continue;
    }
    if (value !== '') {
      lines.push(`${key}：${value}`);
    }
  }
  return lines;
}

function renderThreadLines(title: string, thread: KeyReportThread): string[] {
  const lines: string[] = [`【${title}】`];
  if (thread.tid !== '' || thread.name !== '') {
    lines.push(`Tid:${thread.tid}, Name:${thread.name}`);
  }
  thread.frames.forEach((raw, index) => {
    if (/^\s*#\d+/.test(raw)) {
      lines.push(`#${String(index).padStart(2, '0')} ${buildFrame(raw).brief}`);
    } else {
      lines.push(raw.trim());
    }
  });
  if (thread.frames.length === 0 && thread.note === undefined) {
    lines.push('未获取到该线程堆栈');
  }
  if (thread.note !== undefined) {
    lines.push(`说明：${thread.note}`);
  }
  return lines;
}

function renderBinderLines(report: CrashKeyReport): string[] {
  const notes = report['binder-notes'] ?? [];
  if (report.binders.length === 0 && notes.length === 0) {
    return [];
  }
  const lines: string[] = ['【binder 传播链】'];
  if (report.binders.length > 0) {
    lines.push('传播链调用边（按等待时长降序）：');
    for (const edge of report.binders) {
      const frz =
        edge['frz-state'] !== undefined ? ` frz_state:${edge['frz-state']}` : '';
      lines.push(
        `  ${edge.from} -> ${edge.to} ${edge.relation} ${edge['wait-seconds'].toFixed(2)}s${frz}`
      );
    }
  }
  for (const cycle of report.cycles ?? []) {
    lines.push(`⚠ 检测到binder死锁环：${cycle}`);
  }
  for (const note of notes) {
    lines.push(`提示：${note}`);
  }
  return lines;
}
