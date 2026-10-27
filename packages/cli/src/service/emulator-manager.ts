/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import type {
  EmulatorCreateOptions,
  EmulatorInfo,
  EmulatorStartOptions,
} from './emulator-types.js';
import {
  normalizeListNameKey,
  supportsHotBoot,
} from './emulator-types.js';
import {
  spawnEmulatorDetached,
  type EmulatorSpawnHandle,
} from '../utils/emulator-spawn.js';
import { runAllEmulatorStartStrategies } from './emulator-start-strategies.js';
import {
  getEmulatorBatteryChargingState,
  isEmulatorRunningByHdcName,
} from '../utils/emulator-hdc-targets.js';
import { parseEmulatorListOutput } from './emulator-list-parse.js';
import { debugLog } from '../utils/logger.js';
import {
  parseAvailableImageEntriesFromImageList,
  parseDownloadedImageEntriesFromImageList,
  type DownloadedImageEntry,
} from '../utils/emulator-image-list-parse.js';
import { TraceError } from '../trace/index.js';

const EMULATOR_UNINSTALL_NO_IMAGE_RE = /no images are available/i;
const EMULATOR_FOLDED_STATE_ERROR_RE =
  /Scenario simulation failed\s*[：:]/i;
const MIN_CONTROL_EMULATOR_VERSION = '7.0.0';

export type EmulatorControlAction =
  | { type: 'shake' }
  | { type: 'power' }
  | { type: 'rotation'; direction: 'left' | 'right' }
  | { type: 'volume'; direction: 'up' | 'down' }
  | { type: 'folded-state'; state: string }
  | { type: 'battery'; level: number; assumedCharging?: boolean }
  | { type: 'battery-status'; status: 0 | 1 }
  | {
      type: 'gps';
      key: 'longitude' | 'latitude' | 'altitude' | 'bearing';
      value: string;
    }
  | { type: 'outdoor-running' }
  | { type: 'outdoor-cycling' }
  | { type: 'driving-navigation' }
  | {
      type: 'sensor';
      key: 'light' | 'humidity' | 'temperature' | 'steps' | 'heartrate';
      value: number;
    };

