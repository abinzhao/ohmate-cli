/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { debugLog } from './logger.js';
import { startMemoryTracker } from './process-rss.js';
import { isTelemetryDisabled } from '../trace/index.js';

const EMULATOR_SPAWN_GRACE_MS = 2500;

function registerDetachedEmulatorExitHandler(
  child: ChildProcess,
  graceTimer: ReturnType<typeof setTimeout>,
  stderrText: () => string,
  cleanupAndResolve: () => void,
  cleanupAndReject: (message: string) => void,
  isSettled: () => boolean
): void {
  child.once('exit', (code) => {
    if (isSettled()) {
      return;
    }
    clearTimeout(graceTimer);
    const errOut = stderrText();
    if (code === 0 || code === null) {
      cleanupAndResolve();
    } else {
      cleanupAndReject(errOut || `Emulator process exited with code ${code}`);
    }
  });
}

function attachDetachedEmulatorLifecycle(
  child: ChildProcess,
  stderrChunks: Buffer[],
  resolve: () => void,
  reject: (err: Error) => void
): void {
  let settled = false;
  const isSettled = () => settled;

  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8').trim();

  const cleanupAndResolve = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(graceTimer);
    child.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stderr?.destroy();
    child.unref();
    resolve();
  };

  const cleanupAndReject = (message: string) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(graceTimer);
    child.removeAllListeners();
    child.stderr?.removeAllListeners();
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    reject(new Error(message));
  };

  const graceTimer = setTimeout(cleanupAndResolve, EMULATOR_SPAWN_GRACE_MS);

  child.once('error', (err) => cleanupAndReject(err.message));

  registerDetachedEmulatorExitHandler(
    child,
    graceTimer,
    stderrText,
    cleanupAndResolve,
    cleanupAndReject,
    isSettled
  );
}

export interface EmulatorSpawnHandle {
  pid: number | undefined;
  started: Promise<void>;
  tracker: { stop: () => Promise<number> } | undefined;
}

export function spawnEmulatorDetached(
  emulatorPath: string,
  sdkPath: string,
  args: string[]
): EmulatorSpawnHandle {
  debugLog(`Spawning emulator: ${emulatorPath} ${args.join(' ')}`);

  const stderrChunks: Buffer[] = [];
  const child = spawn(emulatorPath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DEVECO_SDK_HOME: sdkPath },
    windowsHide: true,
  });
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const tracker =
    child.pid !== undefined && !isTelemetryDisabled()
      ? startMemoryTracker(child.pid, 500, true)
      : undefined;

  const started = new Promise<void>((resolve, reject) => {
    attachDetachedEmulatorLifecycle(child, stderrChunks, resolve, reject);
  });

  return { pid: child.pid, started, tracker };
}
