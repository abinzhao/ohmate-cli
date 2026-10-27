/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { AuthInfo, DeviceInfo, DevicePageResult } from './types';
import { debuglog } from 'node:util';
import { HttpResponse } from '../types/http';
import { httpClient } from '../utils/http-client';
import {
  SignatureEndpoints,
  SignatureErrorMessages,
  SignatureHttpStatusCode,
  SignatureResponseSignals,
} from '../config/signature';
import { execa } from 'execa';
import { debugLog } from '../utils/logger';

/**
 * 注册设备信息
 *
 * @param auth 用户权限信息
 * @param hdcPath hdc路径
 */
export async function registerDevice(
  auth: AuthInfo,
  hdcPath: string
): Promise<string[]> {
  const cloudDevices = await getDeviceList(auth);
  if (!cloudDevices) {
    throw new Error(SignatureErrorMessages.DEVICE_LIST_EMPTY);
  }

  const localDevices = await fetchDeviceInfo(hdcPath);
  if (cloudDevices.length === 0) {
    for (const device of localDevices) {
      await addSingleDevice(auth, device.udid, device.deviceName);
    }
  } else {
    for (const device of localDevices) {
      await batchAddDevice(auth, cloudDevices, device.udid, device.deviceName);
    }
  }

  const afterAddDevices = await getDeviceList(auth);
  const allDeviceIds = afterAddDevices.map((device) => device.id);

  if (allDeviceIds.length === 0) {
    throw new Error(SignatureErrorMessages.DEVICE_LIST_EMPTY);
  }
  return allDeviceIds;
}

async function addSingleDevice(
  auth: AuthInfo,
  udid: string,
  deviceName: string
): Promise<void> {
  await addDevice(auth, udid, getDeviceType(deviceName));
}

async function batchAddDevice(
  auth: AuthInfo,
  deviceList: DeviceInfo[],
  udid: string,
  deviceName: string
): Promise<void> {
  for (let i = 0; i < deviceList.length; i++) {
    if (udid === deviceList[i].udid) {
      return;
    }
    if (i === deviceList.length - 1) {
      await addDevice(auth, udid, getDeviceType(deviceName));
      return;
    }
  }
  return;
}

function getDeviceType(deviceName: string): string {
  switch (deviceName) {
    case 'liteWearable':
      return '1';
    case 'wearable':
      return '2';
    case 'tv':
      return '3';
    case 'phone':
    default:
      return '4';
  }
}

