/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * install-hqf.ts
 *
 * Apply Task4：将签名后的 hqf 包安装到设备
 *
 * 职责：
 *  1. 通过 hdc file send 将所有 hqf 推送到设备临时目录
 *  2. 通过 hdc shell bm quickfix -a -f -o 命令一次性安装所有 hqf 补丁
 *  3. 判断安装结果：返回 success → 安装成功；否则报错提示重新安装应用
 */

import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from '../utils/logger.js';
import { CommonUtils } from '../utils/common-utils.js';

/** hqf 安装结果 */
export interface InstallHqfResult {
  /** true = 安装成功；false = 安装失败 */
  success: boolean;
  /** 提示信息 */
  message: string;
}

export class InstallHqf {
  private toolProvider: ToolProvider;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
  }

  /**
   * 安装签名后的 hqf 包到指定设备（一次 quickfix 推所有 hqf）
   *
   * @param target       - 设备序列号（如 "127.0.0.1:5555"）
   * @param hqfPaths     - 签名后的 hqf 文件绝对路径数组
   * @param bundleName   - 应用 bundleName（用于命名设备端临时文件）
   * @param isHotReload
   * @returns InstallHqfResult 包含安装结果
   */
  public async install(
    target: string,
    hqfPaths: string[],
    bundleName: string
  ): Promise<InstallHqfResult> {
    for (const hqfPath of hqfPaths) {
      if (!fs.existsSync(hqfPath)) {
        const msg = `Signed hqf file not found: ${hqfPath}`;
        console.error(`[Apply] ${msg}`);
        return { success: false, message: msg };
      }
    }

    CommonUtils.assertBundleName(bundleName);

    const uuid = randomUUID();
    const remoteDir = `/data/local/tmp/${uuid}`;
    const remoteHqfPaths: string[] = [];

    try {
      for (let i = 0; i < hqfPaths.length; i++) {
        const remoteHqfPath = `${remoteDir}/${bundleName}_${i}.hqf`;
        remoteHqfPaths.push(remoteHqfPath);
        await this.pushHqf(target, hqfPaths[i], remoteDir, remoteHqfPath);
      }
      return await this.executeQuickfix(target, remoteHqfPaths);
    } catch (error) {
      const msg = `hqf install error: ${(error as Error).message}`;
      console.error(`[Apply] ${msg}`);
      return { success: false, message: msg };
    } finally {
      await this.runHdc(
        ['-t', target, 'shell', 'rm', '-rf', remoteDir],
        false
      );
    }
  }

  /**
   * 推送单个 hqf 文件到设备临时目录
   */
  private async pushHqf(
    target: string,
    hqfPath: string,
    remoteDir: string,
    remoteHqfPath: string
  ): Promise<void> {
    console.log(`[Apply] Pushing hqf to device ${target}: ${hqfPath}`);
    await this.runHdc(['-t', target, 'shell', 'mkdir', '-p', remoteDir]);

    const sendResult = await this.runHdc([
      '-t',
      target,
      'file',
      'send',
      hqfPath,
      remoteHqfPath,
    ]);
    if (!sendResult.startsWith('FileTransfer finish')) {
      throw new Error(`Failed to send hqf: ${sendResult}`);
    }
  }

  /**
   * 执行 bm quickfix 命令（一次安装所有 hqf）并解析结果
   */
  private async executeQuickfix(
    target: string,
    remoteHqfPaths: string[]
  ): Promise<InstallHqfResult> {
    console.log(
      `[Apply] Installing ${remoteHqfPaths.length} hqf patch(es) via quickfix...`
    );
    const args = ['-t', target, 'shell', 'bm', 'quickfix', '-a', '-f', ...remoteHqfPaths, '-d'];
    const apiVersion = await this.getApiVersion(target);
    if (apiVersion > 17) {
      args.push('-o');
    }
    const quickfixResult = await this.runHdc(args, false);

    debugLog(`[InstallHqf] quickfix output: ${quickfixResult}`);

    if (/succe(?:ed|ss)/i.test(quickfixResult)) {
      console.log(`[Apply] hqf installed successfully.`);
      return {
        success: true,
        message: 'hqf quickfix installed successfully.',
      };
    }

    const msg =
      `hqf quickfix install failed. Device response: ${quickfixResult || '(empty)'}. ` +
      'Please try reinstalling the application.';
    console.error(`[Apply] ${msg}`);
    return { success: false, message: msg };
  }

  private async getApiVersion(target: string): Promise<number> {
    try {
      const result = await this.runHdc(
        ['-t', target, 'shell', 'param', 'get', 'const.ohos.apiversion'],
        false
      );
      const version = parseInt(result.trim(), 10);
      if (!isNaN(version)) {
        console.log(`[InstallHqf] device API version: ${version}`);
        return version;
      }
    } catch {
      // ignore
    }
    return 0;
  }

  /**
   * 执行 hdc 命令
   *
   * @param args          - hdc 命令参数
   * @param throwOnError  - 是否在失败时抛出异常，默认 true
   * @returns 命令 stdout
   */
  private async runHdc(
    args: string[],
    throwOnError = true
  ): Promise<string> {
    const cmd = this.toolProvider.hdcPath;
    debugLog(`[InstallHqf] Executing: ${cmd} ${args.join(' ')}`);

    try {
      const { stdout } = await execa(cmd, args, {
        env: { ...process.env },
      });
      return stdout;
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      return (error as { stdout?: string }).stdout || '';
    }
  }
}
