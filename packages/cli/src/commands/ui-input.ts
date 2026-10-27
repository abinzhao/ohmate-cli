/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { SpinnerHelper } from '../utils/spinner-helper.js';
import { Command } from 'commander';
import { debugLog } from '../utils/logger.js';
import {
  DIRECTION_MAP,
  assertTargetParams,
  assertCoord,
  assertSpeed,
  assertNonEmpty,
  initDevice,
  resolveTarget,
  runHdcShell,
} from '../ui/input/index.js';
import type { ClickOptions, SwipeOptions, TextOptions } from '../ui/input/index.js';
import { telemetry, EventType, toTraceErrorCode, type CommandExecuted, type TrackMeasurement } from '../trace/index.js';

function buildUiInputEvent(subCommand: string, options: ClickOptions | SwipeOptions | TextOptions | { device?: string }): CommandExecuted {
  const flags: string[] = [];
  if ('device' in options && options.device) {
    flags.push('--device');
  }
  if ('id' in options && options.id) {
    flags.push('--id');
  }
  if ('window' in options && options.window) {
    flags.push('--window');
  }
  if ('speed' in options && options.speed) {
    flags.push('--speed');
  }
  return {
    event: EventType.CommandExecuted,
    args: ['ui', subCommand, ...flags],
  };
}

function escapeShellText(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const cmd = `"$(printf '%s' '${encoded}' | base64 -d)"`;
  debugLog(`escapeShellText: ${text} -> ${cmd}`);
  return cmd;
}

