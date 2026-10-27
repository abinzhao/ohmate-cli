/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { tryGetHdcShellParams } from '../utils/hdc-param.js';
import { green, cyan, red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { renderTable, type TableRow } from '../utils/text-table.js';
import type {
  EmulatorBootMode,
  EmulatorCreateOptions,
  EmulatorInfo,
  EmulatorStartOptions,
} from '../service/emulator-types.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import {
  EmulatorManager,
  type EmulatorControlAction,
} from '../service/emulator-manager.js';
import {
  DeviceManager,
  isLocalEmulatorSerial,
} from '../service/device-manager.js';
import {
  fetchEmulatorSerials,
  fetchRunningEmulatorHvds,
} from '../utils/emulator-hdc-targets.js';
import {
  ensureEmulatorSdkAgreementForImageDownload,
  ensureEmulatorServiceAgreementConfig,
  runEmulatorLicenseAccept,
  runEmulatorLicenseAcceptDirectly,
  runEmulatorLicenseView,
} from '../utils/emulator-license.js';
import { ToolProvider } from '../toolchain/index.js';
import { formatBytesMb } from '../utils/process-rss.js';
import { telemetry, EventType, toTraceErrorCode, TraceError, type CommandExecuted, type TrackMeasurement } from '../trace/index.js';

