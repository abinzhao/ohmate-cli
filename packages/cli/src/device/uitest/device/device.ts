/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { stat } from 'node:fs/promises';
import { HdcResult, parseFportList, parseProcessList, type ExecOptions, type FportEntry, type ProcessEntry } from '../transport/base-hdc-executor.js';
import type { HdcExecutor } from '../transport/base-hdc-executor.js';
import { DeviceError, DeviceFileError } from '../common/errors.js';
import { getFreeForwardPort } from '../common/utils/net.js';
import {
  shellJoin,
  assertShellLine,
  assertRemotePath,
  assertPid,
  assertDeviceEndpoint,
  assertHostPort,
} from '../common/utils/shell-escape.js';
import { probeUitest, type UitestInfo } from './uitest/uitest-probe.js';
import { UitestResourceManager } from './uitest/resource-manager.js';
import { FastModeStore } from './fast-mode-store.js';
import { UiTestRpc } from '../rpc/operate-rpc.js';
import { UiTestDriver } from '../uitest/driver.js';
import { BaseRpc } from '../rpc/base-rpc.js';
import type { RequestOptions } from '../rpc/base-rpc.js';
import { HMDeviceManager } from './device-manager.js';
import type { Config, ConfigOverrides } from '../common/config.js';
import type { Logger } from '../common/logger.js';
import type { Dfx } from '../common/dfx.js';

/** Minimum UiTest agent version supporting the new RPC protocol */
const DEFAULT_NEW_UITEST_MIN_VERSION = '6' + '.0.2.2';

export interface HMDeviceCreateOptions {
  serial?: string;
  mode?: string;
  config?: Config | ConfigOverrides;
  queryVersion?: boolean;
}

export interface DeviceOptions {
  serial: string;
  executor: HdcExecutor;
  config: Config;
  logger?: Logger | null;
  dfx?: Dfx | null;
  rpcMode?: string;
}

export interface GetFreeHostPortOptions {
  exclude?: number[];
  start?: number;
  end?: number;
}

export interface GetFreeDevicePortOptions {
  start?: number;
  end?: number;
  exclude?: Set<number>;
}

export type RpcFactory = (device: HMDevice) => BaseRpc;

const BUILTIN_RPC_FACTORIES: Record<string, RpcFactory> = {
  uitest: (device: HMDevice) =>
    new UiTestRpc({
      device,
      config: device.config,
      logger: device.logger,
      dfx: device.dfx,
      mode: device.rpcMode,
    }),
};

export class HMDevice {
  serial: string;
  executor: HdcExecutor;
  config: Config;
  logger: Logger | null;
  dfx: Dfx | null;
  hdcHost: string;
  hdcPort: number;
  execTimeoutMs: number;
  rpcMode: string;
  _uitestInfo: UitestInfo | null;
  fportList: FportEntry[];
  resources: UitestResourceManager;
  fastStore: FastModeStore;
  _rpcs: Map<string, BaseRpc>;
  _rpcFactories: Map<string, RpcFactory>;
  _uitestDriver: UiTestDriver | null = null;
  file: DeviceFileApi;
  fport: DeviceFportApi;
  proc: DeviceProcApi;

  constructor({ serial, executor, config, logger, dfx, rpcMode }: DeviceOptions) {
    this.serial = serial;
    this.executor = executor;
    this.config = config;
    this.logger = logger ?? null;
    this.dfx = dfx ? dfx.child({ sn: serial }) : null;
    this.hdcHost = config.get('hdc.host', '127.0.0.1');
    this.hdcPort = config.get('hdc.port', 8710);
    this.execTimeoutMs = config.get('hdc.execTimeoutMs', 10000);
    this.rpcMode = rpcMode || config.get('rpc.mode', 'stable');
    this._uitestInfo = null;
    this.fportList = [];

    this.resources = new UitestResourceManager({ device: this, config, logger: this.logger, dfx: this.dfx });
    this.fastStore = new FastModeStore({ config, logger: this.logger });

    this._rpcs = new Map();
    this._rpcFactories = new Map(Object.entries(BUILTIN_RPC_FACTORIES));

    this.file = new DeviceFileApi(this);
    this.fport = new DeviceFportApi(this);
    this.proc = new DeviceProcApi(this);
  }

