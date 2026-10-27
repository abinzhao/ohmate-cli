/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option } from 'commander';
import { green, yellow } from 'colorette';
import ora, { type Ora } from 'ora';
import { ToolProvider } from '../toolchain/index.js';
import { ScreenRecordAdapter, ScreenRecordError } from '../ui/index.js';
import type { FinalizeResult, RecordingStatus } from '../ui/index.js';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
} from '../trace/index.js';

interface StartOptions {
  device?: string;
  path?: string;
}

interface StopOptions {
  device?: string;
  force?: boolean;
}

interface StatusOptions {
  device?: string;
  format: string;
}

interface ParentOptions {
  device?: string;
  path?: string;
}

const DEVICE_FLAG = [
  '--device <name|serial>',
  'Target physical device name or serial; required when multiple devices are connected',
] as const;
const PATH_FLAG = [
  '--path <dir|file.mp4>',
  'Required writable destination: existing directory or a new .mp4 file',
] as const;

function invalidArgument(message: string): Error {
  return new ScreenRecordError('INVALID_ARGUMENT', message);
}

function assertDeviceOption(device: string | undefined): void {
  if (device !== undefined && !device.trim()) {
    throw invalidArgument('--device must not be empty.');
  }
}

/** `--device` may sit before or after the subcommand; conflicts are errors. */
function mergeDevice(
  command: Command,
  device: string | undefined
): string | undefined {
  const parentDevice = (command.parent?.opts() as ParentOptions | undefined)
    ?.device;
  assertDeviceOption(parentDevice);
  assertDeviceOption(device);
  if (parentDevice && device && parentDevice !== device) {
    throw invalidArgument(
      `Conflicting --device values: ${JSON.stringify(parentDevice)} and ${JSON.stringify(device)}`
    );
  }
  return device ?? parentDevice;
}

/** `stop`/`status` must not silently ignore a parent-level `--path`. */
function rejectParentPath(command: Command, subcommand: string): void {
  const parentPath = (command.parent?.opts() as ParentOptions | undefined)
    ?.path;
  if (parentPath !== undefined) {
    throw invalidArgument(
      `--path is not valid for ui screenrecord ${subcommand}.`
    );
  }
}

/**
 * `--path` may sit before or after `start`; conflicts are errors. Commander
 * assigns a shared option to the nearest ancestor that declares it.
 */
function mergePath(
  command: Command,
  pathArg: string | undefined
): string | undefined {
  const parentPath = (command.parent?.opts() as ParentOptions | undefined)
    ?.path;
  if (
    parentPath !== undefined &&
    pathArg !== undefined &&
    parentPath !== pathArg
  ) {
    throw invalidArgument(
      `Conflicting --path values: ${JSON.stringify(parentPath)} and ${JSON.stringify(pathArg)}`
    );
  }
  return pathArg ?? parentPath;
}

/**
 * Flag names for telemetry, derived from raw option presence only (own level
 * or parent level); merging and validation run inside the tracked action.
 */
function usedFlagNames(
  command: Command,
  flags: Array<{ name: '--device' | '--path'; value: unknown }>
): string[] {
  const parentOpts = command.parent?.opts() as ParentOptions | undefined;
  return flags
    .filter(
      (flag) =>
        flag.value !== undefined ||
        parentOpts?.[flag.name.slice(2) as keyof ParentOptions] !== undefined
    )
    .map((flag) => flag.name);
}

function cliSourced(command: Command, flag: string): boolean {
  return command.getOptionValueSource(flag) === 'cli';
}

