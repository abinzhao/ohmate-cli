/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { ToolProvider } from '../../toolchain/index.js';
import {
  DeviceManager,
  isLocalEmulatorSerial,
} from '../../service/device-manager.js';
import { getDeviceList } from '../device-manager.js';
import { debugLog } from '../../utils/logger.js';
import { EnvCheckMessages } from '../../config/signature.js';
import { loginService, getTeamList } from '../../auth/index.js';
import type { CheckResult } from './types.js';
import type { AuthInfo } from '../types.js';

async function resolveDefaultTeamId(userId?: string): Promise<string> {
  try {
    const { teamList } = await getTeamList();
    if (teamList.length > 0) {
      return teamList[0].id;
    }
  } catch (e) {
    debugLog(`[EnvCheck] resolveDefaultTeamId failed: ${(e as Error).message}`);
  }
  return userId ?? '';
}

/**
 * 查询 CPS 云端设备列表，复用 getDeviceList 实现。
 * 未登录或 API 不可用时抛出异常，由调用方处理。
 */
async function fetchCloudDevices(teamId?: string): Promise<Array<{ deviceId: string; deviceName: string }>> {
  const userInfo = await loginService.getUserInfo();
  const token = await loginService.refreshToken();
  if (!userInfo || !token?.accessToken) {
    throw new Error('Not logged in');
  }

  const resolvedTeamId = teamId || await resolveDefaultTeamId(userInfo.userId);
  if (!resolvedTeamId) {
    throw new Error('No team found');
  }

  const auth: AuthInfo = {
    uid: userInfo.userId ?? '',
    teamId: resolvedTeamId,
    accessToken: token.accessToken,
  };

  const devices = await getDeviceList(auth);
  return devices.map((d) => ({
    deviceId: d.udid,
    deviceName: d.deviceName,
  }));
}

export class DeviceChecker {
  constructor(private toolProvider: ToolProvider) {}

  /**
   * 场景 4：检查是否有已连接的设备（真机或模拟器），或 AGC 云端已注册设备。
   * 云端有设备时跳过本地设备检查；无云端设备时回退到本地 hdc 检查。
   */
  async checkDevice(
    fail: (msg: string) => CheckResult,
    teamId?: string
  ): Promise<CheckResult> {
    try {
      // 1) 先查 AGC 云端设备列表
      const cloudDevices = await fetchCloudDevices(teamId);
      if (cloudDevices.length > 0) {
        debugLog(
          `[EnvCheck] Scenario 4 Device check: ${cloudDevices.length} device(s) found in AGC cloud, skipping local device check`
        );
        return { passed: true, message: '' };
      }
      debugLog(`[EnvCheck] Scenario 4 Device check: no cloud devices found, falling back to local hdc`);

      // 2) 云端无设备，回退到本地 hdc 检查
      const deviceManager = DeviceManager.from(this.toolProvider);
      const devices = await deviceManager.listDevices();

      if (devices.length === 0) {
        debugLog(`[EnvCheck] Scenario 4 Device check: no local devices found`);
        return fail(EnvCheckMessages.DEVICE_MISSING);
      }

      const hasEmulator = devices.some((d) =>
        isLocalEmulatorSerial(d.serial)
      );
      if (!hasEmulator) {
        debugLog(`[EnvCheck] Scenario 4 Device check: local device found but not an emulator`);
        return fail(EnvCheckMessages.DEVICE_MISSING);
      }
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Scenario 4 Device check failed: ${(e as Error).message}`);
      return fail(EnvCheckMessages.DEVICE_DETECT_FAILED);
    }
  }
}
