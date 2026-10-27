/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolProvider } from '../../toolchain/index.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { assertTesthelperAvailable } from '../testhelper-check.js';

export class ViewmodeAdapter {
  constructor(private toolProvider: ToolProvider) {}

  async getViewmode(target: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'param', 'get', 'persist.ace.darkmode'],
    );
    return result.stdout;
  }

  async setViewmode(target: string, mode: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'set-viewmode', mode],
    );
    assertTesthelperAvailable(result);
    // Already set to the same mode — not an error, strip "Error:" prefix
    if (/already set to/i.test(result.stdout)) {
      return result.stdout.replace(/^Error:\s*/i, '').trim();
    }
    return result.stdout;
  }
}
