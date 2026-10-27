/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { hidebug } from '@kit.PerformanceAnalysisKit';

export const PSS_SOURCE_API: string = 'hidebug.getPss';
export const CPU_SOURCE_API: string = 'hidebug.getCpuUsage';

// getPss reads smaps_rollup; keep this call off the UI thread.
@Concurrent
export function readPssBytes(): number {
  const bytes = hidebug.getPss() * BigInt(1024);
  if (bytes < BigInt(0) || bytes > BigInt(Number.MAX_SAFE_INTEGER)) { throw new Error('PSS_SAMPLE_INVALID'); }
  return Number(bytes);
}

// CPU collection is explicit and off the UI thread; no sampling interval is asserted.
@Concurrent
export function readCpuPercent(): number {
  const usage = hidebug.getCpuUsage();
  if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0 || !Number.isFinite(usage * 100)) {
    throw new Error('CPU_SAMPLE_INVALID');
  }
  return usage * 100;
}