async function trackAction(
  subcommand: string[],
  flagNames: string[],
  execute: () => Promise<void>
): Promise<void> {
  const event: CommandExecuted = {
    event: EventType.CommandExecuted,
    args: ['ui', 'screenrecord', ...subcommand, ...flagNames],
  };
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await execute();
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    throw error;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

function printFinalizeResult(result: FinalizeResult): void {
  if (result.kind === 'saved') {
    console.log(green(`Saved successfully to ${result.localPath}`));
    for (const warning of result.warnings ?? []) {
      console.error(yellow(`Warning: ${warning}`));
    }
  } else if (result.kind === 'external-stopped') {
    console.log(
      green(
        'Recording stopped. View the file in the device gallery; this CLI cannot retrieve it.'
      )
    );
  }
  // completed-elsewhere: another terminal saved or discarded the session.
}

async function interactiveAction(
  options: StartOptions,
  command: Command
): Promise<void> {
  const flags = usedFlagNames(command, [
    { name: '--device', value: options.device },
    { name: '--path', value: options.path },
  ]);
  await trackAction([], flags, async () => {
    const device = mergeDevice(command, options.device);
    const pathArg = mergePath(command, options.path);
    const adapter = new ScreenRecordAdapter(await ToolProvider.new());
    let spinner: Ora | undefined;
    let result: FinalizeResult;
    try {
      result = await adapter.recordInteractively(device, pathArg, {
        onStarted: () => {
          console.log('Recording... press Ctrl+C to stop and save');
        },
        onStopRequested: () => {
          spinner = ora({
            text: 'Stopping and saving the recording…',
            color: 'cyan',
          }).start();
        },
      });
    } finally {
      spinner?.stop();
    }
    printFinalizeResult(result);
  });
}

async function startAction(
  options: StartOptions,
  command: Command
): Promise<void> {
  const flags = usedFlagNames(command, [
    { name: '--device', value: options.device },
    { name: '--path', value: options.path },
  ]);
  await trackAction(['start'], flags, async () => {
    const device = mergeDevice(command, options.device);
    const pathArg = mergePath(command, options.path);
    const adapter = new ScreenRecordAdapter(await ToolProvider.new());
    await adapter.startDetached(device, pathArg);
    console.log(
      green('Recording started. Stop with devecocli ui screenrecord stop')
    );
  });
}

async function stopAction(
  options: StopOptions,
  command: Command
): Promise<void> {
  const flags = [
    ...usedFlagNames(command, [{ name: '--device', value: options.device }]),
    ...(options.force ? ['--force'] : []),
  ];
  await trackAction(['stop'], flags, async () => {
    const device = mergeDevice(command, options.device);
    rejectParentPath(command, 'stop');
    const adapter = new ScreenRecordAdapter(await ToolProvider.new());
    const spinner = ora({ text: 'Stopping recording…', color: 'cyan' }).start();
    let result: FinalizeResult;
    try {
      result = await adapter.stopRecording(device, options.force ?? false);
    } finally {
      spinner.stop();
    }
    printFinalizeResult(result);
  });
}

const STATUS_TEXT: Record<RecordingStatus['status'], string> = {
  recording:
    'Status: recording - a recording started by this CLI is in progress',
  busy: 'Status: busy - a recording started outside this CLI is in progress',
  idle: 'Status: idle - no recording is in progress',
};

async function statusAction(
  options: StatusOptions,
  command: Command
): Promise<void> {
  const flags = [
    ...usedFlagNames(command, [{ name: '--device', value: options.device }]),
    ...(cliSourced(command, 'format') ? ['--format'] : []),
  ];
  await trackAction(['status'], flags, async () => {
    const device = mergeDevice(command, options.device);
    rejectParentPath(command, 'status');
    const adapter = new ScreenRecordAdapter(await ToolProvider.new());
    const status = await adapter.getRecordingStatus(device);
    if (options.format === 'json') {
      console.log(JSON.stringify(status));
      return;
    }
    console.log(STATUS_TEXT[status.status]);
    if (status.status === 'idle' && status.note) {
      console.log(status.note);
    }
  });
}

export const screenrecordCommand = new Command('screenrecord')
  .description('Record the screen of a physical device to an MP4 file')
  .option(...DEVICE_FLAG)
  .option(...PATH_FLAG)
  .action(interactiveAction);

screenrecordCommand.addCommand(
  new Command('start')
    .description('Start recording and return immediately (detached)')
    .option(...DEVICE_FLAG)
    .option(...PATH_FLAG)
    .action(startAction)
);

screenrecordCommand.addCommand(
  new Command('stop')
    .description('Stop the current recording and save the file')
    .option(...DEVICE_FLAG)
    .option(
      '--force',
      'Stop a recording that was not started by this CLI (no download)'
    )
    .action(stopAction)
);

screenrecordCommand.addCommand(
  new Command('status')
    .description('Show the recording status without changing it')
    .option(...DEVICE_FLAG)
    .addOption(
      new Option('--format <format>', 'Output format')
        .choices(['table', 'json'])
        .default('table')
    )
    .action(statusAction)
);
