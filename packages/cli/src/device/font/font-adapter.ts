/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { basename } from 'node:path';
import type { ToolProvider } from '../../toolchain/index.js';
import { HdcAdapter } from '../../utils/hdc-adapter.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { assertTesthelperAvailable } from '../testhelper-check.js';

export class FontAdapter {
  private hdc: HdcAdapter;

  constructor(private toolProvider: ToolProvider) {
    this.hdc = new HdcAdapter(toolProvider);
  }

  private async pushFontToDevice(
    target: string,
    localPath: string
  ): Promise<string> {
    const remotePath = `/data/local/tmp/${basename(localPath)}`;
    await this.hdc.transferFile(target, 'send', localPath, remotePath);
    return remotePath;
  }

  async installFont(target: string, localPath: string): Promise<string> {
    const remotePath = await this.pushFontToDevice(target, localPath);
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'install-font', remotePath],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }

  async getFontInfo(target: string, localPath: string): Promise<string> {
    const remotePath = await this.pushFontToDevice(target, localPath);
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'get-fontname', remotePath],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }

  async uninstallFont(target: string, name: string): Promise<string> {
    const result = await runHdcWithRetry(
      this.toolProvider.hdcPath,
      ['-t', target, 'shell', 'testhelper', 'uninstall-font', name],
    );
    assertTesthelperAvailable(result);
    return result.stdout;
  }
}
