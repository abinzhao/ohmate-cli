/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { TraceError } from '../trace/index.js';
import {
  SmokeStatus,
  type SmokeExecuteContext,
  type SmokeVerdict,
} from './types.js';

export class SmokeFormatter {
  public formatPass(verdict: SmokeVerdict): string {
    if (verdict.evidence.processCheckSkipped) {
      return 'Smoke: PASS (process check unavailable, smoke skipped)';
    }
    return verdict.evidence.phashBlank === null
      ? 'Smoke: PASS (screenshot unavailable, blank check skipped)'
      : 'Smoke: PASS';
  }

  public formatFailure(
    verdict: SmokeVerdict,
    ctx: SmokeExecuteContext
  ): string {
    const { status, reason, evidence } = verdict;
    const lines = [
      `Smoke: ${status}`,
      `${reason} (bundle=${ctx.bundleName}, device=${ctx.targetDeviceId}).`,
    ];
    if (status === SmokeStatus.FAIL_CRASH && evidence.crashLogPath) {
      lines.push(`crash_log: ${evidence.crashLogPath}`);
    }
    if (status === SmokeStatus.FAIL_BLANK && evidence.screenshotPath) {
      lines.push(`screenshot: ${evidence.screenshotPath}`);
    }
    return lines.join('\n');
  }

  public toTraceError(
    verdict: SmokeVerdict,
    ctx: SmokeExecuteContext
  ): TraceError {
    return new TraceError(this.formatFailure(verdict, ctx), verdict.status);
  }
}
