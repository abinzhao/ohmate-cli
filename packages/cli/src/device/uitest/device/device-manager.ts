/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { HMDevice } from './device.js';
import type { RpcFactory } from './device.js';
import { DeviceNotFoundError } from '../common/errors.js';
import { createConfig, type Config } from '../common/config.js';
import { getLogger, type Logger } from '../common/logger.js';
import { createDfx, type Dfx } from '../common/dfx.js';
import { RealHdcExecutor } from '../transport/hdc-executor.js';
import type { HdcExecutor } from '../transport/base-hdc-executor.js';

export interface DeviceManagerOptions {
  executor: HdcExecutor;
  config: Config;
  logger?: Logger | null;
  dfx?: Dfx | null;
  rpcMode?: string;
}

export interface DeviceManagerCreateOptions {
  config?: Config | Record<string, unknown>;
  mode?: string;
  executor?: HdcExecutor;
  logger?: Logger;
  dfx?: Dfx;
  serial?: string;
}

export interface CreateExecutorArgs {
  config: Config;
  logger: Logger;
  dfx: Dfx;
  executor?: HdcExecutor;
}

export interface GetDeviceOptions {
  queryVersion?: boolean;
  rpcMode?: string;
}

export interface DeviceListItem {
  serial: string;
  cached: boolean;
  model?: string;
  abi?: string;
  uitestVersion?: string;
  endpointStyle?: string;
  error?: string;
}

export function createExecutor({ config, logger, dfx, executor }: CreateExecutorArgs): HdcExecutor {
  if (executor) {
    return executor;
  }
  const options = {
    bin: config.get('hdc.bin', 'hdc'),
    host: config.get('hdc.host', '127.0.0.1'),
    port: config.get('hdc.port', 8710),
    execTimeoutMs: config.get('hdc.execTimeoutMs', 10000),
    logger,
    dfx,
  };
  return new RealHdcExecutor(options);
}

export class HMDeviceManager {
  executor: HdcExecutor;
  config: Config;
  logger: Logger | null;
  dfx: Dfx | null;
  rpcMode: string;
  devices: Map<string, HMDevice>;
  _rpcFactories: Map<string, RpcFactory>;

  constructor({ executor, config, logger, dfx, rpcMode }: DeviceManagerOptions) {
    this.executor = executor;
    this.config = config;
    this.logger = logger ?? null;
    this.dfx = dfx ?? null;
    this.rpcMode = rpcMode || config.get('rpc.mode', 'stable');
    this.devices = new Map();
    this._rpcFactories = new Map();
  }

  static async create(options: DeviceManagerCreateOptions = {}): Promise<HMDeviceManager> {
    const config =
      options.config && typeof (options.config as Config).get === 'function'
        ? (options.config as Config)
        : createConfig((options.config as Record<string, unknown>) || {});
    if (options.mode) {
      config.set('rpc.mode', options.mode);
    }

    const logger = options.logger || getLogger('HMDeviceManager');
    const dfx = options.dfx || createDfx({ logger, tags: { mode: config.get('rpc.mode') } });
    const executor = createExecutor({
      config,
      logger,
      dfx,
      executor: options.executor,
    });
    return new HMDeviceManager({
      executor,
      config,
      logger,
      dfx,
      rpcMode: config.get('rpc.mode', 'stable'),
    });
  }

  /**
   * Global singleton manager (default hdc environment).
   *
   * Created and cached on first call with the given options; subsequent calls reuse the same instance —
   * multiple HMDevice.create() calls share the same executor / config / device cache.
   *
   * Note: options only take effect on first creation. For different remote hdc environments
   * (different host/port), create your own independent manager via `HMDeviceManager.create(...)`,
   * do not reuse the singleton.
   */
  static _default: HMDeviceManager | null = null;

  static async getDefault(options: DeviceManagerCreateOptions = {}): Promise<HMDeviceManager> {
    if (HMDeviceManager._default) {
      return HMDeviceManager._default;
    }
    HMDeviceManager._default = await HMDeviceManager.create(options);
    return HMDeviceManager._default;
  }

