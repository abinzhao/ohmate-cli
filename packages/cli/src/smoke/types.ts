/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ToolProvider } from '../toolchain/index.js';
import type { HdcAdapter } from '../utils/hdc-adapter.js';

export enum SmokeStatus {
  PASS = 'PASS',
  FAIL_CRASH = 'FAIL_CRASH',
  FAIL_BLANK = 'FAIL_BLANK',
}

export type SmokeContext = {
  toolProvider: ToolProvider;
  projectRoot: string;
  targetDeviceId: string;
  bundleName: string;
  hdcAdapter?: HdcAdapter;
  screenshotDir?: string;
};

/** Per-run fields needed by inspector / formatter (subset of SmokeContext). */
export type SmokeExecuteContext = Pick<
  SmokeContext,
  'targetDeviceId' | 'bundleName' | 'screenshotDir'
>;

export type SmokeEvidence = {
  processAlive: boolean;
  phashBlank: boolean | null;
  phash?: string;
  phashHamming?: number | null;
  screenshotPath?: string;
  /** Absolute path to written crash log file (FAIL_CRASH). */
  crashLogPath?: string;
  screenshotSkipped?: boolean;
  /** pidof query failed (transport/unknown); crash detection was conservatively skipped. */
  processCheckSkipped?: boolean;
};

export type SmokeVerdict = {
  status: SmokeStatus;
  passed: boolean;
  reason: string;
  evidence: SmokeEvidence;
};