async function withEmulatorTrace(
  event: CommandExecuted,
  action: () => Promise<void>
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await action();
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    console.error(red((error as Error).message));
    process.exitCode = 1;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

const SERIAL_PARAM_KEYS = [
  'ohos.qemu.hvd.name',
  'const.product.name',
  'const.product.model',
];

const FOLDED_STATE_VALUES = [
  'open',
  'half-open',
  'close',
  'vertical-open',
  'single',
  'double',
  'triple',
  'left-folded-right-half-folded',
  'left-half-folded-right-expanded',
  'left-expanded-right-folded',
  'left-half-folded-right-folded',
  'left-expanded-right-half-folded',
  'left-half-folded-right-half-folded',
] as const;

const FOLDED_STATE_HELP = `
Folded state scene mappings:
  foldableFold (3):
    open       Fully expanded state
    half-open  Semi-folded state
    close      Fully folded state

  2in1foldableFold (4):
    open           Landscape unfolded state
    vertical-open  Portrait unfolded state
    half-open      Semi-folded state
    close          Magnetic attachment state

  tripleFold (9):
    single
    double
    triple
    left-folded-right-half-folded
    left-half-folded-right-expanded
    left-expanded-right-folded
    left-half-folded-right-folded
    left-expanded-right-half-folded
    left-half-folded-right-half-folded
`;

interface EmulatorTargetOptions {
  target: string;
}

interface BatteryOptions extends EmulatorTargetOptions {
  level?: string;
  status?: 'charging' | 'discharging';
}

interface GeolocationOptions extends EmulatorTargetOptions {
  longitude?: string;
  latitude?: string;
  altitude?: string;
  direction?: string;
}

interface SensorOptions extends EmulatorTargetOptions {
  lightIntensity?: string;
  humidity?: string;
  temperature?: string;
  steps?: string;
  heartrate?: string;
}

/** Emulator CLI 从 Studio 6.1 起完整可用。 */
const MIN_EMULATOR_STUDIO_VERSION = '6.1.0';

function assertTarget(input: string): string {
  const target = input.trim();
  if (!target) {
    throw new Error('--target must not be empty.');
  }
  return target;
}

function parseFoldedState(input: string): string {
  const state = input.trim();
  if (!FOLDED_STATE_VALUES.includes(state as never)) {
    throw new Error(
      `Invalid fold state "${input}". Available values: ${FOLDED_STATE_VALUES.join(', ')}`
    );
  }
  return state;
}

function parseRangeInteger(
  optionName: string,
  input: string,
  min: number,
  max: number
): number {
  const text = input.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${optionName} must be an integer in [${min}, ${max}].`);
  }
  const value = Number(text);
  if (value < min || value > max) {
    throw new Error(`${optionName} must be in [${min}, ${max}].`);
  }
  return value;
}

function parseRangeNumberText(
  optionName: string,
  input: string,
  min: number,
  max: number,
  maxDecimalPlaces?: number
): string {
  const text = input.trim();
  const value = Number(text);
  if (!text || Number.isNaN(value)) {
    throw new Error(`${optionName} must be a number in [${min}, ${max}].`);
  }
  if (maxDecimalPlaces !== undefined && !hasValidDecimalPlaces(text, maxDecimalPlaces)) {
    throw new Error(
      `${optionName} supports at most ${maxDecimalPlaces} decimal place(s).`
    );
  }
  if (value < min || value > max) {
    throw new Error(`${optionName} must be in [${min}, ${max}].`);
  }
  return text;
}

function hasValidDecimalPlaces(input: string, maxDecimalPlaces: number): boolean {
  const decimalPart = input.split('.')[1];
  return decimalPart === undefined || decimalPart.length <= maxDecimalPlaces;
}

function parseRangeNumber(
  optionName: string,
  input: string,
  min: number,
  max: number,
  maxDecimalPlaces?: number
): number {
  return Number(
    parseRangeNumberText(optionName, input, min, max, maxDecimalPlaces)
  );
}

const EMULATOR_LIST_TABLE_HEADERS = [
  'Name',
  'Status',
  'Serial',
  'Device Type',
  'OS Version',
] as const;

type EmulatorListFormat = 'table' | 'json';

interface EmulatorListItem {
  name: string;
  status: 'running' | 'stopped';
  serial: string | null;
  deviceType: string | null;
  osVersion: string | null;
}

interface EmulatorListOptions {
  format: EmulatorListFormat;
  details?: boolean;
}

function buildEmulatorListRow(item: EmulatorListItem): TableRow {
  return {
    cells: [
      item.name,
      item.status,
      item.serial ?? '-',
      item.deviceType ?? '-',
      item.osVersion ?? '-',
    ],
    highlight: item.status === 'running',
  };
}

async function fetchSerialParamsBatched(
  hdcPath: string,
  serials: string[]
): Promise<Map<string, Map<string, string>>> {
  const entries = await Promise.all(
    serials.map(async (serial) => {
      const params = await tryGetHdcShellParams(
        hdcPath,
        serial,
        SERIAL_PARAM_KEYS
      );
      return [serial, params] as const;
    })
  );
  return new Map(entries);
}

async function fetchEmulatorListSnapshot(hdcPath: string): Promise<{
  serials: string[];
  params: Map<string, Map<string, string>>;
}> {
  const serials = await fetchEmulatorSerials(hdcPath);
  const params = await fetchSerialParamsBatched(hdcPath, serials);
  return { serials, params };
}

function tryMatchProductSerial(
  serial: string,
  params: Map<string, string> | undefined,
  unmatchedNames: string[],
  unmatchedSerials: string[],
  productSerialMap: Map<string, string>
): void {
  if (!params) {
    return;
  }
  for (const key of ['const.product.name', 'const.product.model']) {
    const value = params.get(key);
    if (!value) {
      continue;
    }
    const idx = unmatchedNames.indexOf(value);
    if (idx === -1) {
      continue;
    }
    unmatchedNames.splice(idx, 1);
    productSerialMap.set(value, serial);
    const sIdx = unmatchedSerials.indexOf(serial);
    if (sIdx !== -1) {
      unmatchedSerials.splice(sIdx, 1);
    }
    return;
  }
}

/** Pure-function map builder over already-fetched params. */
function buildEmulatorMapsFromParams(
  serials: string[],
  serialParams: Map<string, Map<string, string>>,
  runningEmulatorNames: string[]
): {
  productSerialMap: Map<string, string>;
  hvdSerialMap: Map<string, string>;
} {
  const productSerialMap = new Map<string, string>();
  const hvdSerialMap = new Map<string, string>();
  const unmatchedSerials = [...serials];
  const unmatchedNames = [...runningEmulatorNames];
  for (const serial of serials) {
    const params = serialParams.get(serial);
    const hvd = params?.get('ohos.qemu.hvd.name');
    if (hvd) {
      hvdSerialMap.set(hvd, serial);
    }
    if (runningEmulatorNames.length > 0) {
      tryMatchProductSerial(
        serial,
        params,
        unmatchedNames,
        unmatchedSerials,
        productSerialMap
      );
    }
  }
  for (
    let i = 0;
    i < unmatchedNames.length && i < unmatchedSerials.length;
    i++
  ) {
    productSerialMap.set(unmatchedNames[i], unmatchedSerials[i]);
  }

  return { productSerialMap, hvdSerialMap };
}

interface EnrichedEmulator {
  emu: EmulatorInfo;
  serial: string | undefined;
  effectiveRunning: boolean;
}

function buildSortedEmulatorList(
  emulators: EmulatorInfo[],
  productSerialMap: Map<string, string>,
  hvdSerialMap: Map<string, string>
): EmulatorListItem[] {
  const enriched: EnrichedEmulator[] = emulators.map((emu) => ({
    emu,
    serial: productSerialMap.get(emu.name) ?? hvdSerialMap.get(emu.name),
    effectiveRunning: emu.isRunning === true || hvdSerialMap.has(emu.name),
  }));
  enriched.sort((a, b) => {
    if (a.effectiveRunning !== b.effectiveRunning) {
      return a.effectiveRunning ? -1 : 1;
    }
    return a.emu.name.localeCompare(b.emu.name);
  });
  return enriched.map(({ emu, serial, effectiveRunning }) => ({
    name: emu.name,
    status: effectiveRunning ? 'running' : 'stopped',
    serial: serial ?? null,
    deviceType: emu.deviceType ?? null,
    osVersion: emu.osVersion ?? null,
  }));
}

async function listAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  format: EmulatorListFormat,
  spinner?: Ora
) {
  try {
    const [emulators, hdcSnapshot] = await Promise.all([
      emulatorManager.listEmulators(),
      fetchEmulatorListSnapshot(hdcPath),
    ]);

    if (emulators.length === 0) {
      spinner?.stop();
      if (format === 'json') {
        console.log('[]');
      } else {
        console.log(yellow('  No emulator instances found.'));
      }
      return;
    }

    const runningNames = emulators
      .filter((e) => e.isRunning)
      .map((e) => e.name);
    const { productSerialMap, hvdSerialMap } = buildEmulatorMapsFromParams(
      hdcSnapshot.serials,
      hdcSnapshot.params,
      runningNames
    );

    spinner?.stop();
    const items = buildSortedEmulatorList(
      emulators,
      productSerialMap,
      hvdSerialMap
    );
    if (format === 'json') {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    const rows = items.map(buildEmulatorListRow);
    console.log(renderTable(EMULATOR_LIST_TABLE_HEADERS, rows));
  } catch (error) {
    spinner?.stop();
    throw new Error(`Failed to list emulators: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function reportSettledFailures(
  results: PromiseSettledResult<unknown>[],
  identifiers: string[],
  action: 'start' | 'stop'
): boolean {
  let anyFailed = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== 'rejected') {
      continue;
    }
    anyFailed = true;
    const e = result.reason as Error & { stdout?: string; stderr?: string };
    console.error(
      red(`Failed to ${action} emulator "${identifiers[i]}": ${e.message}`)
    );
    if (e.stdout) {
      console.error(gray(e.stdout));
    }
    if (e.stderr) {
      console.error(gray(e.stderr));
    }
  }
  return anyFailed;
}

