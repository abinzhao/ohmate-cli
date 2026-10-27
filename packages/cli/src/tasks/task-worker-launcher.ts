/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog } from '../utils/logger.js';

export async function launchTaskWorker(id: string, dataDir: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = here.endsWith('/tasks') || here.endsWith('\\tasks') ? join(here, 'task-worker.ts') : join(here, 'task-worker.js');
  const args = [...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), entry, '--id', id, '--data-dir', dataDir];
  debugLog(`Executing: ${process.execPath} ${args.join(' ')}`);
  const child = spawn(process.execPath, args, {
    shell: false, detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, OHMATE_DATA_DIR: dataDir, DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all' },
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
