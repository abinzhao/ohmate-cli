/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile, ExecFileOptions, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type StreamSource = 'stdout' | 'stderr';

export interface StreamCommandHandlers {
  onData: (lines: string[], source: StreamSource) => void;
  onError: (error: Error) => void;
  onClose: (code: number | null) => void;
}

interface ExecFileError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

interface StreamingState {
  stdoutChunks: string[];
  stderrChunks: string[];
  stdoutLineBuffer: string;
  stderrLineBuffer: string;
  settled: boolean;
}

function emitCompleteLines(
  buffer: string,
  source: StreamSource,
  handlers: StreamCommandHandlers
): string {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  const rest = parts.pop() ?? '';
  const lines = parts
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  if (lines.length > 0) {
    handlers.onData(lines, source);
  }
  return rest;
}

function flushTailLine(
  buffer: string,
  source: StreamSource,
  handlers: StreamCommandHandlers
): void {
  const finalLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
  if (finalLine.length > 0) {
    handlers.onData([finalLine], source);
  }
}

function toCommandResult(state: StreamingState, code: number | null): CommandResult {
  return {
    stdout: state.stdoutChunks.join(''),
    stderr: state.stderrChunks.join(''),
    exitCode: code ?? -1,
  };
}

function createStreamingState(): StreamingState {
  return {
    stdoutChunks: [],
    stderrChunks: [],
    stdoutLineBuffer: '',
    stderrLineBuffer: '',
    settled: false,
  };
}

function bindStreamingEvents(
  child: ReturnType<typeof spawn>,
  state: StreamingState,
  handlers: StreamCommandHandlers,
  resolve: (value: CommandResult) => void,
  reject: (reason?: unknown) => void
): void {
  child.stdout?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    state.stdoutChunks.push(text);
    state.stdoutLineBuffer = emitCompleteLines(
      state.stdoutLineBuffer + text,
      'stdout',
      handlers
    );
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    state.stderrChunks.push(text);
    state.stderrLineBuffer = emitCompleteLines(
      state.stderrLineBuffer + text,
      'stderr',
      handlers
    );
  });

  child.on('error', (error) => {
    if (state.settled) {
      return;
    }
    state.settled = true;
    handlers.onError(error);
    reject(error);
  });

  child.on('close', (code) => {
    if (state.settled) {
      return;
    }
    state.settled = true;
    flushTailLine(state.stdoutLineBuffer, 'stdout', handlers);
    flushTailLine(state.stderrLineBuffer, 'stderr', handlers);
    handlers.onClose(code);
    const result = toCommandResult(state, code);
    resolve(result);
  });
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: ExecFileOptions = {}
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return {
      stdout: typeof stdout === 'string' ? stdout.trim() : '',
      stderr: typeof stderr === 'string' ? stderr.trim() : '',
      exitCode: 0,
    };
  } catch (err: unknown) {
    const error = err as ExecFileError;
    return {
      stdout: error.stdout?.trim() || '',
      // ?? (not ||): an empty stderr must stay empty — backfilling it with
      // node's generic "Command failed" message would mask the
      // exit-1-with-no-output signal callers classify on (e.g. pidof probes).
      stderr: error.stderr?.trim() ?? error.message,
      exitCode: typeof error.code === 'number' ? error.code : 1,
    };
  }
}

export async function runStreamingCommand(
  command: string,
  args: string[],
  handlers: StreamCommandHandlers
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const state = createStreamingState();
    bindStreamingEvents(child, state, handlers, resolve, reject);
  });
}
