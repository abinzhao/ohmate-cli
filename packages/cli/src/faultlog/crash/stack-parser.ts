/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
/**
 * 线程堆栈解析（freeze/stack.py 的移植，cppcrash 线程区段复用同一套解析）：
 * 'Tid:xxx, Name:yyy' + 栈帧文本 -> 结构化对象。
 */
/** 'Tid:20020, Name:com.example.app'（容忍行首空白，覆盖 cppcrash 变体）。 */
export const THREAD_HEADER_RE = /^\s*Tid:(\d+)(?:,|\s)+Name:(.*)/;
/** native 帧：'#02 pc 0000000000123456 /system/lib64/libipc_common.z.so(Func+100)(buildid)'。 */
const NATIVE_FRAME_RE = /^#\d+ [\w\s]+ .*/;
/** js/ets 帧：'at funcName (entry/src/main/ets/pages/Index.ets:42:8)'。 */
const JS_FRAME_RE = /at\s+(\w+)\s+\((.*\.\w+):\d+:\d+\)/;

/** 抓栈失败时 faultlog 中的报错关键字及其含义。 */
const STACK_ERROR_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/has been crashed/, '目标进程Crash：抓栈时进程已收到crash，请参考附近时间点的Crash日志'],
  [/SIGDUMP error/, '目标进程在dump堆栈前就已经退出'],
  [/is dumping/, '目标进程正在dump，短时间内连续请求，请参考附近时间点该进程的其他报错日志'],
  [/State:\tS \(sleeping\)/, 'dump堆栈时进程正在睡眠'],
  [/errno\(2\)/, '目标进程无响应信号，超时后已经退出'],
  [/pid\(\d+\) process has exited/, 'dump堆栈失败，进程已经退出'],
  [/Failed to dump normal stacktrace/, '正常抓栈失败'],
];

export interface StackFrame {
  /** 原始帧文本。 */
  raw: string;
  /** 去掉编号/pc 地址/buildid 后的简化帧。 */
  brief: string;
  isNative: boolean;
  /** system / app / other，用于过滤系统帧。 */
  area: 'system' | 'app' | 'other';
}

export interface ThreadStack {
  tid: string;
  name: string;
  frames: StackFrame[];
}

function buildNative(frame: StackFrame, parts: string[]): void {
  // 去掉 '#NN pc xxxxxxxx' 前缀和 '(buildid)' 后缀（buildid 可能多处出现，全部去除）
  let brief = frame.raw.replace(/^#\d+ pc \w+/, '');
  brief = brief.replace(/\([\da-fA-F]{16,}\)/g, '').trim();
  frame.brief = brief;
  const location = parts[3] ?? '';
  if (parts.length > 3 && (location.startsWith('/system') || location.startsWith('/vendor') || location.startsWith('/prod'))) {
    frame.area = 'system';
  } else if (frame.raw.includes('libarkweb_engine.so') || frame.raw.includes('[shmm]')) {
    frame.area = 'system';
  } else if (parts.length > 3 && location.startsWith('/data')) {
    frame.area = 'app';
  }
}

function buildJs(frame: StackFrame): void {
  // js 帧保留 文件:行:列，便于业务直接定位代码位置
  frame.brief = frame.raw.replace(/^#\d+/, '').trim();
  frame.area = frame.raw.includes('/foundation/arkui') ? 'system' : 'app';
}

export function buildFrame(line: string): StackFrame {
  const parts = line.trim().split(/\s+/);
  const frame: StackFrame = {
    raw: line,
    brief: '',
    isNative: parts.length > 1 && parts[1] === 'pc',
    area: 'other',
  };
  if (frame.isNative) {
    buildNative(frame, parts);
  } else {
    buildJs(frame);
  }
  return frame;
}

/** 从若干行文本中解析出所有栈帧（native + js）。 */
export function parseFrames(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of lines) {
    if (NATIVE_FRAME_RE.test(line) || JS_FRAME_RE.test(line)) {
      frames.push(buildFrame(line));
    }
  }
  return frames;
}

/** 把一段堆栈文本按 'Tid:xxx, Name:yyy' 拆分为 {tid: ThreadStack}（重复 tid 后者覆盖）。 */
export function parseThreadStacks(lines: string[]): Map<string, ThreadStack> {
  const stacks = new Map<string, ThreadStack>();
  let current: ThreadStack | null = null;
  for (const line of lines) {
    const headerMatch = THREAD_HEADER_RE.exec(line);
    if (headerMatch !== null) {
      current = { tid: headerMatch[1], name: headerMatch[2].trim(), frames: [] };
      stacks.set(current.tid, current);
      continue;
    }
    if (current !== null && (NATIVE_FRAME_RE.test(line) || JS_FRAME_RE.test(line))) {
      current.frames.push(buildFrame(line));
    }
  }
  return stacks;
}

/** 命中抓栈失败报错关键字时返回带含义说明的行文本（去重），未命中返回 null。 */
function matchStackErrorHint(line: string, seen: Set<string>): string | null {
  for (const [pattern, hint] of STACK_ERROR_HINTS) {
    if (pattern.test(line)) {
      const text = line.trim();
      if (!seen.has(text)) {
        seen.add(text);
        return `${text} （${hint}）`;
      }
    }
  }
  return null;
}

/** 提取抓栈失败的报错行及其含义说明（去重）。 */
export function extractStackErrors(lines: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const error = matchStackErrorHint(line, seen);
    if (error !== null) {
      errors.push(error);
    }
  }
  return errors;
}