async function getDevices(
  auth: AuthInfo,
  startPage = 1,
  pageSize = 100
): Promise<DevicePageResult> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.DEVICE_LIST_PATH}?encodeFlag=0&start=${startPage}&pageSize=${pageSize}`;
  const headers = buildHeaders(auth);
  const response: HttpResponse = await httpClient.get(url, { headers });

  if (!response) {
    debuglog('query devices failed: response is null');
    throw new Error(SignatureErrorMessages.ERROR_WHILE_ADD_DEVICE);
  }

  if (response.statusCode !== 200) {
    throw mapCloudDeviceError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }

  const data = JSON.parse(response.data);

  if (!data || !data.list) {
    debuglog('query devices failed: response list is null');
    throw new Error(
      data.ret?.msg || SignatureErrorMessages.ERROR_WHILE_ADD_DEVICE
    );
  }

  return {
    deviceList: data.list,
    total: data.totalCount || 0,
  };
}

/**
 * 云侧错误映射（对齐 AutoSigningConfigsService#responseErrorMessage，并按真实 API 校准）
 * - statusCode 403 + reasonPhrase 精确匹配 Openproxy → 网络错误
 * - statusCode 403（其他，如无 AGC 权限） → 无 AGC 权限
 * - statusCode 401 → 登录失效（真实 reason: getTokenInfo return null）
 * - 响应体含 205389859 → 设备数量上限
 *
 * 报错内容在 HTTP reason phrase（statusText），body 多为空；ret.code 在 body。
 */
function mapCloudDeviceError(
  statusCode: number | undefined,
  reasonPhrase: string,
  body: string
): Error {
  if (statusCode === SignatureHttpStatusCode.FORBIDDEN) {
    if (reasonPhrase === SignatureResponseSignals.OPENPROXY_BLOCKED_URL) {
      return new Error(SignatureErrorMessages.ERR_CERT_NETWORK_ERROR);
    }
    return new Error(SignatureErrorMessages.ERR_FORBIDDEN);
  }
  if (statusCode === SignatureHttpStatusCode.UNAUTHORIZED) {
    return new Error(SignatureErrorMessages.ERR_UNAUTHORIZED);
  }
  if (body.includes(SignatureResponseSignals.DEVICE_EXCEEDS_LIMIT_CODE)) {
    return new Error(SignatureErrorMessages.DEVICE_LIMIT_REACHED);
  }
  return new Error(SignatureErrorMessages.ERROR_WHILE_ADD_DEVICE);
}

export async function getDeviceList(auth: AuthInfo): Promise<DeviceInfo[]> {
  const pageSize = 100;
  const firstPage = await getDevices(auth, 1, pageSize);

  if (
    !firstPage ||
    !firstPage.deviceList ||
    firstPage.deviceList.length === 0
  ) {
    return [];
  }

  const allDevices = [...firstPage.deviceList];
  const totalCount = firstPage.total;
  const pages =
    Math.floor(totalCount / pageSize) + (totalCount % pageSize === 0 ? 0 : 1);

  for (let i = 2; i <= pages; i++) {
    const dto = await getDevices(auth, i, pageSize);
    if (!dto || !dto.deviceList || dto.deviceList.length === 0) {
      break;
    }
    allDevices.push(...dto.deviceList);
  }

  return allDevices;
}

async function addDevice(
  auth: AuthInfo,
  udid: string,
  deviceType: string
): Promise<void> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.DEVICE_ADD_PATH}`;
  const headers = buildHeaders(auth);

  const deviceName = `auto_sign_device_No.${Math.floor(Math.random() * 3000)}${Date.now()}`;
  const body = {
    deviceName,
    udid,
    deviceType,
  };

  const response: HttpResponse = await httpClient.postAllowFailure(url, {
    headers,
    params: body,
  });
  if (!response) {
    debuglog('add device failed: response is null');
    throw new Error(SignatureErrorMessages.ERROR_WHILE_ADD_DEVICE);
  }

  if (response.statusCode !== 200) {
    throw mapCloudDeviceError(
      response.statusCode,
      response.statusText,
      response.data
    );
  }

  const responseStr = response.data;
  const data = JSON.parse(response.data);

  if (!data || !data.ret || data.ret.code !== 0) {
    if (
      responseStr.includes(SignatureResponseSignals.DEVICE_EXCEEDS_LIMIT_CODE)
    ) {
      throw new Error(SignatureErrorMessages.DEVICE_LIMIT_REACHED);
    }

    if (
      responseStr.includes(SignatureResponseSignals.DEVICE_NAME_REPEAT_CODE)
    ) {
      throw new Error(SignatureErrorMessages.DEVICE_NAME_REPEAT);
    }

    throw new Error(SignatureErrorMessages.ERROR_WHILE_ADD_DEVICE);
  }
}

function buildHeaders(auth: AuthInfo): Record<string, string> {
  return {
    uid: auth.uid,
    teamId: auth.teamId,
    oauth2Token: auth.accessToken,
  };
}

async function fetchDeviceInfo(hdcPath: string): Promise<DeviceInfo[]> {
  const { stdout: targetsOut } = await execa(hdcPath, ['list', 'targets'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serials: string[] = [];
  for (const line of targetsOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[Empty]')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const status = parts.length >= 2 ? parts[1] : 'device';
    if (
      serial &&
      !serial.startsWith('[Empty]') &&
      status.toLowerCase() !== 'unauthorized'
    ) {
      serials.push(serial);
    }
  }

  const deviceList: DeviceInfo[] = [];
  for (const serial of serials) {
    try {
      const udid = await getDeviceUdid(serial, hdcPath);
      const deviceName = await coverDeviceType(serial, hdcPath);
      if (udid.length > 0) {
        deviceList.push({ id: '', udid: udid, deviceName: deviceName });
      }
    } catch {
      debugLog(
        `Failed to get device info for ${serial}, skipping`
      );
    }
  }
  return deviceList;
}

async function getDeviceUdid(
  deviceId: string,
  hdcPath: string
): Promise<string> {
  const { stdout } = await execa(
    hdcPath,
    ['-t', deviceId, 'shell', 'bm', 'get', '-u'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    return '';
  }
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('udid of current device is')) {
      const nextLine = lines[i + 1].trim();
      const match = nextLine.match(/^[A-Fa-f0-9]{64}$/);
      if (match) {
        return match[0].toUpperCase();
      }
    }
  }
  const match = trimmed.match(/[A-Fa-f0-9]{64}/);
  return match ? match[0].toUpperCase() : '';
}

async function coverDeviceType(
  deviceId: string,
  hdcPath: string
): Promise<string> {
  const { stdout } = await execa(
    hdcPath,
    ['-c', '-t', deviceId, 'shell', 'getprop', 'hw_sc.build.os.deviceType'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return getDeviceName(stdout);
}

function getDeviceName(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.includes('inaccessible')) {
    return 'phone';
  }
  if (stdout.includes('liteWearable')) {
    return 'liteWearable';
  } else if (stdout.includes('wearable')) {
    return 'wearable';
  } else if (stdout.includes('tv')) {
    return 'tv';
  }
  return 'phone';
}