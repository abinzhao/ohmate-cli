/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { debugLog } from './logger.js';

const POWERSHELL_PATH =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
let cachedPsAvailable: boolean | undefined;

/** 流式采样批次分隔符 */
const SAMPLE_DELIMITER = '---MEMORY-SAMPLE-DELIMITER---';

function isPowerShellAvailable(): boolean {
  if (cachedPsAvailable === undefined) {
    cachedPsAvailable = existsSync(POWERSHELL_PATH);
  }
  return cachedPsAvailable;
}

/**
 * 按 pid 读单个进程 RSS（KB 数字字符串）。macOS/Linux 用 `ps -o rss=`，Windows 用
 * `tasklist /fo csv`；失败/超时返回 null，不抛错。
 */
export function readProcessRss(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'tasklist' : 'ps';
    const args = isWin
      ? ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']
      : ['-o', 'rss=', '-p', String(pid)];
    debugLog(`Executing: ${file} ${args.join(' ')}`);
    execFile(
      file,
      args,
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(isWin ? parseWindowsRss(stdout) : parsePsRss(stdout));
      }
    );
  });
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  rssBytes: number;
}

/**
 * 一次性获取全量进程列表（PID + PPID + RSS），用于进程树 RSS 求和。
 * - Linux: 读 /proc/<pid>/status，零 spawn
 * - macOS: 单次 `ps -ax -o pid,ppid,rss`，1 次 spawn
 * - Windows: 单次 PowerShell Get-CimInstance，1 次 spawn
 */
async function getAllProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === 'linux') {
    return getLinuxProcesses();
  }
  if (process.platform === 'darwin') {
    return getMacProcesses();
  }
  if (process.platform === 'win32') {
    return getWindowsProcesses();
  }
  return [];
}

/** Linux: 直接读 /proc，零 spawn。 */
function getLinuxProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return processes;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
      const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
      if (!rssMatch || !ppidMatch) {
        continue;
      }
      processes.push({
        pid,
        ppid: Number(ppidMatch[1]),
        rssBytes: Number(rssMatch[1]) * 1024,
      });
    } catch {
      // 进程可能已退出
    }
  }
  return processes;
}

/** macOS: 单次 `ps -ax -o pid,ppid,rss`，1 次 spawn。 */
function getMacProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-ax', '-o', 'pid=,ppid=,rss='],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseMacProcessList(stdout));
      }
    );
  });
}

function parseMacProcessList(stdout: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of stdout.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    if (isNaN(pid) || isNaN(ppid) || isNaN(rssKb)) {
      continue;
    }
    processes.push({ pid, ppid, rssBytes: rssKb * 1024 });
  }
  return processes;
}

/** Windows: 单次 PowerShell Get-CimInstance，1 次 spawn。 */
function getWindowsProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    if (!isPowerShellAvailable()) {
      resolve([]);
      return;
    }
    const cmd =
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize)" }';
    execFile(
      POWERSHELL_PATH,
      ['-NoProfile', '-Command', cmd],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseWindowsProcessList(stdout));
      }
    );
  });
}

function parseWindowsProcessList(stdout: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(',');
    if (parts.length < 3) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssBytes = Number(parts[2]);
    if (isNaN(pid) || isNaN(ppid) || isNaN(rssBytes)) {
      continue;
    }
    processes.push({ pid, ppid, rssBytes });
  }
  return processes;
}

/**
 * 从全量进程列表中，按 PPID 递归求 rootPid 及所有子孙进程的 RSS 总和。
 */
export function sumTreeRssFromList(
  processes: ProcessInfo[],
  rootPid: number
): number {
  const pidToRss = new Map<number, number>();
  const childrenMap = new Map<number, number[]>();
  for (const p of processes) {
    pidToRss.set(p.pid, p.rssBytes);
    const siblings = childrenMap.get(p.ppid);
    if (siblings) {
      siblings.push(p.pid);
    } else {
      childrenMap.set(p.ppid, [p.pid]);
    }
  }

  let total = 0;
  const visited = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    total += pidToRss.get(pid) ?? 0;
    const children = childrenMap.get(pid);
    if (children) {
      queue.push(...children);
    }
  }
  return total;
}

/**
 * 递归计算进程树的总 RSS（字节）。单次调用获取全量进程列表后在代码内递归，
 * 不逐进程 spawn。Linux 零 spawn，macOS/Windows 1 次 spawn。
 */
export async function sumProcessTreeRss(rootPid: number): Promise<number> {
  const processes = await getAllProcesses();
  return sumTreeRssFromList(processes, rootPid);
}

/**
 * 启动常驻进程流式输出全量进程列表，按 intervalMs 循环。
 * macOS: `sh -c 'while true; do ps ...; echo DELIM; sleep N; done'`
 * Windows: PowerShell `while($true){ Get-CimInstance ...; Write-Output DELIM; Start-Sleep }`
 * Linux 无需调用（读 /proc 零 spawn）。
 */
