/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { classifyHdcOutput } from '../../utils/hdc-param.js';
import { debugLog } from '../../utils/logger.js';
import { parseRecorderRecords } from './ability-records.js';
import type { LockLease } from './file-lock.js';
import {
  RECORDER_ABILITY,
  RECORDER_BUNDLE,
  ScreenRecordError,
  type RecorderRecord,
} from './types.js';

export interface HdcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HdcRunner = (
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<HdcResult>;

export interface ToggleOutcome {
  /** 'uncertain': transport failed/timed out; device may still have run it. */
  transport: 'returned' | 'uncertain';
  stdout?: string;
  stderr?: string;
}

/** A hdc call that reports no usable state within this budget is an error. */
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/** Export + recv of large videos get a generous independent budget. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TRANSIENT_RETRIES = 3;
const TRANSIENT_WAIT_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default runner: execa with timeout + cancelSignal (no retries here). */
export function createExecaRunner(command: string): HdcRunner {
  return async (args, options) => {
    debugLog(`Executing: ${command} ${args.join(' ')}`);
    const result = await execa(command, args, {
      reject: false,
      timeout: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      cancelSignal: options.signal,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: result.exitCode ?? -1,
    };
  };
}

/**
 * hdc IO for the device screen recorder. Toggles are single-shot and never
 * retried; only the caller's observation loop may confirm state. Read-only
 * probes get a small transient-error retry.
 */
export class RecorderDevice {
  private readonly runner: HdcRunner;

  constructor(hdcPath: string) {
    this.runner = createExecaRunner(hdcPath);
  }

  /** Run once, retrying only unambiguous transient transport failures. */
  private async runReadOnly(
    args: string[],
    timeoutMs?: number
  ): Promise<HdcResult> {
    let last: HdcResult = { stdout: '', stderr: '', exitCode: -1 };
    // The budget (when given) covers all transient retries, not each attempt.
    const deadline =
      timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    for (let attempt = 0; attempt < TRANSIENT_RETRIES; attempt++) {
      const remaining =
        deadline !== undefined ? deadline - Date.now() : undefined;
      last = await this.runner(
        args,
        remaining === undefined ? {} : { timeoutMs: Math.max(1, remaining) }
      );
      const combined = `${last.stdout}\n${last.stderr}`;
      if (last.exitCode === 0 || classifyHdcOutput(combined) !== 'transient') {
        return last;
      }
      if (deadline !== undefined && Date.now() + TRANSIENT_WAIT_MS > deadline) {
        break;
      }
      await sleep(TRANSIENT_WAIT_MS);
    }
    return last;
  }

  private static assertUsable(result: HdcResult, code: string): void {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0 || classifyHdcOutput(combined) !== 'ok') {
      throw new ScreenRecordError(
        code,
        `hdc command failed (exit ${result.exitCode}): ${combined.split('\n')[0] ?? ''}`
      );
    }
  }

  /** One `aa dump -e` observation; parse failures are hard errors. */
  public async observeOnce(
    serial: string,
    timeoutMs?: number
  ): Promise<RecorderRecord[]> {
    const result = await this.runReadOnly(
      ['-t', serial, 'shell', 'aa', 'dump', '-e'],
      timeoutMs
    );
    RecorderDevice.assertUsable(result, 'DUMP_PARSE_FAILED');
    return parseRecorderRecords(result.stdout);
  }

  /** Device uptime in ms (from `/proc/uptime`); the clock behind dump `start time` values. */
  public async readUptimeMs(
    serial: string,
    timeoutMs?: number
  ): Promise<number> {
    const result = await this.runReadOnly(
      ['-t', serial, 'shell', 'cat', '/proc/uptime'],
      timeoutMs
    );
    RecorderDevice.assertUsable(result, 'DUMP_PARSE_FAILED');
    const seconds = Number(/^([\d.]+)/.exec(result.stdout.trim())?.[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new ScreenRecordError(
        'DUMP_PARSE_FAILED',
        `Unparseable /proc/uptime output: ${result.stdout.trim().split('\n')[0] ?? ''}`
      );
    }
    return Math.round(seconds * 1000);
  }

  /**
   * Send the recorder toggle exactly once (with `CustomizedFileName` to start
   * a named recording, without to stop). The outcome is never trusted: the
   * caller must confirm via observation and must not re-toggle on failure.
   */
  public async toggleOnce(
    serial: string,
    fileName: string | undefined,
    lease: LockLease,
    timeoutMs?: number
  ): Promise<ToggleOutcome> {
    await lease.assertOwned();
    const args = [
      '-t',
      serial,
      'shell',
      'aa',
      'start',
      '-b',
      RECORDER_BUNDLE,
      '-a',
      RECORDER_ABILITY,
    ];
    if (fileName !== undefined) {
      args.push('--ps', 'CustomizedFileName', fileName);
    }
    try {
      const result = await this.runner(args, {
        timeoutMs: timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        signal: lease.signal,
      });
      if (result.exitCode !== 0) {
        debugLog(
          `aa start exited ${result.exitCode}: ${result.stderr || result.stdout}`
        );
        return {
          transport: 'uncertain',
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
      return {
        transport: 'returned',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      // Aborted (lost lock) or spawn failure: device state is unknown.
      debugLog(`aa start transport failure: ${(error as Error).message}`);
      return { transport: 'uncertain', stderr: (error as Error).message };
    }
  }

  /**
   * Exact display-name media lookup. Returns the single media URI, undefined
   * when absent, and throws on multiple matches or unparseable output.
   */
  public async queryMediaUri(
    serial: string,
    fileName: string,
    timeoutMs?: number
  ): Promise<string | undefined> {
    const result = await this.runReadOnly(
      ['-t', serial, 'shell', 'mediatool', 'query', fileName, '-u'],
      timeoutMs
    );
    RecorderDevice.assertUsable(result, 'MEDIA_QUERY_FAILED');
    const countMatch = /find\s+(\d+)\s+result/i.exec(result.stdout);
    if (!countMatch) {
      throw new ScreenRecordError(
        'MEDIA_QUERY_FAILED',
        `Unparseable mediatool query output: ${result.stdout.trim().split('\n')[0] ?? ''}`
      );
    }
    const uris = [...result.stdout.matchAll(/"(file:\/\/[^"]+)"/g)].map(
      (m) => m[1]
    );
    const count = Number(countMatch[1]);
    if (count === 0) {
      return undefined;
    }
    if (count > 1 || uris.length > 1) {
      throw new ScreenRecordError(
        'MEDIA_AMBIGUOUS',
        `mediatool returned ${count} entries for ${fileName}`
      );
    }
    if (uris.length !== 1) {
      throw new ScreenRecordError(
        'MEDIA_QUERY_FAILED',
        `mediatool reported 1 entry but no URI for ${fileName}`
      );
    }
    return uris[0];
  }

  /** Export one media URI to a staging path on device. */
  public async exportToStaging(
    serial: string,
    mediaUri: string,
    stagingPath: string
  ): Promise<void> {
    const result = await this.runner(
      ['-t', serial, 'shell', 'mediatool', 'recv', mediaUri, stagingPath],
      { timeoutMs: TRANSFER_TIMEOUT_MS }
    );
    RecorderDevice.assertUsable(result, 'SAVE_FAILED');
    if (!result.stdout.includes(stagingPath)) {
      throw new ScreenRecordError(
        'SAVE_FAILED',
        `mediatool recv did not confirm ${stagingPath}: ${result.stdout.trim().split('\n')[0] ?? ''}`
      );
    }
  }

  /** Pull a device staging file to a local temp path. */
  public async receiveFile(
    serial: string,
    remotePath: string,
    localPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const result = await this.runner(
      ['-t', serial, 'file', 'recv', remotePath, localPath],
      { timeoutMs: TRANSFER_TIMEOUT_MS, signal }
    );
    if (result.exitCode !== 0) {
      throw new ScreenRecordError(
        'SAVE_FAILED',
        `hdc file recv failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).split('\n')[0] ?? ''}`
      );
    }
  }

  /** Best-effort staging cleanup. Returns false so the caller can warn. */
  public async removeStaging(
    serial: string,
    stagingPath: string
  ): Promise<boolean> {
    const result = await this.runReadOnly(
      ['-t', serial, 'shell', 'rm', '-f', stagingPath],
      DEFAULT_CALL_TIMEOUT_MS
    );
    return result.exitCode === 0;
  }
}
