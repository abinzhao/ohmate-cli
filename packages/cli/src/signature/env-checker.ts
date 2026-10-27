/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ToolProvider } from '../toolchain';
import { debugLog } from '../utils/logger.js';
import { EnvCheckMessages } from '../config/signature.js';
import { ProjectChecker } from './env-check/project-checker.js';
import { ToolchainChecker } from './env-check/toolchain-checker.js';
import { AuthChecker } from './env-check/auth-checker.js';
import { DeviceChecker } from './env-check/device-checker.js';
import type { CheckResult, CheckContext } from './env-check/types.js';

export type { CheckResult, CheckContext } from './env-check/types.js';

/**
 * 环境预检器：按优先级顺序运行场景 1→12 的检查。
 * 任一检查失败即终止，并输出单行错误信息。
 */
export class EnvChecker {
  private projectChecker = new ProjectChecker();
  private toolchainChecker: ToolchainChecker | null = null;
  private authChecker = new AuthChecker();
  private deviceChecker: DeviceChecker | null = null;

  constructor() {}

  /**
   * 运行所有环境预检检查。
   * 所有检查通过返回 true，任一失败则终止进程。
   */
  public async preflight(ctx: CheckContext): Promise<boolean> {
    const bf = (m: string) => this.blockingFail(m);

    if (!(await this.runAuthChain(ctx, bf))) {
      return false;
    }
    if (!(await this.initToolchain())) {
      return false;
    }
    if (ctx.type !== 'release' && !(await this.runDeviceCheck(ctx, bf))) {
      return false;
    }
    if (!(await this.runProjectChecks(ctx, bf))) {
      return false;
    }
    if (!(await this.runAuxChecks(ctx))) {
      return false;
    }
    return true;
  }

  /** 认证链 + team-id 提前校验 */
  private async runAuthChain(
    ctx: CheckContext,
    bf: (m: string) => CheckResult
  ): Promise<boolean> {
    const failFast = (r: CheckResult): boolean => {
      if (!r.passed) {
        this.fail(r);
      }
      return true;
    };
    const chain: Array<() => Promise<CheckResult>> = [
      () => this.authChecker.checkLogin(bf),
      () => this.authChecker.checkRealname(bf),
      () => this.authChecker.checkTeamInfo(bf),
    ];
    for (const c of chain) {
      if (!failFast(await c())) {
        return false;
      }
    }
    if (ctx.teamId) {
      if (!failFast(await this.authChecker.checkTeamId(ctx.teamId))) {
        return false;
      }
    }
    return true;
  }

  /** 初始化 ToolProvider */
  private async initToolchain(): Promise<boolean> {
    try {
      const tp = await ToolProvider.new();
      this.toolchainChecker = new ToolchainChecker(tp);
      this.deviceChecker = new DeviceChecker(tp);
      return true;
    } catch (e) {
      debugLog(`[EnvCheck] ToolProvider.new() failed: ${(e as Error).message}`);
      throw new Error(EnvCheckMessages.TOOLCHAIN_INIT_FAILED, { cause: e });
    }
  }

  /** 设备检查 */
  private async runDeviceCheck(
    ctx: CheckContext,
    bf: (m: string) => CheckResult
  ): Promise<boolean> {
    const failFast = (r: CheckResult): boolean => {
      if (!r.passed) {
        this.fail(r);
        return false;
      }
      return true;
    };
    return failFast(await this.deviceChecker!.checkDevice(bf, ctx.teamId));
  }

  /** 工程目录 + 同步检查 */
  private async runProjectChecks(
    ctx: CheckContext,
    bf: (m: string) => CheckResult
  ): Promise<boolean> {
    const failFast = (r: CheckResult): boolean => {
      if (!r.passed) {
        this.fail(r);
        return false;
      }
      return true;
    };
    // 场景 10：项目目录检查
    if (!failFast(this.projectChecker.checkProjectDir(bf))) {
      return false;
    }
    // 场景 13：元服务
    if (!failFast(this.projectChecker.checkAtomicService())) {
      return false;
    }
    // 同步检查：场景 5、6（项目），7、8（工具链）
    const syncChecks: Array<() => CheckResult> = [
      () => this.projectChecker.checkProduct(ctx.productName, bf),
      () => this.projectChecker.checkBundleName(ctx.productName, bf),
      () => this.toolchainChecker!.checkJava(bf),
      () => this.toolchainChecker!.checkHapSignTools(bf),
    ];
    for (const c of syncChecks) {
      if (!failFast(c())) {
        return false;
      }
    }
    return true;
  }

  /** 辅助检查：team-id 默认解析 + 区域检查 */
  private async runAuxChecks(ctx: CheckContext): Promise<boolean> {
    const failFast = (r: CheckResult): boolean => {
      if (!r.passed) {
        this.fail(r);
        return false;
      }
      return true;
    };
    if (!ctx.teamId) {
      if (!failFast(await this.authChecker.checkTeamId(ctx.teamId))) {
        return false;
      }
    }
    await this.authChecker.checkRegion((m: string) => this.blockingFail(m));
    return true;
  }

  private blockingFail(message: string): CheckResult {
    return { passed: false, message };
  }

  /** 输出错误信息并抛出错误（由上层进行打点后统一处理）。 */
  private fail(result: CheckResult): never {
    debugLog(`[EnvCheck] FAIL: ${result.message}`);
    throw new Error(result.message);
  }
}
