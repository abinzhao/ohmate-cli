/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { tryGetHdcShellParams } from '../utils/hdc-param.js';
import { debugLog } from '../utils/logger.js';
import { TraceError } from '../trace/index.js';

/**
 * `hdc list targets` shows local emulators as `127.0.0.1:<port>`. This is the
 * single source of truth for that classification.
 */
export function isLocalEmulatorSerial(serial: string): boolean {
  return serial.startsWith('127.0.0.1:');
}


export interface DeviceInfo {
  serial: string;
  status: string;
  deviceType?: string;
  osVersion?: string;
}


export interface ConnectedDeviceEntry {
  serial: string;
  name?: string;
  isEmulator: boolean;
  deviceType?: string;
}

/** Batched params we always pull when building a display name + entry. */
const ENTRY_PARAM_KEYS = [
  'ohos.qemu.hvd.name',
  'const.product.name',
  'const.product.model',
  'const.product.brand',
  'const.product.devicetype',
  'const.build.product',
] as const;

export class DeviceManager {
  private hdcPath: string;

  private constructor(hdcPath: string) {
    this.hdcPath = hdcPath;
  }

  public static from(toolProvider: ToolProvider): DeviceManager {
    return new DeviceManager(toolProvider.hdcPath);
  }


  public static withHdcPath(hdcPath: string): DeviceManager {
    return new DeviceManager(hdcPath);
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private stripBrandPrefix(name: string, brand?: string): string {
    const trimmedName = name.trim();
    const trimmedBrand = brand?.trim();
    if (!trimmedName || !trimmedBrand) {
      return trimmedName;
    }
    const prefix = new RegExp(
      `^${this.escapeRegExp(trimmedBrand)}(\\s+|[-_]+)?`,
      'i'
    );
    const stripped = trimmedName.replace(prefix, '').trim();
    return stripped || trimmedName;
  }

  private async executeHdc(
    args: string[], signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    return execa(this.hdcPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { cancelSignal: signal, timeout: 5000 } : {}),
    });
  }

  /** Run `hdc list targets` and parse the rows; never throws on `[Empty]`. */
  public async listDevices(signal?: AbortSignal): Promise<DeviceInfo[]> {
    const { stdout } = await this.executeHdc(['list', 'targets'], signal);
    const devices: DeviceInfo[] = [];

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[Empty]')) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      const serial = parts[0];
      if (!serial || serial.startsWith('[Empty]')) {
        continue;
      }
      const status = parts.length >= 2 ? parts[1] : 'device';
      // 未授权设备无法执行任何 hdc shell 操作，统一过滤
      if (status.toLowerCase() === 'unauthorized') {
        debugLog(`[DeviceManager] Skipping unauthorized device: ${serial}`);
        continue;
      }
      devices.push({ serial, status });
    }

    return devices;
  }


  private extractDisplayName(params: Map<string, string>): string | undefined {
    const hvd = params.get('ohos.qemu.hvd.name');
    if (hvd) {
      return hvd;
    }
    const productName = params.get('const.product.name');
    if (productName && productName !== 'emulator') {
      return productName;
    }
    const productModel = params.get('const.product.model');
    if (productModel && productModel !== 'emulator') {
      const brand = params.get('const.product.brand');
      return this.stripBrandPrefix(productModel, brand);
    }
    const buildProduct = params.get('const.build.product');
    if (buildProduct && buildProduct !== 'emulator') {
      return buildProduct;
    }
    return undefined;
  }

  /**
   * Fetch a display name for one device. Returns `serial` as the last-resort
   * fallback so callers always get something printable.
   */
  public async getDeviceName(serial: string): Promise<string> {
    const params = await tryGetHdcShellParams(this.hdcPath, serial, [
      ...ENTRY_PARAM_KEYS,
    ]);
    return this.extractDisplayName(params) ?? serial;
  }

  public async getDeviceInfo(
    devices: DeviceInfo[],
    deviceSelector?: string
  ): Promise<DeviceInfo | null> {
    if (devices.length === 0) {
      return null;
    }

    if (deviceSelector) {
      const bySerial = devices.find((d) => d.serial === deviceSelector);
      if (bySerial) {
        return bySerial;
      }

      const needle = deviceSelector.toLowerCase();
      const matches: { device: DeviceInfo; name: string }[] = [];
      for (const d of devices) {
        const name = await this.getDeviceName(d.serial);
        if (name.toLowerCase() === needle) {
          matches.push({ device: d, name });
        }
      }

      if (matches.length === 1) {
        return matches[0].device;
      }
      if (matches.length > 1) {
        throw new TraceError(
          `Multiple devices match "${deviceSelector}". Use a serial instead:\n` +
            matches.map((m) => `  - ${m.name} (${m.device.serial})`).join('\n'),
          'Multiple devices match.'
        );
      }

      throw new TraceError(
        `Device "${deviceSelector}" not found. Use \`devecocli device list\` to see available targets.`,
        'Device not found.'
      );
    }

    return devices[0];
  }

  public async getDeviceDetail(serial: string): Promise<DeviceInfo> {
    const detail: DeviceInfo = { serial, status: 'device' };
    try {
      const params = await tryGetHdcShellParams(this.hdcPath, serial, [
        'const.product.devicetype',
        'const.ohos.apiversion',
        'const.ohos.releasetype',
      ]);
      detail.deviceType = params.get('const.product.devicetype');
      const apiVer = params.get('const.ohos.apiversion');
      const relType = params.get('const.ohos.releasetype');
      if (apiVer) {
        detail.osVersion = relType
          ? `API ${apiVer} (${relType})`
          : `API ${apiVer}`;
      }
    } catch {
      // Ignore: partial info is acceptable.
    }
    return detail;
  }

  /** {@link listDevices} + {@link getDeviceName} for each row, in parallel. */
  public async listDevicesWithName(): Promise<
    { serial: string; name: string }[]
  > {
    const devices = await this.listDevices();
    return Promise.all(
      devices.map(async (d) => ({
        serial: d.serial,
        name: await this.getDeviceName(d.serial),
      }))
    );
  }


  public async getConnectedEntries(): Promise<ConnectedDeviceEntry[]> {
    const devices = await this.listDevices();
    return Promise.all(
      devices.map((d) => this.buildConnectedEntry(d.serial))
    );
  }

  private async buildConnectedEntry(
    serial: string
  ): Promise<ConnectedDeviceEntry> {
    const isEmulator = isLocalEmulatorSerial(serial);
    let name: string | undefined;
    let deviceType: string | undefined;
    try {
      const params = await tryGetHdcShellParams(this.hdcPath, serial, [
        ...ENTRY_PARAM_KEYS,
      ]);
      name = this.extractDisplayName(params);
      deviceType = params.get('const.product.devicetype');
    } catch {
      // Keep partial info; serial alone is still useful.
    }
    return { serial, name, isEmulator, deviceType };
  }
}
