/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { HdcError, HdcTimeoutError, HdcCommandError } from '../common/errors.js';
import type { Logger } from '../common/logger.js';
import type { Dfx } from '../common/dfx.js';

export interface HdcResultInit {
  args: string[];
  code?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HdcExecutorOptions {
  bin?: string;
  host?: string;
  port?: number;
  execTimeoutMs?: number;
  logger?: Logger | null;
  dfx?: Dfx | null;
}

/** Execution result of a single hdc command */
export class HdcResult {
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;

  constructor({ args, code = 0, stdout = '', stderr = '', durationMs = 0 }: HdcResultInit) {
    this.args = args;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.durationMs = durationMs;
  }

  get ok(): boolean {
    return this.code === 0;
  }

  get command(): string {
    return this.args.join(' ');
  }

  /** Asserts success; throws HdcCommandError otherwise */
  assertOk(what: string = 'hdc command'): this {
    if (this.ok) {
      return this;
    }
    throw new HdcCommandError(`${what} failed: ${this.stderr || this.stdout || `exit ${this.code}`}`, {
      details: { args: this.args, stderr: this.stderr, stdout: this.stdout, code: this.code },
    });
  }

  toString(): string {
    return this.command;
  }
}

export class HdcExecutor {
  bin: string;
  host: string;
  port: number;
  execTimeoutMs: number;
  logger: Logger | null;
  dfx: Dfx | null;

  constructor(options: HdcExecutorOptions = {}) {
    this.bin = options.bin || 'hdc';
    this.host = options.host || '127.0.0.1';
    this.port = options.port ?? 8710;
    this.execTimeoutMs = options.execTimeoutMs ?? 10000;
    this.logger = options.logger ?? null;
    this.dfx = options.dfx ?? null;
  }

  /**
   * Executes a hdc command (implemented by subclass)
   * @param args Does not include hdc itself, e.g. ['-t','SN','shell','ps -ef']
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async exec(args: string[], opts?: ExecOptions): Promise<HdcResult> {
    throw new HdcError('HdcExecutor.exec() must be implemented by subclass');
  }

  /**
   * hdc server address (host:port); when non-default, all commands get `-s host:port` prefix.
   */
  get serverAddress(): string {
    return `${this.host || '127.0.0.1'}:${this.port ?? 8710}`;
  }

  /** Returns ['-s','host:port'] for remote/non-default server, otherwise returns [] */
  serverPrefixArgs(): string[] {
    const isDefault =
      (!this.host || this.host === '127.0.0.1' || this.host === 'localhost') &&
      (this.port ?? 8710) === 8710;
    return isDefault ? [] : ['-s', this.serverAddress];
  }

  /**
   * Lists connected devices
   */
  async listTargets(opts?: ExecOptions): Promise<string[]> {
    const result = await this.exec(['list', 'targets'], opts);
    return parseTargets(result.stdout);
  }
}

/**
 * Parses `hdc list targets` output
 */
export function parseTargets(stdout: string): string[] {
  const text = String(stdout || '').trim();
  if (!text || /\[Empty\]/i.test(text) || /^Empty$/i.test(text)) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/\[Empty\]/i.test(line) && !/^Empty$/i.test(line));
}

export interface FportEntry {
  hostPort: number;
  deviceEndpoint: string;
  taskString: string;
}

/**
 * Parses `hdc fport ls` output
 * Format: "<device_id>    tcp:HOST_PORT tcp:DEVICE_ENDPOINT    [Forward]"
 * Or:     "tcp:HOST_PORT tcp:DEVICE_ENDPOINT    [Forward]"
 */
export function parseFportList(stdout: string): FportEntry[] {
  const out: FportEntry[] = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/\[Empty\]/i.test(line) || /^Empty$/i.test(line)) {
      continue;
    }
    const m = /tcp:(\d+)\s+(\S+)/.exec(line);
    if (!m) {
      continue;
    }
    const hostPort = Number(m[1]);
    if (!Number.isInteger(hostPort)) {
      continue;
    }
    out.push({ hostPort, deviceEndpoint: m[2], taskString: `tcp:${hostPort} ${m[2]}` });
  }
  return out;
}

export interface ProcessEntry {
  pid: number;
  cmd: string;
  user?: string;
}

/**
 * Parses `ps -ef` output into a process list
 */
export function parseProcessList(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    out.push({ user: m[1], pid: Number(m[2]), cmd: m[4] });
  }
  return out;
}

export { HdcError, HdcTimeoutError, HdcCommandError };