function normalizeToken(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function isNoImagesAvailableError(error: unknown): boolean {
  const message = (error as Error).message || '';
  return EMULATOR_UNINSTALL_NO_IMAGE_RE.test(message);
}

function parseFirstVersionText(text: string): string | undefined {
  return text.normalize('NFKC').match(/(\d+(?:\.\d+){1,3})/)?.[1];
}

function commandText(command: string, args: string[]): string {
  return `${command} ${args.join(' ')}`.trim();
}

function formatControlAction(action: EmulatorControlAction): string {
  switch (action.type) {
    case 'gps':
      return `${action.type}:${action.key}=${action.value}`;
    case 'sensor':
      return `${action.type}:${action.key}=${action.value}`;
    case 'rotation':
    case 'volume':
      return `${action.type}:${action.direction}`;
    case 'folded-state':
      return `${action.type}:${action.state}`;
    case 'battery':
      return `${action.type}:${action.level}`;
    case 'battery-status':
      return `${action.type}:${action.status}`;
    default:
      return action.type;
  }
}

export class EmulatorManager {
  private static supportedControlPaths = new Set<string>();
  private emulatorPath: string;
  private sdkPath: string;
  private hdcPath: string;

  private constructor(emulatorPath: string, sdkPath: string, hdcPath: string) {
    this.emulatorPath = emulatorPath;
    this.sdkPath = sdkPath;
    this.hdcPath = hdcPath;
  }

  public static from(toolProvider: ToolProvider): EmulatorManager {
    return new EmulatorManager(
      toolProvider.emulatorPath,
      toolProvider.sdkPath,
      toolProvider.hdcPath
    );
  }

  private async executeEmulator(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    debugLog(`Executing: ${commandText(this.emulatorPath, args)}`);
    return execa(this.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
    });
  }

  private executeEmulatorDetached(args: string[]): EmulatorSpawnHandle {
    return spawnEmulatorDetached(this.emulatorPath, this.sdkPath, args);
  }

  public async listEmulators(instancePath?: string): Promise<EmulatorInfo[]> {
    const args = ['-list', '-details'];
    if (instancePath !== undefined) {
      args.push('-instancePath', instancePath);
    }
    const { stdout } = await this.executeEmulator(args);
    return parseEmulatorListOutput(stdout);
  }

  public async listEmulatorDetails(): Promise<string> {
    const { stdout } = await this.executeEmulator(['-list', '-details']);
    return stdout;
  }

  public async getDeviceTypeByName(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const list = await this.listEmulators();
      for (const e of list) {
        if (e.name && e.deviceType) {
          map.set(normalizeListNameKey(e.name), e.deviceType);
        }
      }
    } catch {
      // Fall back to an empty map; callers treat that as "no override".
    }
    return map;
  }

  public async startEmulator(
    name: string,
    startOptions?: EmulatorStartOptions
  ): Promise<
    | {
        status: 'started';
        args: string[];
        tracker: EmulatorSpawnHandle['tracker'];
      }
    | { status: 'already-running' }
  > {
    const emulators = await this.listEmulators();
    const nameKey = normalizeListNameKey(name);
    const targetEmulator = emulators.find(
      (e) => normalizeListNameKey(e.name) === nameKey
    );

    if (!targetEmulator) {
      throw new TraceError(`Emulator "${name}" not found.`, 'Emulator not found.');
    }

    const listName = targetEmulator.name;

    if (await this.isAlreadyRunning(listName, targetEmulator)) {
      return { status: 'already-running' };
    }

    const outcome = await runAllEmulatorStartStrategies(
      listName,
      targetEmulator,
      (args) => this.executeEmulatorDetached(args),
      // Official default: snapshot when the instance was created with Quick
      // Boot, coldboot otherwise; snapshot fallback when details omit it.
      targetEmulator.hotBoot === false ? 'coldboot' : 'snapshot',
      startOptions
    );
    if (outcome.ok) {
      return {
        status: 'started',
        args: outcome.args,
        tracker: outcome.tracker,
      };
    }

    if (await this.isAlreadyRunning(listName)) {
      return { status: 'already-running' };
    }

    throw new TraceError(
      `Unable to start emulator "${name}". All methods failed.\nLast error: ${outcome.lastError.message || 'unknown'}`,
      `Unable to start emulator. All methods failed.\nLast error: ${outcome.lastError.message || 'unknown'}`
    );
  }

  /**
   * `-list -details` isRunning can lag; hdc HVD name confirms a live instance.
   */
  private async isAlreadyRunning(
    name: string,
    cached?: EmulatorInfo
  ): Promise<boolean> {
    if (cached?.isRunning === true) {
      return true;
    }
    if (cached === undefined) {
      const list = await this.listEmulators();
      if (list.find((e) => e.name === name)?.isRunning === true) {
        return true;
      }
    }
    return isEmulatorRunningByHdcName(this.hdcPath, name);
  }

  public async stopEmulator(
    name: string
  ): Promise<'stopped' | 'already-stopped'> {
    const emulators = await this.listEmulators();
    const nameKey = normalizeListNameKey(name);
    const target = emulators.find(
      (e) => normalizeListNameKey(e.name) === nameKey
    );
    if (!target) {
      throw new TraceError(`Emulator "${name}" not found.`, 'Emulator not found.');
    }
    const listName = target.name;
    const running = await this.isAlreadyRunning(listName, target);
    if (!running) {
      return 'already-stopped';
    }
    await this.executeEmulator(['-stop', listName]);
    return 'stopped';
  }

  public async controlEmulator(
    instance: string,
    action: EmulatorControlAction
  ): Promise<void> {
    await this.assertControlCommandSupported();
    const emulators = await this.listEmulators();
    const target = emulators.find((item) => item.name === instance);
    if (!target) {
      throw new TraceError(`Emulator "${instance}" not found.`, 'Emulator instance not found.');
    }
    if (!(await this.isAlreadyRunning(target.name, target))) {
      throw new TraceError(`Emulator "${instance}" is not running.`, 'Emulator instance is not running.');
    }
    if (action.type === 'battery') {
      // When the user explicitly passes --status charging in the same call,
      // trust it for level=0 validation instead of querying the guest battery
      // state — decouples from -batteryStatus → hidumper propagation timing.
      const charging = action.assumedCharging
        ? true
        : await getEmulatorBatteryChargingState(this.hdcPath, target.name);
      if (!charging && action.level === 0) {
        throw new Error(
          'Battery level must be an integer in [1, 100] while the emulator is not charging.'
        );
      }
    }
    const args = this.buildControlArgs(target.name, action);
    debugLog(
      `[EmulatorManager] control ${formatControlAction(action)} -> ${commandText(this.emulatorPath, args)}`
    );
    await this.runEmulatorChecked(args, {
      extraReject:
        action.type === 'folded-state'
          ? [EMULATOR_FOLDED_STATE_ERROR_RE]
          : undefined,
      printOutputOnSuccess: false,
    });
  }

  private async assertControlCommandSupported(): Promise<void> {
    const cacheKey = this.emulatorPath;
    if (EmulatorManager.supportedControlPaths.has(cacheKey)) {
      return;
    }
    const args = ['-version'];
    debugLog(`Executing: ${commandText(this.emulatorPath, args)}`);
    const { stdout, stderr, exitCode } = await execa(this.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
      reject: false,
      maxBuffer: 1024 * 1024,
    });
    const text = [stdout, stderr].filter(Boolean).join('\n').trim();
    const version = parseFirstVersionText(text);
    if (exitCode !== 0 || !version) {
      throw new Error(
        'Emulator scene control commands require Emulator 7.0 or later. Unable to determine the current Emulator version.'
      );
    }
    if (ToolProvider.compareVersion(version, MIN_CONTROL_EMULATOR_VERSION) < 0) {
      throw new Error(
        `Emulator scene control commands require Emulator 7.0 or later. Current Emulator version is ${version}. Please upgrade DevEco Studio or the Emulator SDK.`
      );
    }
    EmulatorManager.supportedControlPaths.add(cacheKey);
  }

  private buildControlArgs(
    instance: string,
    action: EmulatorControlAction
  ): string[] {
    const base = ['-instance', instance];
    switch (action.type) {
      case 'shake':
        return [...base, '-shake'];
      case 'power':
        return [...base, '-power'];
      case 'rotation':
        return [...base, '-rotation', action.direction];
      case 'volume':
        return [...base, '-volume', action.direction];
      case 'folded-state':
        return [...base, '-foldedState', action.state];
      case 'battery':
        return [...base, '-battery', String(action.level)];
      case 'battery-status':
        return [...base, '-batteryStatus', String(action.status)];
      case 'gps':
        return [...base, '-gps', `-${action.key}`, action.value];
      case 'outdoor-running':
        return [...base, '-outdoorRunning'];
      case 'outdoor-cycling':
        return [...base, '-outdoorCycling'];
      case 'driving-navigation':
        return [...base, '-drivingNavigation'];
      case 'sensor':
        return [...base, '-sensor', `-${action.key}`, String(action.value)];
      default:
        throw new Error(`Unknown emulator control action type: ${(action as { type: string }).type}`);
    }
  }

  private async executeEmulatorInherit(args: string[]): Promise<void> {
    debugLog(`Executing: ${commandText(this.emulatorPath, args)}`);
    const { exitCode } = await execa(this.emulatorPath, args, {
      stdio: 'inherit',
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
      reject: false,
    });
    if (exitCode !== 0) {
      throw new Error(
        `Emulator exited with code ${exitCode === null ? 'null' : exitCode}.`
      );
    }
  }

  public async installEmulatorImage(opts: {
    deviceType: string;
    osVersion: string;
    force?: boolean;
  }): Promise<void> {
    const args = [
      '-install',
      '-deviceType',
      opts.deviceType,
      '-osVersion',
      opts.osVersion,
    ];
    if (opts.force) {
      args.push('-force');
    }
    await this.executeEmulatorInherit(args);
  }

  public async hasAvailableEmulatorImage(opts: {
    deviceType: string;
    osVersion: string;
  }): Promise<boolean> {
    const stdout = await this.listEmulatorImages({
      deviceType: opts.deviceType,
    });
    const deviceType = normalizeToken(opts.deviceType);
    const osVersion = normalizeToken(opts.osVersion);
    return parseAvailableImageEntriesFromImageList(stdout).some(
      (entry) =>
        normalizeToken(entry.deviceType) === deviceType &&
        normalizeToken(entry.osVersion) === osVersion
    );
  }

  public async uninstallEmulatorImage(opts: {
    deviceType: string;
    osVersion: string;
  }): Promise<void> {
    const softwareVersions = await this.resolveSoftwareVersionsForUninstall(opts);
    if (softwareVersions.length === 0) {
      throw new Error(
        `No downloaded image matches --os-version "${opts.osVersion}" for --device-type "${opts.deviceType}".`
      );
    }

    let primaryError: unknown;
    try {
      await this.runUninstallImageChecked(opts.deviceType, opts.osVersion);
    } catch (error) {
      if (!isNoImagesAvailableError(error)) {
        throw error;
      }
      primaryError = error;
    }

    const needsFallback =
      primaryError !== undefined ||
      (await this.hasMatchingDownloadedImage(opts));
    if (needsFallback) {
      await this.runSoftwareVersionFallback(
        opts,
        softwareVersions,
        primaryError
      );
    }
  }

  public async listEmulatorImages(opts: {
    deviceType?: string;
    downloaded?: boolean;
  }): Promise<string> {
    const args: string[] = ['-imageList'];
    if (opts.deviceType) {
      args.push('-deviceType', opts.deviceType);
    }
    if (opts.downloaded !== undefined) {
      args.push('-downloaded', opts.downloaded ? 'true' : 'false');
    }
    const { stdout } = await this.executeEmulator(args);
    return stdout;
  }

  private async hasMatchingDownloadedImage(opts: {
    deviceType: string;
    osVersion: string;
  }): Promise<boolean> {
    const matches = await this.findMatchingDownloadedImages(opts);
    return matches.length > 0;
  }

  private async runSoftwareVersionFallback(
    opts: { deviceType: string; osVersion: string },
    softwareVersions: string[],
    primaryError?: unknown
  ): Promise<void> {
    try {
      for (const softwareVersion of softwareVersions) {
        await this.runUninstallImageChecked(opts.deviceType, softwareVersion);
      }
    } catch (fallbackError) {
      const prefix =
        primaryError !== undefined
          ? `Primary uninstall failed: ${(primaryError as Error).message}\n`
          : '';
      throw new Error(
        `${prefix}Fallback uninstall failed: ${(fallbackError as Error).message}`,
        { cause: fallbackError }
      );
    }
    if (await this.hasMatchingDownloadedImage(opts)) {
      throw new Error(
        `Image for --device-type "${opts.deviceType}" and --os-version "${opts.osVersion}" remains listed as downloaded after uninstallation.`
      );
    }
  }

  private async resolveSoftwareVersionsForUninstall(opts: {
    deviceType: string;
    osVersion: string;
  }): Promise<string[]> {
    const matches = await this.findMatchingDownloadedImages(opts);
    return [
      ...new Set(matches.map((entry) => entry.softwareVersion).filter(Boolean)),
    ];
  }

  private async findMatchingDownloadedImages(opts: {
    deviceType: string;
    osVersion: string;
  }): Promise<DownloadedImageEntry[]> {
    const stdout = await this.listEmulatorImages({
      deviceType: opts.deviceType,
      downloaded: true,
    });
    const entries = parseDownloadedImageEntriesFromImageList(stdout);
    const deviceToken = normalizeToken(opts.deviceType);
    const inputToken = normalizeToken(opts.osVersion);
    return entries.filter(
      (entry) =>
        normalizeToken(entry.deviceType) === deviceToken &&
        (normalizeToken(entry.osVersion) === inputToken ||
          normalizeToken(entry.softwareVersion) === inputToken)
    );
  }

  private async runUninstallImageChecked(
    deviceType: string,
    osVersion: string
  ): Promise<void> {
    await this.runEmulatorChecked(
      ['-uninstall', '-deviceType', deviceType, '-osVersion', osVersion, '-force'],
      {
        printOutputOnSuccess: true,
        extraReject: [EMULATOR_UNINSTALL_NO_IMAGE_RE],
      }
    );
  }

  private async runEmulatorChecked(
    args: string[],
    options?: {
      extraReject?: RegExp[];
      printOutputOnSuccess?: boolean;
      transformOutput?: (text: string) => string;
    }
  ): Promise<void> {
    debugLog(`Executing: ${commandText(this.emulatorPath, args)}`);
    const { stdout, stderr, exitCode } = await execa(this.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
      reject: false,
      maxBuffer: 20 * 1024 * 1024,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const baseReject =
      /Invalid command|无效命令|鏃犳晥鍛戒护/i.test(combined) ||
      /please attach the correct parameter/i.test(combined);
    const extraReject = (options?.extraReject ?? []).some((re) =>
      re.test(combined)
    );
    const failed = exitCode !== 0 || baseReject || extraReject;
    if (failed) {
      throw new Error(
        combined ||
          `emulator exited with code ${exitCode === null ? 'null' : exitCode}`
      );
    }
    if (options?.printOutputOnSuccess !== false && combined) {
      const out = (
        options?.transformOutput ? options.transformOutput(combined) : combined
      ).trim();
      if (out) {
        console.log(out);
      }
    }
  }

  private async checkExistingVirtualDevice(
    opts: EmulatorCreateOptions
  ): Promise<string> {
    const emulators = await this.listEmulators(opts.instancePath);
    const nameKey = normalizeListNameKey(opts.name);
    const existing = emulators.find(
      (e) => normalizeListNameKey(e.name) === nameKey
    );
    if (existing) {
      if (opts.force) {
        await this.deleteVirtualDevice(existing.name, opts.instancePath);
      } else {
        throw new TraceError(
          `Emulator "${opts.name}" already exists. Use \`--force\` to overwrite.`,
          'Emulator already exists.'
        );
      }
    }
    return nameKey;
  }

  private buildCreateVirtualDeviceArgs(opts: EmulatorCreateOptions): string[] {
    const args = [
      '-create',
      opts.name,
      '-deviceType',
      opts.deviceType,
      '-osVersion',
      opts.osVersion,
    ];
    if (opts.instancePath !== undefined) {
      args.push('-instancePath', opts.instancePath);
    }
    if (opts.imageRoot !== undefined) {
      args.push('-imageRoot', opts.imageRoot);
    }
    if (opts.screenProfile !== undefined) {
      args.push('-screenProfile', opts.screenProfile);
    }
    if (opts.screen?.length) {
      args.push('-screen', ...opts.screen);
    }
    if (opts.storage !== undefined) {
      args.push('-storage', String(opts.storage));
    }
    if (opts.memory !== undefined) {
      args.push('-memory', String(opts.memory));
    }
    const hotBoot =
      opts.hotBoot ?? (supportsHotBoot(opts.osVersion) ? true : undefined);
    if (hotBoot !== undefined) {
      args.push('-hotBoot', String(hotBoot));
    }
    return args;
  }

  public async createVirtualDevice(opts: EmulatorCreateOptions): Promise<void> {
    const nameKey = await this.checkExistingVirtualDevice(opts);

    const args = this.buildCreateVirtualDeviceArgs(opts);
    await this.runEmulatorChecked(args, {
      extraReject: [
        /Device create fail/i,
        /already exists/i,
        /Invalid OS version/i,
        /cannot be empty/i,
      ],
      printOutputOnSuccess: true,
      transformOutput: (text) =>
        text
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            return trimmed.startsWith('Device create success.')
              ? 'Device create success.'
              : line;
          })
          .join('\n'),
    });

    const created = await this.waitForEmulatorPresenceByList(
      nameKey,
      opts.instancePath
    );
    if (!created) {
      throw new TraceError(
          `Emulator "${opts.name}" was reported as created, but it did not appear in the emulator list within the waiting period. Open the device manager list in DevEco Studio, then run this command again.`,
          'Emulator was reported as created, but it did not appear in the emulator list within the waiting period.'
      );
    }
  }

  private async waitForEmulatorPresenceByList(
    nameKey: string,
    instancePath?: string,
    timeoutMs = 10000,
    intervalMs = 500
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const emulators = await this.listEmulators(instancePath);
      const found = emulators.some(
        (e) => normalizeListNameKey(e.name) === nameKey
      );
      if (found) {
        return true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  public async deleteVirtualDevice(
    userInputName: string,
    instancePath?: string
  ): Promise<string> {
    const emulators = await this.listEmulators(instancePath);
    const nameKey = normalizeListNameKey(userInputName);
    const target = emulators.find(
      (e) => normalizeListNameKey(e.name) === nameKey
    );
    if (!target) {
      throw new TraceError(`Emulator "${userInputName}" not found.`, 'Emulator not found.');
    }
    const listName = target.name;

    if (
      target.isRunning === true ||
      (await this.isAlreadyRunning(listName, target))
    ) {
      throw new TraceError(
        `Failed to delete device: ${listName}\nThe device may be running.`, 
        'Failed to delete device, The device may be running.'
      );
    }

    const args = ['-delete', listName];
    if (instancePath !== undefined) {
      args.push('-instancePath', instancePath);
    }
    args.push('-force');
    await this.runEmulatorChecked(args, {
      printOutputOnSuccess: false,
    });
    return listName;
  }
}
