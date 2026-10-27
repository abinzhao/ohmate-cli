/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { debugLog } from '../../utils/logger.js';

export class AppControlAdapter {
  constructor(private readonly hdcPath: string) {}

  async listInstalledApps(target: string): Promise<string> {
    const args = ['-t', target, 'shell', 'bm', 'dump', '-a', '-l'];
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const res = await runHdcWithRetry(this.hdcPath, args);
    if (res.exitCode !== 0) {
      throw new Error(`bm dump -a -l failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout;
  }

  async getAppInfo(target: string, bundleName: string): Promise<string> {
    const args = ['-t', target, 'shell', 'bm', 'dump', '-n', bundleName];
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const res = await runHdcWithRetry(this.hdcPath, args);
    if (res.exitCode !== 0) {
      throw new Error(`bm dump -n ${bundleName} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout;
  }

  async getForegroundApp(target: string): Promise<string> {
    const args = ['-t', target, 'shell', 'aa', 'dump', '-l'];
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const res = await runHdcWithRetry(this.hdcPath, args);
    if (res.exitCode !== 0) {
      throw new Error(`aa dump -l failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout;
  }

  async startApp(
    target: string,
    bundle?: string,
    ability?: string,
    action?: string,
    uri?: string
  ): Promise<string> {
    const args = ['-t', target, 'shell', 'aa', 'start'];
    if (bundle) {
      args.push('-b', bundle);
    }
    if (ability) {
      args.push('-a', ability);
    }
    if (action) {
      args.push('-A', action);
    }
    if (uri) {
      args.push('-U', uri);
    }
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const res = await runHdcWithRetry(this.hdcPath, args);
    if (res.exitCode !== 0) {
      throw new Error(`aa start failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout;
  }

  async clearAppData(target: string, bundle: string): Promise<string> {
    const args = ['-t', target, 'shell', 'bm', 'clean', '-d', '-n', bundle];
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const res = await runHdcWithRetry(this.hdcPath, args);
    if (res.exitCode !== 0) {
      throw new Error(`bm clean -d -n ${bundle} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout;
  }

  async clearAppCache(target: string, bundle: string): Promise<string> {
    const args = ['-t', target, 'shell', 'bm', 'clean', '-c', '-n', bundle];
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const res = await runHdcWithRetry(this.hdcPath, args);
    if (res.exitCode !== 0) {
      throw new Error(`bm clean -c -n ${bundle} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout;
  }
}