async function withSpinner(
  startText: string,
  failLabel: string,
  event: CommandExecuted,
  action: (spinner: SpinnerHelper) => Promise<void>
): Promise<void> {
  const spinner = new SpinnerHelper();
  spinner.start(startText);
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await action(spinner);
  } catch (error) {
    spinner.stop();
    success = false;
    errorCode = toTraceErrorCode(error);
    throw new Error(`${failLabel}: ${(error as Error).message}`, { cause: error });
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

async function handleClick(
  x: string | undefined,
  y: string | undefined,
  options: ClickOptions
): Promise<void> {
  const event = buildUiInputEvent('click', options);
  await withSpinner('Executing click...', 'click failed', event, async (spinner) => {
    assertTargetParams(x, y, options.id, options.window);
    const { hdcPath, deviceId } = await initDevice(options.device);
    const { x: cx, y: cy } = await resolveTarget(
      hdcPath, deviceId,
      x !== undefined ? Number(x) : undefined,
      y !== undefined ? Number(y) : undefined,
      options.id, options.window
    );
    await runHdcShell(hdcPath, deviceId, ['uitest', 'uiInput', 'click', String(cx), String(cy)]);
    spinner.succeed(`click at (${cx}, ${cy})`);
  });
}

async function handleDoubleClick(
  x: string | undefined,
  y: string | undefined,
  options: ClickOptions
): Promise<void> {
  const event = buildUiInputEvent('doubleclick', options);
  await withSpinner('Executing doubleclick...', 'doubleclick failed', event, async (spinner) => {
    assertTargetParams(x, y, options.id, options.window);
    const { hdcPath, deviceId } = await initDevice(options.device);
    const { x: cx, y: cy } = await resolveTarget(
      hdcPath, deviceId,
      x !== undefined ? Number(x) : undefined,
      y !== undefined ? Number(y) : undefined,
      options.id, options.window
    );
    await runHdcShell(hdcPath, deviceId, ['uitest', 'uiInput', 'doubleClick', String(cx), String(cy)]);
    spinner.succeed(`doubleclick at (${cx}, ${cy})`);
  });
}

async function handleLongClick(
  x: string | undefined,
  y: string | undefined,
  options: ClickOptions
): Promise<void> {
  const event = buildUiInputEvent('longclick', options);
  await withSpinner('Executing longclick...', 'longclick failed', event, async (spinner) => {
    assertTargetParams(x, y, options.id, options.window);
    const { hdcPath, deviceId } = await initDevice(options.device);
    const { x: cx, y: cy } = await resolveTarget(
      hdcPath, deviceId,
      x !== undefined ? Number(x) : undefined,
      y !== undefined ? Number(y) : undefined,
      options.id, options.window
    );
    await runHdcShell(hdcPath, deviceId, ['uitest', 'uiInput', 'longClick', String(cx), String(cy)]);
    spinner.succeed(`longclick at (${cx}, ${cy})`);
  });
}

async function handleSwipe(
  x1: string, y1: string, x2: string, y2: string,
  options: SwipeOptions
): Promise<void> {
  const event = buildUiInputEvent('swipe', options);
  await withSpinner('Executing swipe...', 'swipe failed', event, async (spinner) => {
    assertCoord(x1, 'x1');
    assertCoord(y1, 'y1');
    assertCoord(x2, 'x2');
    assertCoord(y2, 'y2');
    const speed = assertSpeed(options.speed);
    const { hdcPath, deviceId } = await initDevice(options.device);
    const args = ['uitest', 'uiInput', 'swipe', x1, y1, x2, y2];
    if (speed) {
      args.push(speed);
    }
    await runHdcShell(hdcPath, deviceId, args);
    spinner.succeed(`swipe from (${x1}, ${y1}) to (${x2}, ${y2})`);
  });
}

async function handleFling(
  x1: string, y1: string, x2: string, y2: string,
  options: SwipeOptions
): Promise<void> {
  const event = buildUiInputEvent('fling', options);
  await withSpinner('Executing fling...', 'fling failed', event, async (spinner) => {
    assertCoord(x1, 'x1');
    assertCoord(y1, 'y1');
    assertCoord(x2, 'x2');
    assertCoord(y2, 'y2');
    const speed = assertSpeed(options.speed);
    const { hdcPath, deviceId } = await initDevice(options.device);
    const args = ['uitest', 'uiInput', 'fling', x1, y1, x2, y2];
    if (speed) {
      args.push(speed);
    }
    await runHdcShell(hdcPath, deviceId, args);
    spinner.succeed(`fling from (${x1}, ${y1}) to (${x2}, ${y2})`);
  });
}

async function handleDrag(
  x1: string, y1: string, x2: string, y2: string,
  options: SwipeOptions
): Promise<void> {
  const event = buildUiInputEvent('drag', options);
  await withSpinner('Executing drag...', 'drag failed', event, async (spinner) => {
    assertCoord(x1, 'x1');
    assertCoord(y1, 'y1');
    assertCoord(x2, 'x2');
    assertCoord(y2, 'y2');
    const speed = assertSpeed(options.speed);
    const { hdcPath, deviceId } = await initDevice(options.device);
    const args = ['uitest', 'uiInput', 'drag', x1, y1, x2, y2];
    if (speed) {
      args.push(speed);
    }
    await runHdcShell(hdcPath, deviceId, args);
    spinner.succeed(`drag from (${x1}, ${y1}) to (${x2}, ${y2})`);
  });
}

async function handleDircFling(
  direction: string,
  options: { device?: string }
): Promise<void> {
  const event = buildUiInputEvent('dircfling', options);
  await withSpinner('Executing dircfling...', 'dircfling failed', event, async (spinner) => {
    const code = DIRECTION_MAP[direction];
    if (code === undefined) {
      throw new Error(`Invalid direction "${direction}". Valid values: ${Object.keys(DIRECTION_MAP).join(', ')}`);
    }
    const { hdcPath, deviceId } = await initDevice(options.device);
    await runHdcShell(hdcPath, deviceId, ['uitest', 'uiInput', 'dircFling', code]);
    spinner.succeed(`dircfling ${direction}`);
  });
}

async function handleText(
  text: string,
  x: string | undefined,
  y: string | undefined,
  options: TextOptions
): Promise<void> {
  const event = buildUiInputEvent('text', options);
  await withSpinner('Executing text input...', 'input failed', event, async (spinner) => {
    assertTargetParams(x, y, options.id, options.window, false);
    assertNonEmpty(text, 'text');
    const { hdcPath, deviceId } = await initDevice(options.device);
    const escaped = escapeShellText(text);
    if (x !== undefined) {
      await runHdcShell(hdcPath, deviceId, [`uitest uiInput inputText ${x} ${y} ${escaped}`]);
      spinner.succeed(`input ${text} at (${x}, ${y})`);
    } else if (options.id) {
      const { x: cx, y: cy } = await resolveTarget(hdcPath, deviceId, undefined, undefined, options.id, options.window);
      await runHdcShell(hdcPath, deviceId, [`uitest uiInput inputText ${cx} ${cy} ${escaped}`]);
      spinner.succeed(`input ${text} at (${cx}, ${cy})`);
    } else {
      await runHdcShell(hdcPath, deviceId, [`uitest uiInput text ${escaped}`]);
      spinner.succeed(`input ${text}`);
    }
  });
}

export const clickCommand = new Command('click')
  .argument('[x]', 'X coordinate')
  .argument('[y]', 'Y coordinate')
  .description('Tap at the specified coordinates')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--id <id>', 'Node id (auto-resolves to center coordinates)')
  .option('--window <windowId>', 'Target window id (used with --id)')
  .action(handleClick);

export const doubleclickCommand = new Command('doubleclick')
  .argument('[x]', 'X coordinate')
  .argument('[y]', 'Y coordinate')
  .description('Double-tap at the specified coordinates')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--id <id>', 'Node id (auto-resolves to center coordinates)')
  .option('--window <windowId>', 'Target window id (used with --id)')
  .action(handleDoubleClick);

export const longclickCommand = new Command('longclick')
  .argument('[x]', 'X coordinate')
  .argument('[y]', 'Y coordinate')
  .description('Long-press at the specified coordinates')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--id <id>', 'Node id (auto-resolves to center coordinates)')
  .option('--window <windowId>', 'Target window id (used with --id)')
  .action(handleLongClick);

export const swipeCommand = new Command('swipe')
  .argument('<x1>', 'Start X coordinate')
  .argument('<y1>', 'Start Y coordinate')
  .argument('<x2>', 'End X coordinate')
  .argument('<y2>', 'End Y coordinate')
  .description('Swipe from one point to another')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--speed <n>', 'Swipe speed (pixels per second)')
  .action(handleSwipe);

export const flingCommand = new Command('fling')
  .argument('<x1>', 'Start X coordinate')
  .argument('<y1>', 'Start Y coordinate')
  .argument('<x2>', 'End X coordinate')
  .argument('<y2>', 'End Y coordinate')
  .description('Fling from one point to another')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--speed <n>', 'Swipe speed (pixels per second)')
  .action(handleFling);

export const dragCommand = new Command('drag')
  .argument('<x1>', 'Start X coordinate')
  .argument('<y1>', 'Start Y coordinate')
  .argument('<x2>', 'End X coordinate')
  .argument('<y2>', 'End Y coordinate')
  .description('Drag from one point to another')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--speed <n>', 'Swipe speed (pixels per second)')
  .action(handleDrag);

export const dircflingCommand = new Command('dircfling')
  .argument('<direction>', 'Direction: up, down, left, right')
  .description('Fling in a specified direction')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .action(handleDircFling);

export const textCommand = new Command('text')
  .argument('<text>', 'Text to input')
  .argument('[x]', 'Optional X coordinate')
  .argument('[y]', 'Optional Y coordinate')
  .description('Input text at a target location or the currently focused field')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .option('--id <id>', 'Node id to target before input (auto-resolves to center)')
  .option('--window <windowId>', 'Target window id (used with --id)')
  .action(handleText);
