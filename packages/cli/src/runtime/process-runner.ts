/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { processIdentity, stopProcessTree, usesProcessGroups } from './process-tree.js';
import type { ExecutionContext, ToolResult } from './types.js';

export interface ProcessOutput {
  executable: string; argv: string[]; cwd: string;
  startedAt: string; finishedAt: string;
  stdout: string; stderr: string; toolExitCode: number | null;
  signal: string | null; truncated: boolean;
  outputHashes?: { stdout: string; stderr: string; encoding: 'utf8'; complete: boolean };
}
export interface ProcessRequest {
  executable: string; argv: string[]; env: NodeJS.ProcessEnv;
  protocol?: boolean;
}
const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Internal adapter API; never register unrestricted executable/argv as an Agent tool. */
export async function executeToolProcess(request: ProcessRequest, context: ExecutionContext): Promise<ToolResult> {
  const cwd = context.projectRoot ?? context.cwd, startedAt = new Date().toISOString();
  if (context.abortSignal.aborted) {
    return { exitCode: 130, data: { ...request, env: undefined, cwd, startedAt, finishedAt: startedAt,
      stdout: '', stderr: '', toolExitCode: null, signal: 'cancelled-before-start', truncated: false } };
  }
  const child = spawn(request.executable, request.argv, {
    shell: false, cwd, env: request.env, detached: usesProcessGroups(), windowsHide: true,
    stdio: [request.protocol && context.protocolStdin ? 'inherit' : 'ignore', 'pipe', 'pipe'],
  });
  const completion = collect(child, context, Boolean(request.protocol));
  const identity = child.pid && context.taskId ? await processIdentity(child.pid) : null;
  const record = identity ? { pid: child.pid!, identity, group: true, attempt: randomUUID() } : null;
  try {
    if (record) { await event(context, 'process.started', record); }
    const result = await completion;
    const output = result.data as ProcessOutput, hash = (text: string) => createHash('sha256').update(text).digest('hex');
    return { ...result, data: { ...output, executable: request.executable, argv: request.argv,
      cwd, startedAt, finishedAt: new Date().toISOString(), outputHashes: {
        stdout: hash(output.stdout), stderr: hash(output.stderr), encoding: 'utf8', complete: !output.truncated && !request.protocol,
      } } };
  } catch (error) {
    stopProcessTree(child, true);
    await completion;
    throw error;
  } finally {
    if (record) { await event(context, 'process.closed', record); }
  }
}
async function event(context: ExecutionContext, type: string, payload: unknown) {
  await context.eventSink({ taskId: context.taskId!, sequence: 0, type, time: new Date().toISOString(), payload });
}

function collect(child: ChildProcess, context: ExecutionContext, protocol: boolean): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', bytes = 0, overflow = false;
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      stopProcessTree(child, false);
      killTimer ??= setTimeout(() => stopProcessTree(child, true), 1500);
      killTimer.unref();
    };
    const force = () => stopProcessTree(child, true);
    context.abortSignal.addEventListener('abort', abort, { once: true });
    context.forceSignal?.addEventListener('abort', force, { once: true });
    const receive = (text: string, channel: 'stdout' | 'stderr') => {
      bytes += Buffer.byteLength(text);
      if (!protocol && bytes > OUTPUT_LIMIT) { overflow = true; abort(); return; }
      context[channel]?.(text);
      if (!protocol) {
        if (channel === 'stdout') { stdout += text; } else { stderr += text; }
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (text: string) => receive(text, 'stdout'));
    child.stderr?.setEncoding('utf8').on('data', (text: string) => receive(text, 'stderr'));
    child.once('error', (error) => { stderr += error.message; });
    child.once('close', (code, signal) => {
      context.abortSignal.removeEventListener('abort', abort);
      context.forceSignal?.removeEventListener('abort', force);
      if (context.abortSignal.aborted || context.forceSignal?.aborted || overflow) { stopProcessTree(child, true); }
      clearTimeout(killTimer);
      const exitCode = context.abortSignal.aborted ? 130 : overflow ? 6 : code === 0 ? 0 : code === 2 ? 2 : 6;
      resolve({ exitCode, data: { stdout, stderr, toolExitCode: code, signal, truncated: overflow } });
    });
    if (context.abortSignal.aborted) { abort(); }
    if (context.forceSignal?.aborted) { force(); }
  });
}
