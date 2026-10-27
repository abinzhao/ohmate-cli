/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog } from '../utils/logger.js';
import type { ProgressHandler } from './types.js';

type PendingHandler = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

function resolveUiVerificationBin(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(
      directory,
      'node_modules',
      'ui-verification-mcp',
      'bin',
      'ui-verification-mcp.cjs'
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error(
    'ui-verification-mcp is not installed. Run `npm install` and try again.'
  );
}

export class UiVerificationMcpSession {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingHandler>();
  private progressHandlers = new Map<string | number, ProgressHandler>();
  private closedError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly stopped: Promise<void>;
  private abortCleanup: (() => void) | undefined;

  private constructor(private readonly child: ChildProcess) {
    this.stopped = new Promise((resolve) =>
      child.once('close', () => resolve())
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          this.handleMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Ignore malformed or non-protocol output from the child.
        }
      }
    });

    const rejectPending = (error: Error): void => {
      this.closedError ??= error;
      for (const handler of this.pending.values()) {
        handler.reject(error);
      }
      this.pending.clear();
      this.progressHandlers.clear();
    };

    child.on('error', rejectPending);
    child.on('exit', (code, signal) => {
      const reason =
        code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
      rejectPending(new Error(`ui-verification-mcp exited with ${reason}`));
    });
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (!('id' in message)) {
      if (message.method !== 'notifications/progress') {
        return;
      }
      const params = message.params as {
        progressToken?: string | number;
        progress?: number;
        total?: number;
        message?: string;
      };
      if (
        params?.progressToken === undefined ||
        params.progress === undefined
      ) {
        return;
      }
      this.progressHandlers.get(params.progressToken)?.(
        params.progress,
        params.total,
        params.message
      );
      return;
    }

    const id = message.id;
    if (typeof id !== 'number') {
      return;
    }
    const handler = this.pending.get(id);
    if (!handler) {
      return;
    }
    this.pending.delete(id);
    handler.resolve(message);
  }

  private sendAndWait(
    id: number,
    message: Record<string, unknown>,
    timeoutMs?: number,
    timeoutMessage = 'MCP request timed out'
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.closedError) {
        reject(this.closedError);
        return;
      }
      this.registerPending(id, resolve, reject, timeoutMs, timeoutMessage);
      try {
        this.child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        const handler = this.pending.get(id);
        this.pending.delete(id);
        handler?.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  private registerPending(
    id: number,
    resolve: (message: Record<string, unknown>) => void,
    reject: (error: Error) => void,
    timeoutMs?: number,
    timeoutMessage = 'MCP request timed out'
  ): void {
    let settled = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            this.pending.delete(id);
            reject(new Error(timeoutMessage));
          }, timeoutMs);
    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    this.pending.set(id, {
      resolve: (response) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        resolve(response);
      },
      reject: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        reject(error);
      },
    });
  }

  public static async start(
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<UiVerificationMcpSession> {
    signal?.throwIfAborted();
    const binPath = resolveUiVerificationBin();
    debugLog(`Executing: ${process.execPath} ${binPath}`);
    const child = spawn(process.execPath, [binPath], {
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const session = new UiVerificationMcpSession(child);
    session.attachCancellation(signal);
    try {
      await session.sendAndWait(0, {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'devecocli', version: '1.0.0' },
        },
      });
      return session;
    } catch (error) {
      await session.close(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: ProgressHandler,
    timeoutMs?: number
  ): Promise<unknown> {
    const id = this.nextId++;
    if (onProgress) {
      this.progressHandlers.set(id, onProgress);
    }

    try {
      const response = await this.sendAndWait(
        id,
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            ...(onProgress ? { _meta: { progressToken: id } } : {}),
          },
        },
        timeoutMs,
        `${name} timed out after ${Math.floor((timeoutMs ?? 0) / 60000)} minutes`
      );
      if (response.error) {
        const error = response.error as Record<string, unknown>;
        throw new Error(String(error.message ?? `${name} failed`));
      }
      const result = response.result as Record<string, unknown> | undefined;
      if (result?.structuredContent !== undefined) {
        return result.structuredContent;
      }
      const content = result?.content as Array<{ text?: unknown }> | undefined;
      if (content?.length && typeof content[0].text === 'string') {
        return content[0].text;
      }
      return result;
    } finally {
      this.progressHandlers.delete(id);
    }
  }

  private attachCancellation(signal?: AbortSignal): void {
    if (!signal) {
      return;
    }
    const onAbort = (): void => {
      const reason = signal.reason;
      void this.close(
        reason instanceof Error
          ? reason
          : new Error('Verification cancelled by user')
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.abortCleanup = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
    }
  }

  public close(
    error = new Error('ui-verification-mcp session closed')
  ): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closedError ??= error;
    this.abortCleanup?.();
    this.abortCleanup = undefined;
    for (const handler of this.pending.values()) {
      handler.reject(error);
    }
    this.pending.clear();
    this.progressHandlers.clear();
    this.closePromise = this.terminateProcessTree();
    return this.closePromise;
  }

  private async terminateProcessTree(): Promise<void> {
    if (!this.child.pid) {
      await this.stopped;
      return;
    }
    if (process.platform === 'win32') {
      const args = ['/pid', String(this.child.pid), '/t', '/f'];
      debugLog(`Executing: taskkill ${args.join(' ')}`);
      await new Promise<void>((resolve) =>
        execFile('taskkill', args, () => resolve())
      );
      await this.stopped;
      return;
    }
    this.killProcessGroup('SIGTERM');
    const timer = setTimeout(() => this.killProcessGroup('SIGKILL'), 1000);
    try {
      await this.stopped;
    } finally {
      clearTimeout(timer);
      // Descendants can outlive the launcher after closing their stdio.
      this.killProcessGroup('SIGKILL');
    }
  }

  private killProcessGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.child.pid!, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }
}