function spawnProcessStream(intervalMs: number): ChildProcess | null {
  if (process.platform === 'darwin') {
    const sleepSec = (intervalMs / 1000).toFixed(1);
    const script = `while true; do ps -ax -o pid=,ppid=,rss=; echo '${SAMPLE_DELIMITER}'; sleep ${sleepSec}; done`;
    debugLog(`Executing: sh -c ${script}`);
    return spawn('sh', ['-c', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  }
  if (process.platform === 'win32' && isPowerShellAvailable()) {
    const cmd = `while ($true) { Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize)" }; Write-Output '${SAMPLE_DELIMITER}'; Start-Sleep -Milliseconds ${intervalMs} }`;
    debugLog(`Executing: ${POWERSHELL_PATH} -NoProfile -Command ${cmd}`);
    return spawn(POWERSHELL_PATH, ['-NoProfile', '-Command', cmd], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  }
  return null;
}

/** 字节数格式化为 MB 字符串（保留两位），如 `123.45MB`。 */
export function formatBytesMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 采样一次 RSS(字节):有 pid 时读目标进程(可选进程树),否则读当前 Node 进程。
 */
async function sampleProcessRss(
  pid: number | undefined,
  trackTree: boolean
): Promise<number> {
  if (!pid) {
    return process.memoryUsage().rss;
  }
  if (trackTree) {
    return sumProcessTreeRss(pid);
  }
  const rssKb = await readProcessRss(pid);
  return rssKb ? Number(rssKb) * 1024 : 0;
}

/**
 * 启动内存采样器，追踪指定进程（或进程树）的 RSS 峰值。
 * - 无 pid：采样当前 Node.js 进程，setInterval + process.memoryUsage()
 * - Linux：读 /proc 零 spawn，setInterval
 * - macOS/Windows：单次常驻 spawn 流式输出，stdout 按分隔符切批次解析
 * @param pid 目标进程 PID；省略则采样当前 Node.js 进程
 * @param intervalMs 采样间隔（ms），默认 500
 * @param trackTree 如果为 true，则采样进程树（根进程 + 所有子孙进程）的总 RSS
 * @returns 包含 `stop()` 方法，调用后返回最终峰值字节数
 */
export function startMemoryTracker(
  pid?: number,
  intervalMs = 2000,
  trackTree = false
): { stop: () => Promise<number> } {
  let peakBytes = 0;
  let isStopping = false;

  const updatePeak = (processes: ProcessInfo[]): void => {
    if (isStopping || !pid) {
      return;
    }
    const bytes = trackTree
      ? sumTreeRssFromList(processes, pid)
      : (processes.find((p) => p.pid === pid)?.rssBytes ?? 0);
    if (bytes > peakBytes) {
      peakBytes = bytes;
    }
  };

  // 无 pid：采样当前 Node.js 进程
  if (!pid) {
    return trackSelfProcess(intervalMs);
  }

  // Linux：零 spawn，直接读 /proc
  if (process.platform === 'linux') {
    return trackLinuxProcess(intervalMs, updatePeak, () => peakBytes);
  }

  // macOS / Windows：单次常驻 spawn 流式输出
  const child = spawnProcessStream(intervalMs);
  if (!child) {
    return {
      stop: async () => {
        isStopping = true;
        const finalBytes = await sampleProcessRss(pid, trackTree);
        return Math.max(peakBytes, finalBytes);
      },
    };
  }

  attachStreamParser(child, updatePeak);
  return {
    stop: async () => {
      isStopping = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      const finalBytes = await sampleProcessRss(pid, trackTree);
      return Math.max(peakBytes, finalBytes);
    },
  };
}

/** 将常驻 spawn 的 stdout 流按分隔符切批次，解析后更新峰值。 */
function attachStreamParser(
  child: ChildProcess,
  updatePeak: (processes: ProcessInfo[]) => void
): void {
  const parseList =
    process.platform === 'darwin'
      ? parseMacProcessList
      : parseWindowsProcessList;
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split(SAMPLE_DELIMITER);
    buffer = parts.pop() ?? '';
    for (const batch of parts) {
      updatePeak(parseList(batch));
    }
  });
  child.on('error', () => {});
}

/** 采样当前 Node.js 进程 RSS 峰值。 */
function trackSelfProcess(intervalMs: number): { stop: () => Promise<number> } {
  let peak = process.memoryUsage().rss;
  const interval = setInterval(() => {
    const bytes = process.memoryUsage().rss;
    if (bytes > peak) {
      peak = bytes;
    }
  }, intervalMs);
  return {
    stop: async () => {
      clearInterval(interval);
      return Math.max(peak, process.memoryUsage().rss);
    },
  };
}

/** Linux：读 /proc 零 spawn 采样，峰值通过 updatePeak 写入外层闭包。 */
function trackLinuxProcess(
  intervalMs: number,
  updatePeak: (processes: ProcessInfo[]) => void,
  getPeak: () => number
): { stop: () => Promise<number> } {
  updatePeak(getLinuxProcesses());
  const interval = setInterval(
    () => updatePeak(getLinuxProcesses()),
    intervalMs
  );
  return {
    stop: async () => {
      clearInterval(interval);
      updatePeak(getLinuxProcesses());
      return getPeak();
    },
  };
}

function parsePsRss(stdout: string): string | null {
  const m = stdout.trim().match(/^(\d+)$/);
  return m ? m[1] : null;
}

function parseWindowsRss(stdout: string): string | null {
  // tasklist /fo csv /nh: "name","pid","session","session#","N,NNN K"
  const m = stdout.match(/"([^"]+?)\s*K"/i);
  if (!m) {
    return null;
  }
  const digits = m[1].replace(/\D/g, '');
  return digits || null;
}