const EMULATOR_CONFIRM_POLL_INTERVAL_MS = 2000;
const EMULATOR_CONFIRM_TIMEOUT_MS = 60000;

async function isEmulatorPresentByHdcName(
  hdcPath: string,
  name: string
): Promise<boolean> {
  const targetKey = normalizeListNameKey(name);
  const hvds = await fetchRunningEmulatorHvds(hdcPath);
  return hvds.some((hvd) => normalizeListNameKey(hvd) === targetKey);
}

async function waitForEmulatorHdcState(
  hdcPath: string,
  name: string,
  expectPresent: boolean,
  timeoutMs = EMULATOR_CONFIRM_TIMEOUT_MS,
  intervalMs = EMULATOR_CONFIRM_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await isEmulatorPresentByHdcName(hdcPath, name);
    if (present === expectPresent) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function argsIncludeSnapshot(args: string[] | undefined): boolean | null {
  if (!args) {
    return null;
  }
  const i = args.indexOf('-bootmode');
  return i >= 0 && i + 1 < args.length && args[i + 1] === 'snapshot';
}

interface EmulatorStartOutcome {
  started: boolean;
  memoryBytes: number;
  hotBoot: boolean | null;
}

interface EmulatorStartTelemetry {
  emulatorMemory: string;
  hotBoot: boolean | null;
}

async function startOneEmulator(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  name: string,
  startOptions?: EmulatorStartOptions
): Promise<EmulatorStartOutcome> {
  const result = await emulatorManager.startEmulator(name, startOptions);
  if (result.status === 'already-running') {
    console.log(yellow(`Emulator "${name}" is already running.`));
    return { started: false, memoryBytes: 0, hotBoot: null };
  }

  console.log(cyan(`Starting emulator "${name}"...`));

  const tracker = result.tracker;
  let memoryBytes = 0;
  const hotBoot = argsIncludeSnapshot(result.args);

  try {
    const confirmed = await waitForEmulatorHdcState(hdcPath, name, true);
    if (confirmed) {
      console.log(green(`Emulator "${name}" started successfully.`));
    } else {
      console.log(
        yellow(
          `Emulator "${name}" was launched but did not appear in hdc list targets within the timeout.`
        )
      );
    }
  } finally {
    if (tracker) {
      try {
        memoryBytes = await tracker.stop();
      } catch {
        // 采集失败不得改变模拟器启动结果
      }
    }
  }

  return { started: true, memoryBytes, hotBoot };
}

async function startAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  names: string[],
  startOptions?: EmulatorStartOptions
): Promise<EmulatorStartTelemetry> {
  const results = await Promise.allSettled(
    names.map((name) =>
      startOneEmulator(emulatorManager, hdcPath, name, startOptions)
    )
  );

  if (reportSettledFailures(results, names, 'start')) {
    throw new TraceError('One or more emulators failed to start.');
  }

  const startedOutcomes = results
    .filter(
      (r): r is PromiseFulfilledResult<EmulatorStartOutcome> =>
        r.status === 'fulfilled'
    )
    .map((r) => r.value)
    .filter((o) => o.started);

  const anyUnknown =
    startedOutcomes.length === 0 ||
    startedOutcomes.some((o) => o.memoryBytes === 0);

  return {
    emulatorMemory: anyUnknown
      ? 'unknown'
      : formatBytesMb(
          startedOutcomes.reduce((sum, o) => sum + o.memoryBytes, 0)
        ),
    hotBoot:
      startedOutcomes.length === 0
        ? null
        : startedOutcomes.every((o) => o.hotBoot === true),
  };
}

async function resolveEmulatorListName(
  hdcPath: string,
  identifier: string
): Promise<string> {
  const trimmed = identifier.trim();
  if (!isLocalEmulatorSerial(trimmed)) {
    return trimmed;
  }
  const name = await DeviceManager.withHdcPath(hdcPath).getDeviceName(trimmed);
  if (name === trimmed) {
    throw new Error(
      `Cannot resolve a running emulator with serial "${trimmed}". Use \`devecocli emulator list\` or pass the emulator name instead.`
    );
  }
  return name;
}

async function stopOneEmulator(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  identifier: string
): Promise<void> {
  const name = await resolveEmulatorListName(hdcPath, identifier);
  console.log(cyan(`Stopping emulator "${name}"...`));
  const outcome = await emulatorManager.stopEmulator(name);
  if (outcome === 'already-stopped') {
    console.log(yellow(`Emulator "${name}" is already stopped.`));
    return;
  }

  const confirmed = await waitForEmulatorHdcState(hdcPath, name, false);
  if (confirmed) {
    console.log(green(`Emulator "${name}" stopped successfully.`));
  } else {
    console.log(
      yellow(
        `Emulator "${name}" stop signal was sent but the instance is still visible in hdc list targets within the waiting period.`
      )
    );
  }
}

async function stopAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  identifiers: string[]
) {
  const results = await Promise.allSettled(
    identifiers.map((id) => stopOneEmulator(emulatorManager, hdcPath, id))
  );

  reportSettledFailures(results, identifiers, 'stop');
}

async function initEmulatorManager(): Promise<{
  manager: EmulatorManager;
  toolProvider: ToolProvider;
}> {
  const toolProvider = await ToolProvider.new();
  const manager = EmulatorManager.from(toolProvider);
  return { manager, toolProvider };
}

