/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog } from '../utils/logger.js';
import { executeToolProcess } from '../runtime/process-runner.js';
import type { ExecutionContext, ToolResult } from '../runtime/types.js';

function legacyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(`${process.platform === 'win32' ? '\\' : '/'}legacy`)
    ? join(here, 'entry.ts')
    : join(here, 'legacy.js');
}

export async function executeLegacy(argv: string[], context: ExecutionContext, protocol = false, entry = legacyPath()): Promise<ToolResult> {
  if (context.abortSignal.aborted) {
    return Promise.resolve({ exitCode: 130, data: { stdout: '', stderr: '', signal: 'cancelled-before-start' } });
  }
  const args = [...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), entry, ...argv];
  debugLog(`Executing: ${process.execPath} ${args.join(' ')}`);
  return executeToolProcess({
    executable: process.execPath, argv: args, protocol,
    env: {
      ...process.env,
      DEVECO_CLI_DATA_DIR: context.dataDir,
      DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all',
      DEVECO_CLI_WRAPPER_NAME: '@ohmate/ohmatecli',
      DEVECO_CLI_WRAPPER_VERSION: process.env.npm_package_version ?? '0.1.0',
    },
  }, context);
}
