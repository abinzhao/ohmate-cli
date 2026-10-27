/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import {
  DeviceManager,
  isLocalEmulatorSerial,
} from '../service/device-manager.js';
import { runHdcWithRetry, tryGetHdcShellParam } from './hdc-param.js';
import { debugLog } from './logger.js';

export { isLocalEmulatorSerial };

function parseBatteryChargingState(output: string): boolean | undefined {
  const match = output
    .normalize('NFKC')
    .match(/^\s*chargingStatus\s*:\s*(\d+)\s*$/im);
  if (!match) {
    return undefined;
  }

  const status = Number(match[1]);
  if (status === 1 || status === 3) {
    return true;
  }
  if (status === 0 || status === 2) {
    return false;
  }
  return undefined;
}

export async function fetchEmulatorSerials(hdcPath: string): Promise<string[]> {
  const devices = await DeviceManager.withHdcPath(hdcPath).listDevices();
  return devices
    .map((d) => d.serial)
    .filter(isLocalEmulatorSerial);
}

export async function fetchRunningEmulatorHvds(
  hdcPath: string
): Promise<string[]> {
  const serials = await fetchEmulatorSerials(hdcPath);
  if (serials.length === 0) {
    return [];
  }
  const hvds = await Promise.all(
    serials.map((serial) =>
      tryGetHdcShellParam(hdcPath, serial, 'ohos.qemu.hvd.name')
    )
  );
  return hvds.filter((hvd): hvd is string => !!hvd);
}

export async function isEmulatorRunningByHdcName(
  hdcPath: string,
  name: string
): Promise<boolean> {
  const hvds = await fetchRunningEmulatorHvds(hdcPath);
  return hvds.includes(name);
}

export async function getEmulatorBatteryChargingState(
  hdcPath: string,
  name: string
): Promise<boolean> {
  const devices =
    await DeviceManager.withHdcPath(hdcPath).listDevicesWithName();
  const nameKey = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const target = devices.find(
    (device) =>
      device.name.normalize('NFKC').replace(/\s+/g, ' ').trim() === nameKey
  );
  if (!target || !isLocalEmulatorSerial(target.serial)) {
    throw new Error(
      `Cannot resolve the running emulator serial for "${name}".`
    );
  }

  const args = [
    '-t',
    target.serial,
    'shell',
    'hidumper',
    '-s',
    '3302',
    '-a',
    '-i',
  ];
  debugLog(`Executing: ${hdcPath} ${args.join(' ')}`);
  const result = await runHdcWithRetry(hdcPath, args);
  if (result.exitCode === 0) {
    const charging = parseBatteryChargingState(result.stdout);
    if (charging !== undefined) {
      return charging;
    }
  }

  throw new Error(
    `Cannot determine the battery charging state for emulator "${name}".`
  );
}
