/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { debugLog } from '../utils/logger.js';

const executeFile = promisify(execFile);

export function usesProcessGroups(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function processIdentityProbe(platform: NodeJS.Platform, pid: number):
  { kind: 'proc'; path: string } |
  { kind: 'exec'; executable: string; args: string[]; windowsHide: boolean } {
  if (platform === 'linux') { return { kind: 'proc', path: `/proc/${pid}/stat` }; }
  if (platform === 'win32') {
    return {
      kind: 'exec',
      executable: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
      windowsHide: true,
    };
  }
  return {
    kind: 'exec',
    executable: 'ps',
    args: ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'comm='],
    windowsHide: false,
  };
}

export function processStopPlan(platform: NodeJS.Platform, pid: number, force: boolean, group: boolean):
  { kind: 'taskkill'; executable: 'taskkill'; args: string[] } |
  { kind: 'signal'; pid: number; signal: NodeJS.Signals } {
  if (platform === 'win32') {
    return { kind: 'taskkill', executable: 'taskkill',
      args: ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])] };
  }
  return {
    kind: 'signal',
    pid: group ? -pid : pid,
    signal: force ? 'SIGKILL' : 'SIGTERM',
  };
}

export async function processIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return null; }
  try {
    process.kill(pid, 0);
    const probe = processIdentityProbe(process.platform, pid);
    if (probe.kind === 'proc') {
      const stat = await readFile(probe.path, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[0] === 'Z' ? null : createHash('sha256').update(fields[19]).digest('hex');
    }
    debugLog(`Executing: ${probe.executable} ${probe.args.join(' ')}`);
    const { stdout } = await executeFile(probe.executable, probe.args,
      { timeout: 5000, windowsHide: probe.windowsHide });
    if (process.platform === 'win32') {
      return createHash('sha256').update(stdout.trim()).digest('hex');
    }
    const line = stdout.trim(), identity = line.replace(/^\S+\s+/, '');
    return line && !line.startsWith('Z') ? createHash('sha256').update(identity).digest('hex') : null;
  } catch { return null; }
}

export function stopProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, force: boolean, group = true): void {
  if (!child.pid) { return; }
  const plan = processStopPlan(process.platform, child.pid, force, group);
  if (plan.kind === 'taskkill') {
    debugLog(`Executing: ${plan.executable} ${plan.args.join(' ')}`);
    spawn(plan.executable, plan.args, { shell: false, stdio: 'ignore', windowsHide: true })
      .once('error', () => child.kill(force ? 'SIGKILL' : 'SIGTERM'));
    return;
  }
  try { process.kill(plan.pid, plan.signal); }
  catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
}

export async function stopRecordedProcess(record: { pid: number; identity: string; group: boolean }, force: boolean): Promise<boolean> {
  if (record.pid === process.pid || await processIdentity(record.pid) !== record.identity) { return false; }
  stopProcessTree({ pid: record.pid, kill: (signal) => {
    try { process.kill(record.pid, signal ?? 'SIGTERM'); return true; } catch { return false; }
  } }, force, record.group);
  return true;
}