async function runEmulatorControlAction(
  options: EmulatorTargetOptions,
  actionFactory: () => EmulatorControlAction | EmulatorControlAction[],
  subCommand: string
): Promise<void> {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: ['emulator', subCommand, '--target'],
  };
  await withEmulatorTrace(event, async () => {
    const target = assertTarget(options.target);
    const produced = actionFactory();
    const actions = Array.isArray(produced) ? produced : [produced];
    const { manager, toolProvider } = await initEmulatorManager();
    const instanceName = await resolveEmulatorListName(
      toolProvider.hdcPath,
      target
    );
    for (const action of actions) {
      await manager.controlEmulator(instanceName, action);
    }
    console.log(green(`Emulator "${target}" operation completed.`));
  });
}

function geolocationActions(
  options: GeolocationOptions
): EmulatorControlAction[] {
  const actions: EmulatorControlAction[] = [];
  addGpsAction(actions, 'longitude', options.longitude, -180, 180, 8);
  addGpsAction(actions, 'latitude', options.latitude, -90, 90, 8);
  addGpsAction(actions, 'altitude', options.altitude, -10000, 10000, 2);
  addGpsAction(
    actions,
    'bearing',
    options.direction,
    0,
    359.99,
    2,
    '--direction'
  );
  if (actions.length === 0) {
    throw new Error('Specify at least one geolocation option.');
  }
  // 经纬度建议同传：单独设置 longitude 或 latitude 无法构成有效坐标点，只警告不阻断
  if (options.longitude === undefined || options.latitude === undefined) {
    console.warn(
      yellow(
        'Warning: --longitude and --latitude should be specified together to form a valid location.'
      )
    );
  }
  return actions;
}

function sensorActions(options: SensorOptions): EmulatorControlAction[] {
  const actions: EmulatorControlAction[] = [];
  addSensorAction(
    actions,
    'light',
    options.lightIntensity,
    0,
    100000,
    false,
    '--light-intensity'
  );
  addSensorAction(actions, 'humidity', options.humidity, 0, 100, false);
  addSensorAction(actions, 'temperature', options.temperature, -273.1, 100, false);
  addSensorAction(actions, 'steps', options.steps, 0, 10000, true);
  addSensorAction(actions, 'heartrate', options.heartrate, 0, 255, true);
  if (actions.length === 0) {
    throw new Error('Specify at least one sensor option.');
  }
  return actions;
}

function addGpsAction(
  actions: EmulatorControlAction[],
  key: 'longitude' | 'latitude' | 'altitude' | 'bearing',
  input: string | undefined,
  min: number,
  max: number,
  maxDecimalPlaces: number,
  optionName = `--${key}`
): void {
  if (input === undefined) {
    return;
  }
  actions.push({
    type: 'gps',
    key,
    value: parseRangeNumberText(optionName, input, min, max, maxDecimalPlaces),
  });
}

function addSensorAction(
  actions: EmulatorControlAction[],
  key: 'light' | 'humidity' | 'temperature' | 'steps' | 'heartrate',
  input: string | undefined,
  min: number,
  max: number,
  integer: boolean,
  optionName = `--${key}`
): void {
  if (input === undefined) {
    return;
  }
  const value = integer
    ? parseRangeInteger(optionName, input, min, max)
    : parseRangeNumber(optionName, input, min, max, 1);
  actions.push({ type: 'sensor', key, value });
}

function batteryAction(options: BatteryOptions): EmulatorControlAction[] {
  const actions: EmulatorControlAction[] = [];
  // Push status before level. When the user explicitly passes
  // --status charging, mark the battery action assumedCharging so controlEmulator
  // statically allows --level 0 without relying on -batteryStatus → hidumper
  // propagation timing.
  if (options.status !== undefined) {
    const status: 0 | 1 = options.status === 'charging' ? 1 : 0;
    actions.push({ type: 'battery-status', status });
  }
  if (options.level !== undefined) {
    actions.push({
      type: 'battery',
      level: parseRangeInteger('--level', options.level, 0, 100),
      assumedCharging: options.status === 'charging',
    });
  }

  if (actions.length === 0) {
    throw new Error('Specify --level or --status.');
  }
  // Battery level 0 is only valid while charging; combining --level 0 with
  // --status discharging is an invalid target state.
  const hasLevelZero = actions.some(
    (a) => a.type === 'battery' && a.level === 0
  );
  const hasDischarging = actions.some(
    (a) => a.type === 'battery-status' && a.status === 0
  );
  if (hasLevelZero && hasDischarging) {
    throw new Error(
      'Battery level 0 is only allowed while charging; --level 0 cannot be combined with --status discharging.'
    );
  }
  return actions;
}

const emulatorCommand = new Command('emulator').description(
  'Manage emulator instances'
);

emulatorCommand.configureOutput({
  outputError: (str, write) => {
    write(str);
    if (/too many arguments/i.test(str)) {
      write(
        `\n${yellow('Tip: ')}${gray('An option value containing spaces/parentheses must be quoted. Use:')}\n` +
          `  ${cyan('devecocli emulator <subcommand> --<option> "value with spaces"')}\n` +
          `  ${cyan('devecocli emulator <subcommand> --<option>="value with spaces"')}\n`
      );
    }
  },
});

emulatorCommand.hook('preAction', async () => {
  const toolProvider = await ToolProvider.new();
  toolProvider.require({ studio: MIN_EMULATOR_STUDIO_VERSION });
});

const EMULATOR_IMAGE_DEVICE_TYPES = [
  'phone',
  'foldable',
  'widefold',
  'triplefold',
  'tablet',
  '2in1',
  '2in1 foldable',
  'wearable',
  'tv',
] as const;

