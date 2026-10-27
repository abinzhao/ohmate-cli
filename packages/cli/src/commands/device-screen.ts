/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { yellow } from 'colorette';
import ora from 'ora';
import {
  withDeviceTrace,
  initDeviceManager,
  TraceError,
  type CommandExecuted,
  EventType,
} from '../device/device-helpers.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { ScreenAdapter, parseDisplaySize } from '../device/screen/index.js';
import { createUiDriver } from '../device/uitest/index.js';

async function screenSizeAction(
  toolProvider: ToolProvider,
  device?: string,
  format: 'default' | 'json' = 'default'
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new ScreenAdapter(toolProvider);
  const spinner = ora({
    text: 'Querying screen size...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.getDisplayInfo(serial);
    spinner.stop();
    const size = parseDisplaySize(output);
    if (size) {
      if (format === 'json') {
        console.log(JSON.stringify({ width: size.width, height: size.height }, null, 2));
      } else {
        console.log(`${size.width}x${size.height}`);
      }
    } else {
      console.log(yellow('No display info found in output.'));
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to get screen size: ${(error as Error).message}`,
      'Failed to get screen size.'
    );
  }
}

async function screenSleeptimeAction(
  toolProvider: ToolProvider,
  ms: number,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new ScreenAdapter(toolProvider);
  const neverSleep = ms === -1;
  // Validate range: -1 for never sleep, or 5000~3600000ms
  if (!neverSleep && (ms < 5000 || ms > 3600000)) {
    throw new TraceError(
      `Invalid timeout ${ms}ms. Use -1 for never sleep, or a value between 5000 and 3600000ms.`,
      'Invalid screen-off timeout value.'
    );
  }
  const spinner = ora({
    text: neverSleep
      ? 'Disabling screen-off...'
      : `Setting screen-off timeout to ${ms}ms...`,
    color: 'cyan',
  }).start();

  try {
    if (neverSleep) {
      await adapter.setScreenNeverSleep(serial);
    } else {
      await adapter.setScreenTimeout(serial, ms);
    }
    spinner.stop();
    console.log(
      neverSleep
        ? 'Screen-off disabled (always on).'
        : `Screen-off timeout set to ${ms}ms.`
    );
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to set screen-off timeout: ${(error as Error).message}`,
      'Failed to set screen-off timeout.'
    );
  }
}

async function screenRotateAction(
  toolProvider: ToolProvider,
  rotation: number,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const spinner = ora({
    text: `Setting screen rotation to ROTATION_${rotation}...`,
    color: 'cyan',
  }).start();

  try {
    const { driver, dispose } = await createUiDriver(toolProvider.hdcPath, serial);
    try {
      await driver.setDisplayRotation(rotation);
    } finally {
      await dispose();
    }
    spinner.stop();
    console.log(`Screen rotation set to ROTATION_${rotation}.`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to set screen rotation: ${(error as Error).message}`,
      'Failed to set screen rotation.'
    );
  }
}

async function screenRotationAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const spinner = ora({
    text: 'Querying screen rotation...',
    color: 'cyan',
  }).start();

  try {
    const { driver, dispose } = await createUiDriver(toolProvider.hdcPath, serial);
    try {
      const rotation = await driver.getDisplayRotation();
      spinner.stop();
      console.log(`Screen rotation: ROTATION_${rotation}`);
    } finally {
      await dispose();
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to get screen rotation: ${(error as Error).message}`,
      'Failed to get screen rotation.'
    );
  }
}

async function screenRotationLockAction(
  toolProvider: ToolProvider,
  lockEnabled: boolean,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const spinner = ora({
    text: `${lockEnabled ? 'Locking' : 'Unlocking'} screen rotation...`,
    color: 'cyan',
  }).start();

  try {
    const { driver, dispose } = await createUiDriver(toolProvider.hdcPath, serial);
    try {
      await driver.setDisplayRotationEnabled(!lockEnabled);
    } finally {
      await dispose();
    }
    spinner.stop();
    if (lockEnabled) {
      console.log('Screen rotation locked (auto-rotation disabled).');
    } else {
      console.log('Screen rotation unlocked (auto-rotation enabled).');
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to set rotation lock: ${(error as Error).message}`,
      'Failed to set rotation lock.'
    );
  }
}

export const screenCommand = new Command('screen').description(
  'Query and manage screen properties'
);

screenCommand
  .command('size')
  .description('Query screen resolution')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .action(async (options: { device?: string; format: 'default' | 'json' }) => {
    const { device, format } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'screen',
        'size',
        ...(format === 'json' ? ['--format', 'json'] : []),
        ...(device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await screenSizeAction(toolProvider, device, format);
    });
  });

screenCommand
  .command('rotation')
  .description('Query current screen rotation')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .action(async (options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'screen', 'rotation', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await screenRotationAction(toolProvider, device);
    });
  });

screenCommand
  .command('sleeptime')
  .description('Set screen-off timeout in milliseconds; use -1 for never')
  .allowUnknownOption()
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<ms>', 'Screen-off timeout in milliseconds; -1 for never')
  .action(async (ms: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'screen', 'sleeptime', '<ms>', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await screenSleeptimeAction(toolProvider, Number(ms), device);
    });
  });

screenCommand
  .command('rotate')
  .description('Set screen rotation (clockwise)')
  .argument('<rotation>', 'Rotation angle: 0, 90, 180, or 270')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .action(async (rotation: string, options: { device?: string }) => {
    const { device } = options;
    const angle = Number(rotation);
    const validRotations = [0, 90, 180, 270];
    if (!validRotations.includes(angle)) {
      throw new TraceError(
        `Invalid rotation "${rotation}". Valid values: 0, 90, 180, 270`,
        'Invalid rotation value.'
      );
    }
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'screen', 'rotate', '<rotation>', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await screenRotateAction(toolProvider, angle, device);
    });
  });

screenCommand
  .command('rotation-lock')
  .description('Lock or unlock screen rotation (on=lock/disable auto-rotation, off=unlock/enable auto-rotation)')
  .argument('<state>', 'on or off')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .action(async (state: string, options: { device?: string }) => {
    const { device } = options;
    if (state !== 'on' && state !== 'off') {
      throw new TraceError(
        `Invalid state "${state}". Valid values: on, off`,
        'Invalid rotation-lock state.'
      );
    }
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'screen', 'rotation-lock', '<state>', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await screenRotationLockAction(toolProvider, state === 'on', device);
    });
  });
