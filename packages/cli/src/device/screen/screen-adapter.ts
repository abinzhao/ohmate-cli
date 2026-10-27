/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolProvider } from '../../toolchain/index.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';

export class ScreenAdapter {
  constructor(private toolProvider: ToolProvider) {}

  async getDisplayInfo(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-a'],
    );
    return result.stdout;
  }

  async setScreenTimeout(target: string, ms: number): Promise<string> {
    // First restore screen off time (cancel keep-screen-on if previously set by -t)
    await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'hidumper', '-s', 'PowerManagerService', '-a', '-f'],
    );
    // Then set the new timeout
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'power-shell', 'timeout', '-o', String(ms)],
    );
    return result.stdout;
  }

  async setScreenNeverSleep(target: string): Promise<string> {
    // First restore screen off time (undo any previous -o override)
    await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'power-shell', 'timeout', '-r'],
    );
    // Then enable keep-screen-on
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'hidumper', '-s', 'PowerManagerService', '-a', '-t'],
    );
    return result.stdout;
  }
}
