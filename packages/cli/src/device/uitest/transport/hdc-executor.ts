/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { HdcExecutor, HdcResult, type ExecOptions, type HdcExecutorOptions } from './base-hdc-executor.js';
import { HdcTimeoutError } from '../common/errors.js';
import { debugLog } from '../../../utils/logger.js';

export interface RealHdcExecutorOptions extends HdcExecutorOptions {
  env?: NodeJS.ProcessEnv;
  onStderr?: (line: string) => void;
  windowsHide?: boolean;
}

interface ExecRunState {
  outChunks: Buffer[];
  errChunks: Buffer[];
  settled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
}

export class RealHdcExecutor extends HdcExecutor {
  env: NodeJS.ProcessEnv;
  onStderr: ((line: string) => void) | null;
  windowsHide: boolean;

  constructor(options: RealHdcExecutorOptions = {}) {
    super(options);
    // Defaults to inheriting process.env; caller can pass a trimmed environment
    this.env = options.env || process.env;
    this.onStderr = options.onStderr ?? null;
    this.windowsHide = options.windowsHide !== false;
  }

  /**
   * Assembles the child process environment:
   *   When using a remote server (non-default host), injects HDC_SERVER_IP / HDC_SERVER_PORT,
   *   which hdc natively uses to connect to the remote server; does not override if already explicitly set.
   */
  _childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.env };
    if (this.host && this.host !== '127.0.0.1') {
      if (!env.HDC_SERVER_IP) {
        env.HDC_SERVER_IP = this.host;
      }
      if (!env.HDC_SERVER_PORT) {
        env.HDC_SERVER_PORT = String(this.port);
      }
    }
    return env;
  }

  exec(args: string[], opts: ExecOptions = {}): Promise<HdcResult> {
    const timeoutMs = opts.timeoutMs ?? this.execTimeoutMs;
    const t0 = Date.now();
    const end = this.dfx ? this.dfx.timer('hdc.exec', { cmd: args[0] }) : null;
    // Inject server prefix uniformly here; callers need not worry about -s
    const fullArgs = [...this.serverPrefixArgs(), ...args];
    const childEnv = this._childEnv();

    return new Promise((resolve, reject) => {
      const child = this.spawnHdcChild(fullArgs, childEnv, end, reject);
      if (!child) {
        return undefined;
      }
      this.attachChildHandlers(child, args, timeoutMs, t0, end, resolve, reject);
      return undefined;
    });
  }

  private spawnHdcChild(
    fullArgs: string[],
    childEnv: NodeJS.ProcessEnv,
    end: ((extraFields?: Record<string, unknown>) => number) | null,
    reject: (error: Error) => void,
  ): ChildProcess | null {
    try {
      debugLog(`Executing: ${this.bin} ${fullArgs.join(' ')}`);
      return spawn(this.bin, fullArgs, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: this.windowsHide,
      });
    } catch (err) {
      if (end) {
        end({ ok: 0 });
      }
      reject(new HdcTimeoutError(`spawn ${this.bin} failed: ${(err as Error).message}`, { cause: err as Error }));
      return null;
    }
  }

  private attachChildHandlers(
    child: ChildProcess,
    args: string[],
    timeoutMs: number,
    t0: number,
    end: ((extraFields?: Record<string, unknown>) => number) | null,
    resolve: (result: HdcResult) => void,
    reject: (error: Error) => void,
  ): void {
    const state: ExecRunState = {
      outChunks: [],
      errChunks: [],
      settled: false,
      timedOut: false,
      timer: null,
    };

    state.timer = setTimeout(() => {
      state.timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (state.outChunks.length < 4096) {
        state.outChunks.push(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      state.errChunks.push(chunk);
      if (this.onStderr) {
        this.onStderr(chunk.toString());
      }
    });

    child.on('close', (code: number | null) => {
      this.finalizeResult(code, args, timeoutMs, t0, end, state, resolve, reject);
    });
    child.on('error', (err: Error) => {
      this.handleChildError(err, args, end, state, reject);
    });
  }

  private finalizeResult(
    code: number | null,
    args: string[],
    timeoutMs: number,
    t0: number,
    end: ((extraFields?: Record<string, unknown>) => number) | null,
    state: ExecRunState,
    resolve: (result: HdcResult) => void,
    reject: (error: Error) => void,
  ): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    const stdout = Buffer.concat(state.outChunks).toString('utf8').trim();
    const stderr = Buffer.concat(state.errChunks).toString('utf8').trim();
    const durationMs = Date.now() - t0;
    if (end) {
      end({ ok: code === 0 ? 1 : 0 });
    }
    if (this.dfx) {
      this.dfx.counter(code === 0 ? 'hdc.exec.ok' : 'hdc.exec.error', 1, { cmd: args[0] });
    }
    if (this.logger) {
      this.logger.debug(`hdc ${args.join(' ')} -> code=${code} (${durationMs}ms)`);
    }
    if (state.timedOut) {
      reject(
        new HdcTimeoutError(`hdc ${args.join(' ')} timeout after ${timeoutMs}ms`, {
          details: { args, stdout, stderr },
        }),
      );
      return;
    }
    resolve(new HdcResult({ args, code: code ?? -1, stdout, stderr, durationMs }));
  }

  private handleChildError(
    err: Error,
    args: string[],
    end: ((extraFields?: Record<string, unknown>) => number) | null,
    state: ExecRunState,
    reject: (error: Error) => void,
  ): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    if (end) {
      end({ ok: 0 });
    }
    reject(new HdcTimeoutError(`hdc ${args.join(' ')} spawn error: ${err.message}`, { cause: err }));
  }
}