function deviceTypeOption(required: boolean): Option {
  const opt = new Option(
    '--device-type <type>',
    'Emulator device type'
  ).choices([...EMULATOR_IMAGE_DEVICE_TYPES]);
  return required ? opt.makeOptionMandatory() : opt;
}

interface EmulatorCreateCliOptions {
  deviceType: string;
  osVersion: string;
  instancePath?: string;
  imageRoot?: string;
  screenProfile?: string;
  screen?: string[];
  storage?: string;
  memory?: string;
  hotBoot?: 'true' | 'false';
  force?: boolean;
}

function createDeviceTypeOption(): Option {
  return new Option(
    '--device-type <type>',
    'Emulator device type (case-insensitive)'
  )
    .argParser((value) => {
      if (!value.trim()) {
        throw new InvalidArgumentError('--device-type must not be empty.');
      }
      return value;
    })
    .makeOptionMandatory();
}

function parseCreateScreen(screen?: string[]): string[] | undefined {
  if (screen === undefined) {
    return undefined;
  }
  if (
    screen.length >= 4 &&
    screen.length % 4 === 0 &&
    screen.every((value) => /^\d+(?:\.\d+)?$/.test(value))
  ) {
    throw new Error(
      '--screen value must be quoted: --screen "1316 2832 560 6.9".'
    );
  }
  if (screen.length > 2) {
    throw new Error('--screen accepts one or two configurations.');
  }
  for (const [index, configuration] of screen.entries()) {
    const values = configuration.trim().split(/\s+/);
    const label =
      screen.length === 1 ? '--screen' : `--screen configuration ${index + 1}`;
    if (values.length !== 4 || values.some((value) => value.length === 0)) {
      throw new Error(
        `${label} must contain four values: width(px), height(px), DPI, and screen diagonal length(inch).`
      );
    }
    parseRangeNumber(`${label} width`, values[0], 720, 3500);
    parseRangeNumber(`${label} height`, values[1], 720, 3500);
    parseRangeNumber(`${label} DPI`, values[2], 240, 640);
    parseRangeNumber(`${label} screen diagonal length`, values[3], 3.5, 9);
  }
  return screen;
}

function selectedCreateOptionNames(opts: EmulatorCreateCliOptions): string[] {
  return [
    '--device-type',
    '--os-version',
    ...(opts.instancePath !== undefined ? ['--instance-path'] : []),
    ...(opts.imageRoot !== undefined ? ['--image-root'] : []),
    ...(opts.screenProfile !== undefined ? ['--screen-profile'] : []),
    ...(opts.screen !== undefined ? ['--screen'] : []),
    ...(opts.storage !== undefined ? ['--storage'] : []),
    ...(opts.memory !== undefined ? ['--memory'] : []),
    ...(opts.hotBoot !== undefined ? ['--hot-boot'] : []),
    ...(opts.force ? ['--force'] : []),
  ];
}

type ImageListFormat = 'table' | 'json';

function getRecordValue(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj) {
      return obj[k];
    }
  }
  return undefined;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return String(value).trim();
}

function toBoolText(value: unknown): string {
  const t = toText(value).toLowerCase();
  if (t === 'true') {
    return 'true';
  }
  if (t === 'false') {
    return 'false';
  }
  return t;
}

const IMAGE_LIST_TABLE_HEADERS = [
  'OS Version',
  'Device Type',
  'Software Version',
  'Release Type',
  'Upgradable',
  'Downloaded',
] as const;

const EMULATOR_IMAGE_LIST_EMPTY_HINT =
  'No matching system images found. Try `devecocli emulator image list --all`, then download an image via `devecocli emulator image download ...`.';

async function assertImageDownloadAvailable(
  manager: EmulatorManager,
  deviceType: string,
  osVersion: string
): Promise<void> {
  if (await manager.hasAvailableEmulatorImage({ deviceType, osVersion })) {
    return;
  }
  throw new Error(
    `Invalid --os-version value "${osVersion}".\nRun \`devecocli emulator image list --all\` and use an exact OS Version value.`
  );
}

