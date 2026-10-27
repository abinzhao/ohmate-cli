/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDataLock } from '../runtime/execution-lock.js';
import { processIdentity, stopProcessTree } from '../runtime/process-tree.js';
import { readWebService, type WebServiceRecord } from './web-state.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';
import { readDebugSession } from '../debug/debug-state.js';
import { workbenchFingerprint } from './workbench-fingerprint.js';

async function control(record: WebServiceRecord, verb: string) {
  const response = await fetch(`${record.origin}/_ohmate/${verb}`, {
    method: 'POST', headers: { 'x-ohmate-control': record.controlSecret }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) { throw new Error('Local service control was rejected'); }
  return response.json();
}
function readiness(child: ChildProcess, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const complete = (error?: Error) => {
      clearTimeout(timer); child.off('message', ready); child.off('exit', exited); child.off('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) { reject(error); } else { resolve(); }
    };
    const ready = (message: unknown) => { if ((message as { ready?: boolean })?.ready) { complete(); } };
    const failed = (error: Error) => complete(error);
    const exited = () => complete(new Error('Web worker exited before readiness'));
    const aborted = () => complete(new Error('Web startup cancelled'));
    const timer = setTimeout(() => complete(new Error('Web startup timed out')), 10_000);
    child.on('message', ready); child.once('exit', exited); child.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); }
  });
}
async function launch(context: ExecutionContext, port: number, fingerprint: string, devAutoPair: boolean): Promise<WebServiceRecord> {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = here.endsWith('/web') || here.endsWith('\\web'), entry = join(here, source ? 'web-worker.ts' : 'web-worker.js');
  const config = { dataDir: context.dataDir, cwd: context.cwd, projectRoot: context.projectRoot, locale: context.locale, port,
    workbenchFingerprint: fingerprint, devAutoPair };
  const child = spawn(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), entry, '--configuration', JSON.stringify(config)], {
    cwd: context.cwd, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, OHMATE_DATA_DIR: context.dataDir, DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all' },
  });
  try {
    await readiness(child, context.abortSignal);
    const record = await readWebService(context.dataDir);
    if (!record || record.pid !== child.pid || record.workbenchFingerprint !== fingerprint) { throw new Error('Web worker identity mismatch'); }
    child.unref();
    return record;
  } catch (error) {
    stopProcessTree(child, true);
    if (child.connected) { child.disconnect(); }
    throw error;
  }
}
async function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { shell: false, stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => { child.once('error', () => resolve(false)); child.once('exit', (code) => resolve(code === 0)); });
}
export async function openWorkbench(context: ExecutionContext, input: { port: number; open: boolean; devAutoPair?: boolean }): Promise<ToolResult> {
  const release = await acquireDataLock(context.dataDir, 'web-lifecycle');
  try {
    let record = await readWebService(context.dataDir);
    if (record && (record.cwd !== context.cwd || record.projectRoot !== context.projectRoot)) {
      return { exitCode: 5, data: { code: 'WORKBENCH_SCOPE_CHANGED', message: 'Stop the existing workbench before changing its startup root' } };
    }
    const fingerprint = await workbenchFingerprint();
    if (record && record.workbenchFingerprint !== fingerprint) { return { exitCode: 5, data: { code: 'WORKBENCH_CODE_CHANGED' } }; }
    if (!record) { record = await launch(context, input.port, fingerprint, input.devAutoPair === true); }
    const { ticket } = await control(record, 'ticket');
    const url = `${record.origin}/#access=${ticket}`;
    const opened = input.open ? await openBrowser(url) : false;
    const debugSession = record.debugSessionId ? await readDebugSession(context.dataDir, record.debugSessionId) : null;
    return { exitCode: 0, data: { state: 'running', url, origin: record.origin, pid: record.pid, identity: record.identity,
      devAutoPair: input.devAutoPair === true, debugSession,
      browser: input.open ? opened ? 'opened' : 'unavailable' : 'not-requested' } };
  } finally { await release(); }
}
export async function workbenchStatus(context: ExecutionContext): Promise<ToolResult> {
  const record = await readWebService(context.dataDir);
  return { exitCode: 0, data: record ? { state: 'running', origin: record.origin, pid: record.pid,
    projectRoot: record.projectRoot, startedAt: record.startedAt, devices: 'not-probed',
    debugSession: record.debugSessionId ? await readDebugSession(context.dataDir, record.debugSessionId) : null } : { state: 'stopped' } };
}
export async function stopWorkbench(context: ExecutionContext): Promise<ToolResult> {
  const release = await acquireDataLock(context.dataDir, 'web-lifecycle');
  try {
    const record = await readWebService(context.dataDir);
    if (!record) { return { exitCode: 0, data: { state: 'stopped' } }; }
    await control(record, 'stop');
    const deadline = Date.now() + 5000;
    while (await processIdentity(record.pid) === record.identity) {
      if (Date.now() >= deadline) { return { exitCode: 6, data: { code: 'WEB_STOP_TIMEOUT' } }; }
      await delay(25);
    }
    return { exitCode: 0, data: { state: 'stopped', pid: record.pid } };
  } finally { await release(); }
}
