/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { Project } from '../../utils/project.js';
import { debugLog } from '../../utils/logger.js';
import { EnvCheckMessages } from '../../config/signature.js';
import type { CheckResult } from './types.js';

export class ProjectChecker {
  private _project: Project | null = null;

  get project(): Project {
    if (!this._project) {
      throw new Error('Project not initialized. Call checkProjectDir first.');
    }
    return this._project!;
  }

  /**
   * 场景 10：检查当前目录是否为有效的鸿蒙工程项目。
   * 最先执行，不依赖 ToolProvider。
   */
  checkProjectDir(fail: (msg: string) => CheckResult): CheckResult {
    try {
      this._project = Project.discover(process.cwd());
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Project.discover() failed: ${(e as Error).message}`);
      return fail(EnvCheckMessages.PROJECT_DIR_MISSING);
    }
  }

  /**
   * 场景 5：验证产品名称在项目配置中存在。
   */
  checkProduct(productName: string, fail: (msg: string) => CheckResult): CheckResult {
    try {
      this._project!.validateProduct(productName);
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Product validation failed: ${(e as Error).message}`);
      return fail(`Product "${productName}" not found.Check the product property in the build-profile.json5 file.`);
    }
  }

  /**
   * 场景 6：验证能否从 AppScope/app.json5 中读取 bundleName。
   */
  checkBundleName(productName: string, fail: (msg: string) => CheckResult): CheckResult {
    try {
      this._project!.getBundleName();
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] BundleName check failed: ${(e as Error).message}`);
      return fail(`bundleName was not found under product "${productName}".Check the bundleName configuration.`);
    }
  }

  /**
   * 场景 13：检查工程是否为元服务（atomicService）工程。
   * 元服务工程暂不支持自动签名，提示手动配置。
   */
  checkAtomicService(): CheckResult {
    if (this._project!.isAtomicService()) {
      return {
        passed: false,
        message: EnvCheckMessages.ATOMIC_SERVICE_UNSUPPORTED,
      };
    }
    return { passed: true, message: '' };
  }
}
