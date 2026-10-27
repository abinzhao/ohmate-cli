/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ToolProvider } from '../toolchain/index.js';
import { HilogAdapter } from './hilog-adapter.js';

/**
 * Resolve the target device serial. Reuses `HilogAdapter.selectDevice`
 * (the repo-wide "multi-device hosts must specify --device" convention:
 * substring name match / exact serial).
 */
export async function resolveDeviceSerial(
  toolProvider: ToolProvider,
  device?: string
): Promise<string> {
  const hilogAdapter = new HilogAdapter(toolProvider);
  const serial = await hilogAdapter.selectDevice(device);
  if (!serial) {
    throw new Error(
      'No device selected. Use `devecocli device list` to see targets.'
    );
  }
  return serial;
}