  /** Whether the hdc server is on a remote host (determines free port detection method) */
  get isRemoteHdcServer(): boolean {
    return !!this.hdcHost && this.hdcHost !== '127.0.0.1' && this.hdcHost !== 'localhost';
  }

  /** hdc server address identifier (written to fast mode cache for cross-session identification of the same server) */
  get hdcServer(): string {
    return `${this.hdcHost || '127.0.0.1'}:${this.hdcPort ?? 8710}`;
  }

  /* ====================== Command Execution ====================== */

  async exec(subArgs: string[], opts: ExecOptions = {}): Promise<HdcResult> {
    const args = ['-t', this.serial, ...subArgs];
    const result = await this.executor.exec(args, {
      timeoutMs: opts.timeoutMs ?? this.execTimeoutMs,
    });
    if (this.logger) {
      this.logger.debug(`hdc ${args.join(' ')} -> ${result.code}`);
    }
    return result;
  }

  async shell(cmd: string, opts: ExecOptions = {}): Promise<string> {
    assertShellLine(cmd);
    const result = await this.exec(['shell', cmd], opts);
    return result.stdout;
  }

  async shellArgs(argv: (string | number)[], opts: ExecOptions = {}): Promise<string> {
    return this.shell(shellJoin(argv), opts);
  }

  /* ====================== File Capabilities ====================== */

  async fileSend(localPath: string, remotePath: string, opts: ExecOptions = {}): Promise<boolean> {
    assertRemotePath(remotePath);
    await assertLocalFileExists(localPath);
    const result = await this.exec(['file', 'send', localPath, remotePath], opts);
    const ok = result.ok && result.stdout.includes('FileTransfer finish');
    if (!ok) {
      throw new DeviceFileError(`push ${localPath} -> ${remotePath} failed: ${result.stderr || result.stdout}`, {
        details: { localPath, remotePath },
      });
    }
    if (this.dfx) {
      this.dfx.counter('device.file.send', 1);
    }
    return true;
  }

  async fileRecv(remotePath: string, localPath: string, opts: ExecOptions = {}): Promise<boolean> {
    assertRemotePath(remotePath);
    if (!(await this.fileExists(remotePath))) {
      throw new DeviceFileError(`remote file does not exist: ${remotePath}`);
    }
    const result = await this.exec(['file', 'recv', remotePath, localPath], opts);
    const ok = result.ok && result.stdout.includes('FileTransfer finish');
    if (!ok) {
      throw new DeviceFileError(`pull ${remotePath} -> ${localPath} failed: ${result.stderr || result.stdout}`, {
        details: { localPath, remotePath },
      });
    }
    if (this.dfx) {
      this.dfx.counter('device.file.recv', 1);
    }
    return true;
  }

  async fileExists(remotePath: string): Promise<boolean> {
    assertRemotePath(remotePath);
    const out = await this.shellArgs(['ls', '-ld', remotePath]);
    return !!out && !out.includes('No such file or directory');
  }

  async isDirectory(remotePath: string): Promise<boolean> {
    assertRemotePath(remotePath);
    const out = await this.shellArgs(['ls', '-ld', remotePath]);
    return !!out && out.startsWith('d') && !out.includes('No such file or directory');
  }

  async rm(remotePath: string, { force = true }: { force?: boolean } = {}): Promise<boolean> {
    assertRemotePath(remotePath);
    await this.shellArgs(force ? ['rm', '-f', remotePath] : ['rm', remotePath]);
    return true;
  }

  async mkdir(remotePath: string): Promise<boolean> {
    assertRemotePath(remotePath);
    await this.shellArgs(['mkdir', '-p', remotePath]);
    return true;
  }

  async readRemoteText(remotePath: string): Promise<string> {
    assertRemotePath(remotePath);
    const out = await this.shellArgs(['cat', remotePath]);
    if (out.includes('No such file or directory')) {
      throw new DeviceFileError(`remote file does not exist: ${remotePath}`);
    }
    return out;
  }

