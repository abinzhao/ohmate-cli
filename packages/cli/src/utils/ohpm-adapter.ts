/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from './logger.js';
import { startMemoryTracker, formatBytesMb } from './process-rss.js';
import { isTelemetryDisabled } from '../trace/index.js';

export class OhpmAdapter {
  private toolProvider: ToolProvider;
  private projectRoot: string;
  peakMemoryMb = '';

  constructor(toolProvider: ToolProvider, projectRoot: string,
    private readonly executor?: (args: string[]) => Promise<void>) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;
  }

  public async install(): Promise<void> {
    if (this.executor) { await this.executor(['install']); return; }
    const cmd = this.toolProvider.nodePath;
    const args = [this.toolProvider.ohpmJsPath, 'install'];

    debugLog(`Executing: ${cmd} ${args.join(' ')}`);

    const child = execa(cmd, args, {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        DEVECO_SDK_HOME: this.toolProvider.sdkPath,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const tracker = !isTelemetryDisabled()
      ? startMemoryTracker(child.pid, 2000, false)
      : undefined;
    try {
      await child;
    } finally {
      if (tracker) {
        const peakBytes = await tracker.stop();
        if (peakBytes > 0) {
          this.peakMemoryMb = formatBytesMb(peakBytes);
        }
      }
    }
  }
}
