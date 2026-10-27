/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolProvider } from '../../toolchain/index.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { assertTesthelperAvailable } from '../testhelper-check.js';

export class SystemAdapter {
  constructor(private toolProvider: ToolProvider) {}

  async getDeviceType(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'param', 'get', 'const.product.devicetype'],
    );
    return result.stdout;
  }

  async wakeScreen(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'power-shell', 'wakeup'],
    );
    return result.stdout;
  }

  async suspendScreen(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'power-shell', 'suspend'],
    );
    return result.stdout;
  }

  async getScreenStatus(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'hidumper', '-s', 'PowerManagerService', '-a', '-s'],
    );
    return result.stdout;
  }

  async getDisplayInfo(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-a'],
    );
    return result.stdout;
  }

  async swipeScreen(
    target: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    speed: number = 6000
  ): Promise<string> {
    const result = await runHdcWithRetry(this.toolProvider.hdcPath, [
      '-t', target, 'shell', 'uitest', 'uiInput', 'swipe',
      String(x1), String(y1), String(x2), String(y2), String(speed),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'swipe failed');
    }
    return result.stdout;
  }

  async getTime(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'get-time'],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }

  async setTime(target: string, datetime: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'set-time', datetime],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }

  async getTimezone(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'get-timezone'],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }

  async setTimezone(target: string, timezone: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'set-timezone', timezone],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }
}
