/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ToolProvider } from '../toolchain/index.js';
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { withBuildLock } from '../utils/build-lock.js';
import { parseApplyFileList } from './changefile-parser.js';
import { BuildConfigManager } from './build-config.js';
import { buildSignedHqf } from './hqf-build.js';
import { ChangedFileListWriter } from './changed-file-list-writer.js';
import { InstallHqf } from './install-hqf.js';
import { debugLog } from '../utils/logger.js';

/** apply 依赖 hvigor assembleDevHqf，需要 DevEco Studio ≥6.1.1 */
const APPLY_MIN_VERSION = '6.1.1';

export interface ApplyContext {
  applyFile: string;
  productName: string;
  targetDeviceId: string;
  bundleName: string;
  abilityName: string;
}

export class ApplyManager {
  constructor(
    private toolProvider: ToolProvider,
    private projectRoot: string
  ) {}

  public async execute(ctx: ApplyContext): Promise<void> {
    await withBuildLock(
      this.projectRoot,
      () => this.executeSteps(ctx),
      () => console.log('[Apply] Waiting for another build to finish...')
    );
  }

  private async executeSteps(ctx: ApplyContext): Promise<void> {
    this.toolProvider.assertIdeVersion(APPLY_MIN_VERSION);
    const files = parseApplyFileList(ctx.applyFile, this.projectRoot);
    console.log(`[Apply] Parsed ${files.length} changed file(s)`);

    // 按文件路径自动归属模块，writeChangedFileLists 不传 activeModuleName → 写所有涉及模块
    const modules = this.writeChangeFileList(ctx, files);
    // 先停止应用，再构建 hqf，再一次 quickfix 推送后拉起
    await this.stopApp(ctx);
    const hqfPaths = await this.buildHqf(ctx, modules);
    await this.installHqf(ctx, hqfPaths);
    await this.launchApp(ctx);
    console.log('[Apply] Apply complete');
  }

  private writeChangeFileList(ctx: ApplyContext, files: string[]): string[] {
    const result = ChangedFileListWriter.writeChangedFileLists(
      this.projectRoot, ctx.productName, files
    );
    if (result.writtenModules.length === 0) {
      throw new Error('No changed files belong to a runnable module');
    }
    console.log(`[Apply] changeFileList written for: ${result.writtenModules.join(', ')}`);
    return result.writtenModules;
  }

  private async buildHqf(ctx: ApplyContext, moduleNames: string[]): Promise<string[]> {
    debugLog(`[Apply] hvigor assembleDevHqf --no-daemon (modules=${moduleNames.join(',')})`);
    return await BuildConfigManager.withBuildConfig(
      this.projectRoot,
      moduleNames,
      ctx.productName,
      this.toolProvider,
      () => buildSignedHqf(this.toolProvider, this.projectRoot, moduleNames, ctx.productName)
    );
  }

  private async installHqf(ctx: ApplyContext, hqfPaths: string[]): Promise<void> {
    console.log(`[Apply] Installing ${hqfPaths.length} hqf(s) to ${ctx.targetDeviceId}`);
    const installer = new InstallHqf(this.toolProvider);
    const result = await installer.install(ctx.targetDeviceId, hqfPaths, ctx.bundleName);
    if (!result.success) {
      throw new Error(`hqf install failed: ${result.message}`);
    }
    console.log('[Apply] hqf installed');
  }

  private async stopApp(ctx: ApplyContext): Promise<void> {
    const adapter = new HdcAdapter(this.toolProvider);
    try {
      await adapter.forceStopApp(ctx.targetDeviceId, ctx.bundleName);
      console.log('[Apply] app stopped');
    } catch (e) {
      console.warn(`[Apply] stop app failed: ${(e as Error).message}`);
    }
  }

  private async launchApp(ctx: ApplyContext): Promise<void> {
    const adapter = new HdcAdapter(this.toolProvider);
    try {
      await adapter.launchApp(ctx.targetDeviceId, ctx.bundleName, ctx.abilityName);
      console.log('[Apply] app launched');
    } catch (e) {
      throw new Error(`[Apply] launch app failed: ${(e as Error).message}`, { cause: e });
    }
  }
}
