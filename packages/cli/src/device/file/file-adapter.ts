/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import type { ToolProvider } from '../../toolchain/index.js';
import { debugLog } from '../../utils/logger.js';

export class FileAdapter {
  constructor(private toolProvider: ToolProvider) {}

  async fileExists(target: string, remotePath: string): Promise<boolean> {
    const cmd = this.toolProvider.hdcPath;
    const args = ['-t', target, 'shell', 'ls', '-l', remotePath];
    debugLog(`Executing: ${cmd} ${args.join(' ')}`);
    let output: string;
    try {
      const { stdout, stderr } = await execa(cmd, args, {
        env: { ...process.env },
      });
      output = `${stdout}\n${stderr}`;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
      if (/no such file or directory/i.test(output)) {
        return false;
      }
      throw error;
    }
    return !/no such file or directory/i.test(output);
  }

  async deleteFile(target: string, remotePath: string): Promise<string> {
    const cmd = this.toolProvider.hdcPath;
    const args = ['-t', target, 'shell', 'rm', '-f', remotePath];
    debugLog(`Executing: ${cmd} ${args.join(' ')}`);
    try {
      const { stdout } = await execa(cmd, args, {
        env: { ...process.env },
      });
      return stdout;
    } catch (error) {
      const e = error as { stdout?: string };
      return e.stdout ?? '';
    }
  }

  async sendFile(
    target: string,
    localPath: string,
    remotePath: string
  ): Promise<string> {
    const cmd = this.toolProvider.hdcPath;
    const args = ['-t', target, 'file', 'send', localPath, remotePath];
    debugLog(`Executing: ${cmd} ${args.join(' ')}`);
    const { stdout } = await execa(cmd, args, {
      env: { ...process.env },
    });
    if (!stdout.includes('FileTransfer finish')) {
      throw new Error(
        `File send failed: ${stdout.trim() || 'hdc returned no output'}`
      );
    }
    return stdout.trim();
  }

  async recvFile(
    target: string,
    remotePath: string,
    localPath: string
  ): Promise<string> {
    const cmd = this.toolProvider.hdcPath;
    const args = ['-t', target, 'file', 'recv', remotePath, localPath];
    debugLog(`Executing: ${cmd} ${args.join(' ')}`);
    const { stdout } = await execa(cmd, args, {
      env: { ...process.env },
    });
    if (!stdout.includes('FileTransfer finish')) {
      throw new Error(
        `File recv failed: ${stdout.trim() || 'hdc returned no output'}`
      );
    }
    return stdout.trim();
  }
}
