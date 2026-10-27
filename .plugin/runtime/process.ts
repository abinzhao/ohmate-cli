/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import type { ProcessResult, RuntimeProcessOptions } from './types.js';
import { debugLog } from '../../packages/cli/src/utils/logger.js';

function forwardInterrupts(child: ChildProcess): () => void {
  let interrupted: NodeJS.Signals | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (interrupted) {
        child.kill('SIGKILL');
        return;
      }
      interrupted = signal;
      // Windows console Ctrl+C already reaches the child; kill('SIGINT') would force termination.
      if (process.platform !== 'win32' || signal !== 'SIGINT') {
        child.kill(signal);
      }
      console.error(
        'Waiting for the command to finish. Interrupt again to force termination.'
      );
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

export function runProcess(
  command: string,
  args: string[],
  options: RuntimeProcessOptions = {}
): Promise<ProcessResult> {
  debugLog(`Executing: ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      ...options,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const clean = forwardInterrupts(child);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clean();
      reject(error);
    });
    child.once('close', (code, signal) => {
      clean();
      const exitCode =
        code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1);
      resolve({ exitCode, stdout, stderr });
    });
  });
}
