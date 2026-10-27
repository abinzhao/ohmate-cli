/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolProvider } from '../../toolchain/index.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { assertTesthelperAvailable } from '../testhelper-check.js';

export class ClipboardAdapter {
  constructor(private toolProvider: ToolProvider) {}

  async readClipboard(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'get-pastedata'],
    );
    assertTesthelperAvailable(result);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'read clipboard failed');
    }
    return result.stdout;
  }

  async writeClipboard(target: string, text: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'set-pastedata', text],
    );
    assertTesthelperAvailable(result);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'write clipboard failed');
    }
    return result.stdout;
  }

  async clearClipboard(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'clear-pastedata'],
    );
    assertTesthelperAvailable(result);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'clear clipboard failed');
    }
    return result.stdout;
  }
}