  async listDir(remotePath: string = '/data/local/tmp'): Promise<string[]> {
    assertRemotePath(remotePath);
    const out = await this.shellArgs(['ls', remotePath]);
    if (out.includes('No such file or directory')) {
      return [];
    }
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /* ====================== Port Forwarding ====================== */

  async fportAdd(hostPort: number, deviceEndpoint: string): Promise<boolean> {
    assertHostPort(hostPort);
    assertDeviceEndpoint(deviceEndpoint);
    const result = await this.exec(['fport', `tcp:${hostPort}`, deviceEndpoint]);
    const ok = result.ok && (result.stdout.includes('result:OK') || result.stdout.toLowerCase().includes('success'));
    if (ok) {
      const entry = { hostPort, deviceEndpoint, taskString: `tcp:${hostPort} ${deviceEndpoint}` };
      if (!this.fportList.some((e) => e.hostPort === hostPort)) {
        this.fportList.push(entry);
      }
      if (this.dfx) {
        this.dfx.counter('device.fport.add', 1);
      }
    }
    return ok;
  }

  async fportRemove(hostPort: number, deviceEndpoint?: string): Promise<boolean> {
    assertHostPort(hostPort);
    if (deviceEndpoint) {
      assertDeviceEndpoint(deviceEndpoint);
    }
    const result = await this.exec(
      deviceEndpoint ? ['fport', 'rm', `tcp:${hostPort}`, deviceEndpoint] : ['fport', 'rm', `tcp:${hostPort}`],
    );
    // hdc fport rm success output: "Remove forward ruler success, ruler:tcp:PORT tcp:ENDPOINT"
    // Some hdc versions output "result:OK" instead
    const ok = result.ok && (result.stdout.includes('result:OK') || result.stdout.toLowerCase().includes('success'));
    if (ok) {
      this.fportList = this.fportList.filter((e) => e.hostPort !== hostPort);
      if (this.dfx) {
        this.dfx.counter('device.fport.remove', 1);
      }
    }
    return ok;
  }

  async fportListAll(): Promise<FportEntry[]> {
    const result = await this.exec(['fport', 'ls']);
    return parseFportList(result.stdout);
  }

  async getFreeHostPort(options: GetFreeHostPortOptions = {}): Promise<number> {
    const range = this.config.get('rpc.portRange', { start: 10000, end: 19999 });
    const exclude = new Set([...this.fportList.map((e) => e.hostPort), ...(options.exclude || [])]);
    const { port } = await getFreeForwardPort({
      hdcHost: this.hdcHost,
      start: options.start ?? range.start,
      end: options.end ?? range.end,
      exclude,
    });
    return port;
  }

  async getFreeDevicePort({ start = 40000, end = 49999, exclude }: GetFreeDevicePortOptions = {}): Promise<number> {
    const out = await this.shell('cat /proc/net/tcp /proc/net/tcp6 2>/dev/null');
    const used = new Set(exclude || []);
    for (const line of String(out).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      if (!local || !local.includes(':')) {
        continue;
      }
      const hexPort = local.split(':')[1];
      const port = parseInt(hexPort, 16);
      if (Number.isInteger(port)) {
        used.add(port);
      }
    }
    for (let port = start; port <= end; port++) {
      if (!used.has(port)) {
        return port;
      }
    }
    throw new DeviceError(`no free device port in range ${start}-${end}`);
  }

  /* ====================== Process Capabilities ====================== */

  async findProcesses(): Promise<ProcessEntry[]> {
    const out = await this.shellArgs(['ps', '-ef']);
    return parseProcessList(out);
  }

  async killProcess(pid: number): Promise<boolean> {
    const safePid = assertPid(pid);
    await this.shellArgs(['kill', '-9', safePid]);
    if (this.dfx) {
      this.dfx.counter('device.process.kill', 1);
    }
    return true;
  }

  /* ====================== Device Information ====================== */

  async getUitestInfo(force: boolean = false): Promise<UitestInfo> {
    if (this._uitestInfo && !force) {
      return this._uitestInfo;
    }
    const info = await probeUitest(this, {
      minVersion: this.config.get('device.newUiTestMinVersion', DEFAULT_NEW_UITEST_MIN_VERSION),
    });
    this._uitestInfo = {
      version: info.version,
      arch: info.arch,
      isNewUiTest: info.isNewUiTest,
      endpointStyle: info.endpointStyle,
    };
    if (this.logger) {
      this.logger.info(
        `uitest info: version=${info.version} arch=${info.arch} endpointStyle=${info.endpointStyle}`,
      );
    }
    return this._uitestInfo;
  }

  async getEndpointStyle(): Promise<'unix' | 'tcp'> {
    if (!this._uitestInfo) {
      await this.getUitestInfo();
    }
    return (this._uitestInfo as UitestInfo).endpointStyle;
  }

  async getSystemProp(keys: string[]): Promise<string> {
    const candidates: Array<{ bin: string; key: string }> = keys.map((k) => ({ bin: 'getprop', key: k }));
    for (const k of keys) {
      const constKey = k.startsWith('ro.') ? `const.${k.slice(3)}` : k;
      candidates.push({ bin: 'param', key: constKey });
    }
    for (const { bin, key } of candidates) {
      try {
        const out = (await this.shellArgs([bin, 'get', key])).trim();
        if (!out || /fail|inaccessible|not found|Get parameter/i.test(out)) {
          continue;
        }
        return out;
      } catch {
        /* Try next method */
      }
    }
    return '';
  }

  async getInfo(): Promise<{ serial: string; model: string; abi: string; version: string; arch: string; isNewUiTest: boolean; endpointStyle: 'unix' | 'tcp' }> {
    const [model, abi, uitest] = await Promise.all([
      this.getSystemProp(['ro.product.model', 'const.product.model']),
      this.getSystemProp(['ro.product.cpu.abi', 'const.product.cpu.abilist']),
      this.getUitestInfo(),
    ]);
    return { serial: this.serial, model, abi, ...uitest };
  }

  /* ====================== RPC Attachment ====================== */

  attachRpc(name: string, factory: RpcFactory): this {
    if (typeof factory !== 'function') {
      throw new DeviceError(`attachRpc(${name}) expects a factory function`);
    }
    this._rpcFactories.set(name, factory);
    this._rpcs.delete(name);
    return this;
  }

  rpc(name: string): BaseRpc {
    const cached = this._rpcs.get(name);
    if (cached) {
      return cached;
    }
    const factory = this._rpcFactories.get(name);
    if (!factory) {
      throw new DeviceError(`rpc module "${name}" is not attached, available: [${[...this._rpcFactories.keys()].join(', ')}]`);
    }
    const instance = factory(this);
    this._rpcs.set(name, instance);
    if (this.logger) {
      this.logger.debug(`rpc attached: ${name} -> ${instance.name}`);
    }
    return instance;
  }

  get uitestRpc(): UiTestRpc {
    return this.rpc('uitest') as UiTestRpc;
  }

  /** uitest high-level facade (controls/windows/gestures), cached for reuse, released with device */
  get uitest(): UiTestDriver {
    if (!this._uitestDriver) {
      this._uitestDriver = new UiTestDriver(this.uitestRpc, {
        shell: (cmd) => this.shell(cmd),
        fileRecv: (remote, local) => this.fileRecv(remote, local),
      });
    }
    return this._uitestDriver;
  }

  /* ====================== Static Construction + Convenience Methods ====================== */

  /**
   * One-stop device object creation (main entry point).
   *
   * Internally uses the global singleton HMDeviceManager (default hdc environment):
   *   - Multiple create() calls share the same executor / config / device cache
   *   - create() with different SNs returns different HMDevice instances, each with
   *     its own independent RPC lifecycle
   *
   * To manage multiple remote hdc environments (different host/port), create your own
   * independent manager via `HMDeviceManager.create(...)`, then call getDevice().
   */
  static async create(options: HMDeviceCreateOptions = {}): Promise<HMDevice> {
    const manager = await HMDeviceManager.getDefault({
      config: options.config,
      mode: options.mode,
    });
    if (options.mode) {
      manager.config.set('rpc.mode', options.mode);
    }
    return manager.getDevice(options.serial, {
      queryVersion: options.queryVersion,
      rpcMode: options.mode,
    });
  }

  get operate(): UiTestRpc {
    return this.uitestRpc;
  }

  async call(api: string, thisRef: string = '', args: unknown[] = [], options: RequestOptions = {}): Promise<unknown> {
    return this.uitestRpc.call(api, thisRef, args, options);
  }

  getSnapshot(): Record<string, unknown> {
    return {
      serial: this.serial,
      mode: this.rpcMode,
      rpcs: this.listRpcs(),
      uitest: this.listRpcs().includes('uitest') ? this.uitestRpc.getSnapshot() : null,
    };
  }

  listRpcs(): string[] {
    return [...this._rpcs.keys()];
  }

  async releaseRpc(name?: string): Promise<void> {
    const targets = name ? [name] : [...this._rpcs.keys()];
    for (const key of targets) {
      const instance = this._rpcs.get(key);
      if (!instance) {
        continue;
      }
      await instance.release();
      this._rpcs.delete(key);
    }
    if (!name && this._uitestDriver) {
      await this._uitestDriver.release();
      this._uitestDriver = null;
    }
  }

  async disposeRpc(name?: string): Promise<void> {
    const targets = name ? [name] : [...this._rpcFactories.keys()];
    for (const key of targets) {
      const instance = this._rpcs.get(key) || this.rpc(key);
      if (instance) {
        await instance.dispose();
      }
      this._rpcs.delete(key);
    }
    if (!name && this._uitestDriver) {
      await this._uitestDriver.release();
      this._uitestDriver = null;
    }
  }

  /* ====================== Release ====================== */

  async release(): Promise<void> {
    await this.releaseRpc();
  }

  async dispose(): Promise<void> {
    await this.disposeRpc();
    await this._clearFports();
  }

  async _clearFports(): Promise<void> {
    for (const entry of [...this.fportList]) {
      try {
        await this.fportRemove(entry.hostPort, entry.deviceEndpoint);
      } catch {
        /* Do not throw errors during release phase */
      }
    }
    this.fportList = [];
  }

  toString(): string {
    return `HMDevice(${this.serial})`;
  }
}

class DeviceFileApi {
  device: HMDevice;