  /** Reset the singleton (used for test isolation / switching hdc environments) */
  static resetDefault(): void {
    HMDeviceManager._default = null;
  }

  async listTargets(): Promise<string[]> {
    const end = this.dfx ? this.dfx.timer('device.listTargets') : null;
    const serials = await this.executor.listTargets();
    if (end) {
      end({ count: serials.length });
    }
    if (this.logger) {
      this.logger.info(`list targets -> [${serials.join(', ')}]`);
    }
    return serials;
  }

  async listDevices({ detail = false }: { detail?: boolean } = {}): Promise<DeviceListItem[]> {
    const serials = await this.listTargets();
    const list: DeviceListItem[] = serials.map((serial) => ({ serial, cached: this.devices.has(serial) }));
    if (!detail) {
      return list;
    }

    for (const item of list) {
      try {
        const device = await this.getDevice(item.serial);
        const info = await device.getInfo();
        Object.assign(item, {
          model: info.model,
          abi: info.abi,
          uitestVersion: info.version,
          endpointStyle: info.endpointStyle,
        });
      } catch (err) {
        item.error = (err as Error).message;
      }
    }
    return list;
  }

  async getDevice(serial?: string, options: GetDeviceOptions = {}): Promise<HMDevice> {
    const end = this.dfx ? this.dfx.timer('device.create') : null;
    const serials = await this.listTargets();
    if (!serials.length) {
      throw new DeviceNotFoundError('no device connected');
    }
    let target = serial;
    if (target) {
      if (!serials.includes(target)) {
        throw new DeviceNotFoundError(`device ${target} is not found, connected: [${serials.join(', ')}]`);
      }
    } else if (this.config.get('device.autoSelectFirst', true)) {
      target = serials[0];
    } else {
      throw new DeviceNotFoundError('serial is required when autoSelectFirst is disabled');
    }

    const cached = this.devices.get(target);
    if (cached) {
      if (end) {
        end({ sn: target, reused: 1 });
      }
      return cached;
    }

    const device = new HMDevice({
      serial: target,
      executor: this.executor,
      config: this.config,
      logger: this.logger,
      dfx: this.dfx,
      rpcMode: options.rpcMode || this.rpcMode,
    });

    for (const [name, factory] of this._rpcFactories) {
      device.attachRpc(name, factory);
    }

    const shouldQuery = options.queryVersion ?? this.config.get('device.queryVersion', true);
    if (shouldQuery) {
      await device.getUitestInfo();
    }

    this.devices.set(target, device);
    if (end) {
      end({ sn: target, ok: 1 });
    }
    if (this.dfx) {
      this.dfx.counter('device.create', 1, { sn: target });
    }
    if (this.logger) {
      this.logger.info(`device created: ${target}`);
    }
    return device;
  }

  async createDevice(serial?: string, options: GetDeviceOptions = {}): Promise<HMDevice> {
    return this.getDevice(serial, options);
  }

  async connect(serial?: string, options: GetDeviceOptions = {}): Promise<HMDevice> {
    return this.getDevice(serial, options);
  }

  attachRpc(name: string, factory: RpcFactory): this {
    if (typeof factory !== 'function') {
      throw new DeviceNotFoundError(`attachRpc(${name}) expects a factory function`);
    }
    this._rpcFactories.set(name, factory);
    for (const device of this.devices.values()) {
      device.attachRpc(name, factory);
    }
    return this;
  }

  async removeDevice(serial: string): Promise<boolean> {
    const device = this.devices.get(serial);
    if (!device) {
      return false;
    }
    await device.release();
    this.devices.delete(serial);
    return true;
  }

  async release({ disposeRpc = false }: { disposeRpc?: boolean } = {}): Promise<void> {
    for (const device of this.devices.values()) {
      if (disposeRpc) {
        await device.dispose();
      }
      else {
        await device.release();
      }
    }
    this.devices.clear();
  }

  async dispose(): Promise<void> {
    for (const device of this.devices.values()) {
      await device.dispose();
    }
    this.devices.clear();
  }
}
