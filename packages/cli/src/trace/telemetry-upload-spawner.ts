/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUploadDue, isTelemetryDisabled } from './upload-state.js';
import { mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';

/**
 * 定位后台上传脚本。
 *
 * 本模块经 tsup 打包后内联进 dist/cli.js，故 import.meta.url 指向 dist/cli.js，
 * dirname = dist/，背景脚本位于 dist/internal/telemetry-upload-background.js。
 * dev 模式（tsx 直接跑源码）下该路径不存在，返回 null 跳过 spawn。
 */
function resolveBackgroundScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, 'internal', 'telemetry-upload-background.js');
  return existsSync(candidate) ? candidate : null;
}

/**
 * 检查是否应触发后台上传，若应触发则 spawn 一个 detached 子进程，进程内执行
 * telemetry.flush() + telemetry.retryFailed()（待上传 + failed 重试一起跑）。
 * 子进程脱离父进程（unref），不阻塞 CLI 退出；stdio 全部 ignore。
 *
 * 触发条件（OR，见 upload-state.ts isUploadDue）：
 * - 有待上传事件且 firstEventAt 距 now 超过 UPLOAD_INTERVAL_MS；或
 * - failed 目录有待处理文件（7 天内 `.txt` 或陈旧 `.pending` 孤儿）且距上次重试超过 RETRY_INTERVAL_MS。
 */
export function maybeSpawnTelemetryUpload(storageDir: string): void {
  if (isTelemetryDisabled() || !isUploadDue(storageDir)) {
    return;
  }
  const script = resolveBackgroundScript();
  if (!script) {
    mcpLog.warn('[telemetry] background upload script not found, skipping spawn');
    return;
  }
  try {
    const child = spawn(
      process.execPath,
      [script],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          DEVECO_CLI_SKIP_VERSION_CHECK: '1',
          DEVECO_CLI_TELEMETRY_UPLOAD: '1',
        },
      },
    );
    child.unref();
  } catch (e) {
    mcpLog.warn('[telemetry] failed to spawn background upload:', e);
  }
}
