/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import { ToolProvider } from '../toolchain/index.js';
import { Project } from '../utils/project.js';
import {
  UI_VERIFICATION_CACHE_DIR,
  pruneUiVerificationCache,
} from './cache.js';
import { resolveUiVerificationDevice } from './device.js';
import { UiVerificationMcpSession } from './mcp-session.js';
import {
  UiVerificationCancelledError,
  type ProgressHandler,
  type UiVerificationConfig,
  type UiVerificationOptions,
  type UiVerificationResult,
} from './types.js';

const UI_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;

export class UiVerificationAdapter {
  public async verifyUi(
    options: UiVerificationOptions,
    config: Required<UiVerificationConfig>,
    onProgress: ProgressHandler
  ): Promise<UiVerificationResult> {
    const bundleName = this.resolveBundleName(options.bundleName);
    const toolProvider = await ToolProvider.new();
    const device = await resolveUiVerificationDevice(
      toolProvider,
      options.device
    );
    const controller = new AbortController();
    const onInterrupt = (): void =>
      controller.abort(new UiVerificationCancelledError('SIGINT'));
    const onTerminate = (): void =>
      controller.abort(new UiVerificationCancelledError('SIGTERM'));
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    let session: UiVerificationMcpSession | undefined;
    try {
      session = await this.startSession(
        config,
        toolProvider.hdcPath,
        controller.signal
      );
      const raw = await session.callTool(
        'verifyUI',
        {
          testPlan: options.testPlan,
          bundleName,
          freshStart: options.freshStart,
          device,
        },
        onProgress,
        UI_VERIFICATION_TIMEOUT_MS
      );
      const result = this.parseVerifyResult(raw);
      await this.cacheArtifacts(session, result.id, controller.signal);
      controller.signal.throwIfAborted();
      pruneUiVerificationCache();
      return result;
    } finally {
      try {
        await session?.close();
      } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      }
    }
  }

  private startSession(
    config: Required<UiVerificationConfig>,
    hdcPath: string,
    signal: AbortSignal
  ): Promise<UiVerificationMcpSession> {
    return UiVerificationMcpSession.start(
      {
        ...process.env,
        UI_VERIFY_BASE_URL: config.baseUrl,
        UI_VERIFY_API_KEY: config.apiKey,
        UI_VERIFY_MODEL_NAME: config.modelName,
        UI_VERIFY_HDC_PATH: hdcPath,
      },
      signal
    );
  }

  private parseVerifyResult(raw: unknown): UiVerificationResult {
    if (typeof raw === 'object' && raw !== null) {
      return raw as UiVerificationResult;
    }
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as UiVerificationResult;
      } catch {
        throw new Error(raw);
      }
    }
    throw new Error('Failed to parse verifyUI result.');
  }

  private resolveBundleName(bundleName?: string): string {
    if (bundleName) {
      return bundleName;
    }
    try {
      return Project.discover(process.cwd()).getBundleName();
    } catch (cause) {
      throw new Error(
        'Could not resolve bundleName from AppScope/app.json5. Please specify --bundle-name <name>.',
        { cause }
      );
    }
  }

  private async cacheArtifacts(
    session: UiVerificationMcpSession,
    id: string,
    signal: AbortSignal
  ): Promise<void> {
    const entryDir = path.join(UI_VERIFICATION_CACHE_DIR, id);
    const screenshotDir = path.join(entryDir, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    try {
      const log = await session.callTool('getLog', { id, maxLogSize: -1 });
      fs.writeFileSync(path.join(entryDir, 'verify.log'), String(log), 'utf8');
    } catch {
      signal.throwIfAborted();
    }
    try {
      await session.callTool('saveScreenshot', { id, dirname: screenshotDir });
    } catch {
      signal.throwIfAborted();
    }
  }
}
