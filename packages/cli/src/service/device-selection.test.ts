/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceManager } from './device-manager.js';

let root: string, executable: string, ready: string;
let pending: Promise<unknown> | undefined;
let readinessWatcher: FSWatcher | undefined;
let cancel: AbortController;
let originalCwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-device-selection-'));
  executable = join(root, 'list');
  ready = join(root, 'ready');
  cancel = new AbortController();
  originalCwd = process.cwd();
  process.chdir(root);
});
afterEach(async () => {
  try {
    readinessWatcher?.close();
    readinessWatcher = undefined;
    // Abort even when startup failed before the fixture could publish its PID.
    cancel.abort();
    const pid = await readFile(ready, 'utf8')
      .then(Number)
      .catch(() => undefined);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* The selected query already exited. */
      }
    }
    await pending?.catch(() => {});
  } finally {
    pending = undefined;
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')(
  'cancels and joins a blocked device selection query',
  async () => {
    // Use an installed interpreter: executing new temporary scripts can stall on
    // macOS. "sh list targets" reads our private fixture without executing it.
    // exec preserves the PID; sleep is the blocked work, not a readiness delay.
    await writeFile(
      executable,
      `printf '%s\\n' "$$" > ready.tmp\n/bin/mv ready.tmp ready\nexec /bin/sleep 60\n`,
      { mode: 0o600 }
    );
    // Atomic publication acknowledges a running fixture independently of host scheduling.
    const started = new Promise<void>((resolve, reject) => {
      readinessWatcher = watch(root, (_event, file) => {
        if (file === 'ready') { resolve(); }
      });
      readinessWatcher.once('error', reject);
    });
    pending = DeviceManager.withHdcPath('/bin/sh').listDevices(cancel.signal);
    let failure: unknown;
    let settled = false;
    const joined = pending.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        failure = error;
        settled = true;
      }
    );
    await Promise.race([started, joined.then(() => {
      throw failure ?? new Error('Fixture exited before cancellation');
    })]);
    readinessWatcher?.close();
    readinessWatcher = undefined;
    const pid = Number(await readFile(ready, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).not.toThrow();
    cancel.abort();
    await vi.waitFor(
      () => {
        expect(settled).toBe(true);
      },
      { timeout: 1000 }
    );
    await joined;
    expect(failure).toMatchObject({ isCanceled: true, timedOut: false });
    expect(() => process.kill(pid, 0)).toThrow();
  }
);
