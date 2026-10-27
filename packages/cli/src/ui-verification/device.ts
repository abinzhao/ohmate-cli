/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { HdcAdapter } from '../utils/hdc-adapter.js';
import { ToolProvider } from '../toolchain/index.js';

export async function resolveUiVerificationDevice(
  toolProvider: ToolProvider,
  selector?: string
): Promise<string> {
  const devices = await new HdcAdapter(toolProvider).listTargets();
  if (devices.length === 0) {
    throw new Error(
      'No active devices found. Start an emulator or connect a physical device.'
    );
  }

  if (selector) {
    const needle = selector.toLowerCase();
    const matches = devices.filter(
      (device) =>
        device.id === selector || device.name.toLowerCase().includes(needle)
    );
    if (matches.length === 1) {
      return matches[0].id;
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple devices match '${selector}'. Use a serial instead:\n${formatDevices(matches)}`
      );
    }
    throw new Error(
      `Device '${selector}' not found.\nAvailable devices:\n${formatDevices(devices)}`
    );
  }

  if (devices.length === 1) {
    return devices[0].id;
  }
  throw new Error(
    `Multiple devices connected. Use --device <name|serial> to specify one.\nAvailable devices:\n${formatDevices(devices)}`
  );
}

function formatDevices(
  devices: Array<{ name: string; id: string }>
): string {
  return devices.map((device) => `  - ${device.name} (${device.id})`).join('\n');
}