function parseJsonArrayOrNull(text: string): unknown[] | null {
  try {
    const data = JSON.parse(text) as unknown;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function buildImageListTableRows(
  data: unknown[],
  highlightDownloaded: boolean
): TableRow[] {
  const rows: TableRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const osVersion = toText(
      getRecordValue(row, ['osVersion', 'OsVersion', 'OSVersion', 'os_version'])
    );
    const deviceType = toText(
      getRecordValue(row, ['deviceType', 'DeviceType', 'device_type'])
    );
    const downloaded = toBoolText(
      getRecordValue(row, ['downloaded', 'Downloaded', 'isDownloaded'])
    );
    const softwareVersion = toText(
      getRecordValue(row, [
        'SoftWareVersion',
        'SoftwareVersion',
        'softwareVersion',
        'software_version',
        'version',
      ])
    );
    const releaseType = toText(
      getRecordValue(row, ['releaseType', 'ReleaseType', 'release_type'])
    );
    const upgradable = toBoolText(
      getRecordValue(row, ['upgradable', 'Upgradable', 'isUpgradable'])
    );
    rows.push({
      cells: [
        osVersion,
        deviceType,
        softwareVersion,
        releaseType,
        upgradable,
        downloaded,
      ],
      highlight: highlightDownloaded && downloaded === 'true',
    });
  }
  return rows;
}

/** True when stdout is empty, JSON `[]`, or a JSON array with no renderable image rows. */
function isEmulatorImageListOutputEffectivelyEmpty(stdout: string): boolean {
  const text = stdout.trim();
  if (!text) {
    return true;
  }
  const data = parseJsonArrayOrNull(text);
  if (data === null) {
    return false;
  }
  if (data.length === 0) {
    return true;
  }
  return buildImageListTableRows(data, true).length === 0;
}

function formatImageListTable(
  stdout: string,
  highlightDownloaded: boolean
): string {
  const text = stdout.trim();
  if (!text) {
    return '';
  }
  const data = parseJsonArrayOrNull(text);
  if (!data) {
    return stdout.trimEnd();
  }
  const rows = buildImageListTableRows(data, highlightDownloaded);
  return renderTable(IMAGE_LIST_TABLE_HEADERS, rows);
}

const imageCommand = new Command('image').description(
  'HarmonyOS emulator system images (download, list, remove)'
);

imageCommand
  .command('download')
  .description('Download system image')
  .addOption(deviceTypeOption(false))
  .option(
    '--os-version <version>',
    'Example: HarmonyOS 5.1.1(19) or HarmonyOS 6.0.1(21) (required)'
  )
  .option('--force', 'Overwrite an existing image')
  .action(
    async (opts: {
      deviceType?: string;
      osVersion?: string;
      force?: boolean;
    }) => {
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: [
          'emulator', 'image', 'download',
          ...(opts.deviceType ? ['--device-type'] : []),
          ...(opts.osVersion ? ['--os-version'] : []),
          ...(opts.force ? ['--force'] : []),
        ],
      };
      await withEmulatorTrace(event, async () => {
        const { manager, toolProvider } = await initEmulatorManager();
        await ensureEmulatorSdkAgreementForImageDownload(
          toolProvider.emulatorPath,
          toolProvider.sdkPath
        );

        const deviceType = opts.deviceType?.trim();
        const osVersion = opts.osVersion?.trim();
        if (!deviceType) {
          throw new TraceError(
            "Error: missing required option '--device-type <type>'",
            'Missing required device type.'
          );
        }
        if (!osVersion) {
          throw new TraceError(
            "Error: misssing required option '--os-version <version>'",
            'Missing required OS version.'
          );
        }
        await assertImageDownloadAvailable(manager, deviceType, osVersion);

        await manager.installEmulatorImage({
          deviceType,
          osVersion,
          force: opts.force === true,
        });
      });
    }
  );

imageCommand
  .command('remove')
  .description('Remove a downloaded system image')
  .addOption(deviceTypeOption(true))
  .requiredOption(
    '--os-version <version>',
    'Supports both image label (HarmonyOS x.y.z(n)) and softwareVersion'
  )
  .action(async (opts: { deviceType: string; osVersion: string }) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['emulator', 'image', 'remove', '--device-type', '--os-version'],
    };
    await withEmulatorTrace(event, async () => {
      const { manager } = await initEmulatorManager();
      await manager.uninstallEmulatorImage({
        deviceType: opts.deviceType,
        osVersion: opts.osVersion,
      });
    });
  });

imageCommand
  .command('list')
  .description('List system images')
  .addOption(deviceTypeOption(false))
  .option('--all', 'List all images (local and remote)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['table', 'json'])
      .default('table')
  )
  .action(
    async (opts: {
      deviceType?: string;
      all?: boolean;
      format?: ImageListFormat;
    }) => {
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: [
          'emulator', 'image', 'list',
          ...(opts.deviceType ? ['--device-type'] : []),
          ...(opts.all ? ['--all'] : []),
          ...(opts.format !== 'table' ? ['--format'] : []),
        ],
      };
      await withEmulatorTrace(event, async () => {
        const { manager } = await initEmulatorManager();
        let downloaded: boolean | undefined;
        if (opts.all) {
          downloaded = undefined;
        } else {
          downloaded = true;
        }
        const out = await manager.listEmulatorImages({
          deviceType: opts.deviceType,
          downloaded,
        });
        if (isEmulatorImageListOutputEffectivelyEmpty(out)) {
          console.log(yellow(EMULATOR_IMAGE_LIST_EMPTY_HINT));
          return;
        }
        if (opts.format === 'json') {
          console.log(out.trimEnd());
          return;
        }
        const table = formatImageListTable(out, opts.all === true);
        console.log(table);
      });
    }
  );

emulatorCommand.addCommand(imageCommand);

const licenseCommand = new Command('license').description(
  'Review and accept emulator license agreements interactively (prints full text + y/N prompt)'
);

licenseCommand
  .command('view')
  .description('Review agreement text (read-only, no changes)')
  .action(async () => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['emulator', 'license', 'view'],
    };
    await withEmulatorTrace(event, async () => {
      const { toolProvider } = await initEmulatorManager();
      const code = await runEmulatorLicenseView(
        toolProvider.emulatorPath,
        toolProvider.sdkPath
      );
      process.exitCode = code;
    });
  });

licenseCommand
  .command('accept')
  .description(
    'Accept all emulator license agreements non-interactively (skips review and prompt)'
  )
  .action(async () => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['emulator', 'license', 'accept'],
    };
    await withEmulatorTrace(event, async () => {
      const { toolProvider } = await initEmulatorManager();
      const code = await runEmulatorLicenseAcceptDirectly(
        toolProvider.emulatorPath,
        toolProvider.sdkPath
      );
      process.exitCode = code;
    });
  });

licenseCommand.action(async () => {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: ['emulator', 'license'],
  };
  await withEmulatorTrace(event, async () => {
    const { toolProvider } = await initEmulatorManager();
    const code = await runEmulatorLicenseAccept(
      toolProvider.emulatorPath,
      toolProvider.sdkPath
    );
    process.exitCode = code;
  });
});