  constructor(device: HMDevice) {
    this.device = device;
  }
  push(localPath: string, remotePath: string, opts?: ExecOptions): Promise<boolean> {
    return this.device.fileSend(localPath, remotePath, opts);
  }
  pull(remotePath: string, localPath: string, opts?: ExecOptions): Promise<boolean> {
    return this.device.fileRecv(remotePath, localPath, opts);
  }
  exists(remotePath: string): Promise<boolean> {
    return this.device.fileExists(remotePath);
  }
  isDir(remotePath: string): Promise<boolean> {
    return this.device.isDirectory(remotePath);
  }
  remove(remotePath: string, opts?: { force?: boolean }): Promise<boolean> {
    return this.device.rm(remotePath, opts);
  }
  mkdir(remotePath: string): Promise<boolean> {
    return this.device.mkdir(remotePath);
  }
  readText(remotePath: string): Promise<string> {
    return this.device.readRemoteText(remotePath);
  }
  list(remotePath: string): Promise<string[]> {
    return this.device.listDir(remotePath);
  }
}

class DeviceFportApi {
  device: HMDevice;

  constructor(device: HMDevice) {
    this.device = device;
  }
  add(hostPort: number, deviceEndpoint: string): Promise<boolean> {
    return this.device.fportAdd(hostPort, deviceEndpoint);
  }
  remove(hostPort: number, deviceEndpoint?: string): Promise<boolean> {
    return this.device.fportRemove(hostPort, deviceEndpoint);
  }
  list(): Promise<FportEntry[]> {
    return this.device.fportListAll();
  }
  freeHostPort(): Promise<number> {
    return this.device.getFreeHostPort();
  }
}

class DeviceProcApi {
  device: HMDevice;

  constructor(device: HMDevice) {
    this.device = device;
  }
  list(): Promise<ProcessEntry[]> {
    return this.device.findProcesses();
  }
  kill(pid: number): Promise<boolean> {
    return this.device.killProcess(pid);
  }
  async find(keyword: string): Promise<ProcessEntry[]> {
    const all = await this.device.findProcesses();
    return all.filter((p) => p.cmd.includes(keyword));
  }
}

async function assertLocalFileExists(localPath: string): Promise<void> {
  try {
    const s = await stat(localPath);
    if (!s.isFile()) {
      throw new Error('not a file');
    }
  } catch (err) {
    throw new DeviceError(`local file does not exist: ${localPath}`, { cause: err as Error });
  }
}