emulatorCommand.addCommand(licenseCommand);

emulatorCommand
  .command('shake')
  .description('Trigger shake event')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .action((options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'shake' }), 'shake')
  );

emulatorCommand
  .command('power')
  .description('Press power button (toggle screen on/off)')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .action((options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'power' }), 'power')
  );

emulatorCommand
  .command('rotate')
  .description('Rotate emulator')
  .addOption(
    new Option('--target <nameOrSerial>', 'Target emulator name or serial')
      .makeOptionMandatory()
  )
  .addArgument(new Argument('<direction>').choices(['left', 'right']))
  .action((direction: 'left' | 'right', options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'rotation', direction }), 'rotate')
  );

emulatorCommand
  .command('volume')
  .description('Change volume')
  .addOption(
    new Option('--target <nameOrSerial>', 'Target emulator name or serial')
      .makeOptionMandatory()
  )
  .addArgument(new Argument('<direction>').choices(['up', 'down']))
  .action((direction: 'up' | 'down', options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'volume', direction }), 'volume')
  );

emulatorCommand
  .command('fold <state>')
  .description('Set foldable display state')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .addHelpText('after', FOLDED_STATE_HELP)
  .action((state: string, options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({
      type: 'folded-state',
      state: parseFoldedState(state),
    }), 'fold')
  );

emulatorCommand
  .command('battery')
  .description('Set battery level and/or charging status')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .option(
    '--level <0-100>',
    'Battery level, SOC (charging: 0-100; not charging: 1-100)'
  )
  .addOption(
    new Option('--status <status>', 'Charging status').choices([
      'charging',
      'discharging',
    ])
  )
  .action((options: BatteryOptions) =>
    runEmulatorControlAction(options, () => batteryAction(options), 'battery')
  );

emulatorCommand
  .command('geolocation')
  .description('Inject geographic coordinates and direction')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .option('--longitude <value>', 'Longitude (-180.0 to 180.0)')
  .option('--latitude <value>', 'Latitude (-90.0 to 90.0)')
  .option('--altitude <value>', 'Altitude (-10000.0 to 10000.0)')
  .option('--direction <value>', 'Heading direction in degrees (0.00 to 359.99)')
  .action((options: GeolocationOptions) =>
    runEmulatorControlAction(options, () => geolocationActions(options), 'geolocation')
  );

emulatorCommand
  .command('scene')
  .description('Start motion simulation scene')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .addArgument(
    new Argument('<type>', 'Motion simulation scene').choices([
      'outdoorRunning',
      'outdoorCycling',
      'drivingNavigation',
    ])
  )
  .action((type: string, options: EmulatorTargetOptions) => {
    const sceneActions: Record<string, EmulatorControlAction> = {
      outdoorRunning: { type: 'outdoor-running' },
      outdoorCycling: { type: 'outdoor-cycling' },
      drivingNavigation: { type: 'driving-navigation' },
    };
    return runEmulatorControlAction(options, () => sceneActions[type], 'scene');
  });

emulatorCommand
  .command('sensor')
  .description('Inject sensor data')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .option('--light-intensity <value>', 'Light sensor (0 to 100000)')
  .option('--humidity <value>', 'Humidity sensor (0 to 100)')
  .option('--temperature <value>', 'Temperature sensor (-273.1 to 100)')
  .option('--steps <value>', 'Steps sensor (integer 0 to 10000)')
  .option('--heartrate <value>', 'Heart rate sensor (integer 0 to 255)')
  .action((options: SensorOptions) =>
    runEmulatorControlAction(options, () => sensorActions(options), 'sensor')
  );

emulatorCommand
  .command('list')
  .description('List all emulator instances')
  .addOption(
    new Option(
      '--details',
      'Output the raw JSON of `Emulator -list -details` without transformation'
    ).conflicts('format')
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['table', 'json'])
      .default('table')
  )
  .action(async (options: EmulatorListOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'emulator',
        'list',
        ...(options.details ? ['--details'] : []),
        ...(options.format !== 'table' ? ['--format'] : []),
      ],
    };
    await withEmulatorTrace(event, async () => {
      const { manager, toolProvider } = await initEmulatorManager();
      if (options.details) {
        const raw = await manager.listEmulatorDetails();
        console.log(raw.trimEnd());
        return;
      }
      const spinner =
        options.format === 'table'
          ? ora({
              text: 'Listing emulators…',
              color: 'cyan',
            }).start()
          : undefined;
      await listAction(manager, toolProvider.hdcPath, options.format, spinner);
    });
  });

interface EmulatorStartCliOptions {
  hdcport?: number;
  bootMode?: EmulatorBootMode;
  /** `--no-window` is negated: `window` is false only when the flag is passed. */
  window?: boolean;
}

function parseHdcPort(value: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    throw new InvalidArgumentError(
      '--hdcport must be an integer in [10000, 16555].'
    );
  }
  const port = Number(text);
  if (port < 10000 || port > 16555) {
    throw new InvalidArgumentError('--hdcport must be in [10000, 16555].');
  }
  return port;
}

function toStartOptions(opts: EmulatorStartCliOptions): EmulatorStartOptions {
  return {
    hdcPort: opts.hdcport,
    bootMode: opts.bootMode,
    noWindow: opts.window === false,
  };
}

function selectedStartOptionNames(opts: EmulatorStartCliOptions): string[] {
  return [
    ...(opts.hdcport !== undefined ? ['--hdcport'] : []),
    ...(opts.bootMode !== undefined ? ['--boot-mode'] : []),
    ...(opts.window === false ? ['--no-window'] : []),
  ];
}

emulatorCommand
  .command('start [names...]')
  .description('Start one or more emulator instances')
  .addOption(
    new Option(
      '--hdcport <port>',
      'hdc port of the emulator, 10000-16555 (Emulator -hdcport)'
    ).argParser(parseHdcPort)
  )
  .addOption(
    new Option(
      '--boot-mode <mode>',
      'Boot mode (Emulator -bootMode): coldboot = cold start keeping user data, snapshot = hot start restoring the last snapshot (needs Quick Boot), reset = wipe data then cold start; overrides the mode chosen when the instance was created'
    ).choices(['coldboot', 'snapshot', 'reset'])
  )
  .addOption(
    new Option(
      '--no-window',
      'Start the emulator without a window (Emulator -noWindow); required on Linux hosts without a GUI'
    )
  )
  .action(async (names: string[], opts: EmulatorStartCliOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['emulator', 'start', ...selectedStartOptionNames(opts)],
      emulatorMemory: 'unknown',
      hotBoot: null,
    };
    await withEmulatorTrace(event, async () => {
      const { manager, toolProvider } = await initEmulatorManager();
      await ensureEmulatorServiceAgreementConfig(
        toolProvider.emulatorPath,
        toolProvider.sdkPath
      );
      if (!names?.length) {
        throw new TraceError(
          "Error: missing required argument 'names'",
          'Missing required emulator name.'
        );
      }
      if (names.length > 1 && opts.hdcport !== undefined) {
        throw new TraceError(
          `Error: --hdcport cannot target ${names.length} emulators.`,
          '--hdcport sets the hdc port of a single emulator; pass one name, or omit --hdcport.'
        );
      }
      const result = await startAction(
        manager,
        toolProvider.hdcPath,
        names,
        toStartOptions(opts)
      );
      event.emulatorMemory = result.emulatorMemory;
      event.hotBoot = result.hotBoot;
    });
  });

emulatorCommand
  .command('stop <names...>')
  .description(
    'Stop one or more emulator instances (by name or serial,e.g.,127.0.0.1:<port>)'
  )
  .action(async (names: string[]) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['emulator', 'stop'],
    };
    await withEmulatorTrace(event, async () => {
      const { manager, toolProvider } = await initEmulatorManager();
      if (!names?.length) {
        console.error(red("Error: missing required argument 'names'"));
        process.exitCode = 1;
        return;
      }
      await stopAction(manager, toolProvider.hdcPath, names);
    });
  });

const createEmulatorCmd = emulatorCommand
  .command('create <name>')
  .description(
    'Create a local emulator instance.'
  )
  .addOption(createDeviceTypeOption())
  .requiredOption(
    '--os-version <version>',
    'Downloaded image label. which will be quoted in PowerShell (e.g. "HarmonyOS 6.0.1(21)") or be used in the format --os-version="…";For details, run`devecocli emulator image list`'
  )
  .addOption(
    new Option('--path, --instance-path <path>', 'Emulator instance path')
  )
  .option('--image-root <path>', 'Emulator image path')
  .option('--screen-profile <model>', 'Emulator screen profile')
  .addOption(
    new Option(
      '--screen <config...>',
      'Screen: "width(px) height(px) DPI screen-diagonal-length(inch)" (720-3500, 720-3500, 240-640, 3.5-9); pass two values for a foldable device'
    )
  )
  .option('--storage <size>', 'Storage size in GB (2-1023)')
  .option('--memory <size>', 'Memory size in GB (2-32)')
  .addOption(
    new Option('--hot-boot <boolean>', 'Enable or disable hot boot').choices([
      'true',
      'false',
    ])
  )
  .option('--force', 'Overwrite an existing emulator instance');

createEmulatorCmd.action(
  async (name: string, opts: EmulatorCreateCliOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['emulator', 'create', ...selectedCreateOptionNames(opts)],
    };
    await withEmulatorTrace(event, async () => {
      if (!opts.osVersion.trim()) {
        throw new Error('--os-version must not be empty.');
      }
      const createOptions: EmulatorCreateOptions = {
        name,
        deviceType: opts.deviceType,
        osVersion: opts.osVersion,
        instancePath: opts.instancePath,
        imageRoot: opts.imageRoot,
        screenProfile: opts.screenProfile,
        screen: parseCreateScreen(opts.screen),
        storage:
          opts.storage === undefined
            ? undefined
            : parseRangeNumber('--storage', opts.storage, 2, 1023),
        memory:
          opts.memory === undefined
            ? undefined
            : parseRangeNumber('--memory', opts.memory, 2, 32),
        hotBoot:
          opts.hotBoot === undefined ? undefined : opts.hotBoot === 'true',
        force: opts.force === true,
      };
      const { manager } = await initEmulatorManager();
      console.log(cyan(`Creating emulator "${name}"...`));
      await manager.createVirtualDevice(createOptions);
      console.log(green(`Emulator "${name}" created successfully.`));
    });
  }
);

emulatorCommand
  .command('delete <name>')
  .description('Delete a local emulator instance')
  .addOption(
    new Option('--path, --instance-path <path>', 'Emulator instance path')
  )
  .action(async (name: string, opts: { instancePath?: string }) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'emulator',
        'delete',
        ...(opts.instancePath !== undefined ? ['--instance-path'] : []),
      ],
    };
    await withEmulatorTrace(event, async () => {
      const { manager } = await initEmulatorManager();
      console.log(cyan(`Deleting emulator "${name}"...`));
      const deletedName = await manager.deleteVirtualDevice(
        name,
        opts.instancePath
      );
      console.log(green(`Emulator "${deletedName}" deleted successfully.`));
    });
  });

export default emulatorCommand;
