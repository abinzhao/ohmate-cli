/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { red, yellow } from 'colorette';
import ora from 'ora';
import {
  withDeviceTrace,
  initDeviceManager,
  TraceError,
  type CommandExecuted,
  EventType,
} from '../device/device-helpers.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { SystemAdapter } from '../device/system/index.js';
import { parseDisplaySize, parseScreenState } from '../device/screen/index.js';

/** Device types that support gesture-based operations (unlock, control center, notification center) */
const GESTURE_SUPPORTED_TYPES = ['phone', 'tablet'];

async function assertGestureSupported(toolProvider: ToolProvider, serial: string): Promise<void> {
  const adapter = new SystemAdapter(toolProvider);
  const raw = await adapter.getDeviceType(serial);
  const deviceType = raw.trim().toLowerCase();
  if (!GESTURE_SUPPORTED_TYPES.includes(deviceType)) {
    throw new TraceError(
      `This command is only supported on phone and tablet devices (current: ${deviceType || 'unknown'}).`,
      'Unsupported device type.'
    );
  }
}

async function wakeAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new SystemAdapter(toolProvider);
  const spinner = ora({
    text: 'Waking screen...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.wakeScreen(serial);
    spinner.stop();
    const result = output.trim();
    if (result) {
      console.log(result);
    } else {
      console.log('Screen woken.');
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to wake screen: ${(error as Error).message}`,
      'Failed to wake screen.'
    );
  }
}

async function sleepAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new SystemAdapter(toolProvider);
  const spinner = ora({
    text: 'Suspending screen...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.suspendScreen(serial);
    spinner.stop();
    const result = output.trim();
    if (result) {
      console.log(result);
    } else {
      console.log('Screen suspended.');
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to suspend screen: ${(error as Error).message}`,
      'Failed to suspend screen.'
    );
  }
}

async function statusAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new SystemAdapter(toolProvider);
  const spinner = ora({
    text: 'Querying screen status...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.getScreenStatus(serial);
    spinner.stop();
    const state = parseScreenState(output);
    if (state) {
      console.log(`  Screen State: ${state}`);
    } else {
      console.log(yellow('No screen state found in output.'));
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to get screen status: ${(error as Error).message}`,
      'Failed to get screen status.'
    );
  }
}

async function unlockAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  await assertGestureSupported(toolProvider, serial);
  const adapter = new SystemAdapter(toolProvider);
  const spinner = ora({
    text: 'Unlocking screen...',
    color: 'cyan',
  }).start();

  try {
    await adapter.wakeScreen(serial);
    const output = await adapter.getDisplayInfo(serial);
    const size = parseDisplaySize(output);
    if (!size) {
      throw new Error('Failed to parse screen resolution from display info');
    }
    const x = Math.round(size.width / 2);
    const yStart = Math.round(size.height * 0.98);
    const yEnd = yStart - Math.round(size.height / 2);
    await adapter.swipeScreen(serial, x, yStart, x, yEnd);
    spinner.stop();
    console.log(
      `Screen unlocked: swipe (${x}, ${yStart}) -> (${x}, ${yEnd})`
    );
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to unlock screen: ${(error as Error).message}`,
      'Failed to unlock screen.'
    );
  }
}

async function openControlCenterAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  await assertGestureSupported(toolProvider, serial);
  const adapter = new SystemAdapter(toolProvider);
  const spinner = ora({
    text: 'Opening control center...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.getDisplayInfo(serial);
    const size = parseDisplaySize(output);
    if (!size) {
      throw new Error('Failed to parse screen resolution from display info');
    }
    const x = Math.round((size.width * 4) / 5);
    const yStart = Math.round(size.height * 0.02);
    const yEnd = yStart + Math.round(size.height / 3);
    await adapter.swipeScreen(serial, x, yStart, x, yEnd);
    spinner.stop();
    console.log(
      `Control center opened: swipe (${x}, ${yStart}) -> (${x}, ${yEnd})`
    );
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to open control center: ${(error as Error).message}`,
      'Failed to open control center.'
    );
  }
}

async function openNotificationCenterAction(
  toolProvider: ToolProvider,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  await assertGestureSupported(toolProvider, serial);
  const adapter = new SystemAdapter(toolProvider);
  const spinner = ora({
    text: 'Opening notification center...',
    color: 'cyan',
  }).start();

  try {
    const output = await adapter.getDisplayInfo(serial);
    const size = parseDisplaySize(output);
    if (!size) {
      throw new Error('Failed to parse screen resolution from display info');
    }
    const x = Math.round(size.width / 5);
    const yStart = Math.round(size.height * 0.02);
    const yEnd = yStart + Math.round(size.height / 3);
    await adapter.swipeScreen(serial, x, yStart, x, yEnd);
    spinner.stop();
    console.log(
      `Notification center opened: swipe (${x}, ${yStart}) -> (${x}, ${yEnd})`
    );
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Failed to open notification center: ${(error as Error).message}`,
      'Failed to open notification center.'
    );
  }
}

const TIME_FORMAT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

async function timeAction(
  toolProvider: ToolProvider,
  datetime: string | undefined,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new SystemAdapter(toolProvider);
  const isSet = datetime !== undefined;

  if (isSet && !TIME_FORMAT_RE.test(datetime!)) {
    throw new TraceError(
      `Invalid time format. Time must be in 'YYYY-MM-DD HH:MM:SS' format (e.g. "2026-10-13 17:18:07").`,
      'Invalid time format.'
    );
  }

  const spinner = ora({
    text: isSet
      ? `Setting time to ${datetime}...`
      : 'Getting time...',
    color: 'cyan',
  }).start();

  try {
    const output = isSet
      ? await adapter.setTime(serial, datetime!)
      : await adapter.getTime(serial);
    spinner.stop();
    const result = output.trim();
    if (/^error/i.test(result)) {
      console.error(red(result));
      process.exitCode = 1;
    } else {
      console.log(result);
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Time ${isSet ? 'set' : 'get'} failed: ${(error as Error).message}`,
      `Time ${isSet ? 'set' : 'get'} failed.`
    );
  }
}

async function timezoneAction(
  toolProvider: ToolProvider,
  timezone: string | undefined,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new SystemAdapter(toolProvider);
  const isSet = timezone !== undefined;
  const spinner = ora({
    text: isSet
      ? `Setting timezone to ${timezone}...`
      : 'Getting timezone...',
    color: 'cyan',
  }).start();

  try {
    const output = isSet
      ? await adapter.setTimezone(serial, timezone)
      : await adapter.getTimezone(serial);
    spinner.stop();
    const result = output.trim();
    if (/^error/i.test(result)) {
      console.error(red(result));
      process.exitCode = 1;
    } else {
      console.log(result);
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Timezone ${isSet ? 'set' : 'get'} failed: ${(error as Error).message}`,
      `Timezone ${isSet ? 'set' : 'get'} failed.`
    );
  }
}

export const systemCommands: Command[] = [
  new Command('wake')
    .description('Wake up the device screen')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .action(async (options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: ['device', 'wake', ...(device ? ['--device'] : [])],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await wakeAction(toolProvider, device);
      });
    }),
  new Command('sleep')
    .description('Turn off the device screen')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .action(async (options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: ['device', 'sleep', ...(device ? ['--device'] : [])],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await sleepAction(toolProvider, device);
      });
    }),
  new Command('status')
    .description('Query screen power state')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .action(async (options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: ['device', 'status', ...(device ? ['--device'] : [])],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await statusAction(toolProvider, device);
      });
    }),
  new Command('unlock')
    .description('Unlock the screen')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .action(async (options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: ['device', 'unlock', ...(device ? ['--device'] : [])],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await unlockAction(toolProvider, device);
      });
    }),
  new Command('open-control-center')
    .description('Open the control center')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .action(async (options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: ['device', 'open-control-center', ...(device ? ['--device'] : [])],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await openControlCenterAction(toolProvider, device);
      });
    }),
  new Command('open-notification-center')
    .description('Open the notification center')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .action(async (options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: [
          'device',
          'open-notification-center',
          ...(device ? ['--device'] : []),
        ],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await openNotificationCenterAction(toolProvider, device);
      });
    }),
  new Command('time')
    .description('Get or set the device time')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .argument('[datetime]', 'Datetime to set; omit to get current time')
    .action(async (datetime: string | undefined, options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: [
          'device',
          'time',
          ...(datetime ? ['<datetime>'] : []),
          ...(device ? ['--device'] : []),
        ],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await timeAction(toolProvider, datetime, device);
      });
    }),
  new Command('timezone')
    .description('Get or set the device timezone')
    .option('--device <name|serial>', 'Target device (name or serial)')
    .argument('[timezone]', 'Timezone to set; omit to get current timezone')
    .action(
      async (timezone: string | undefined, options: { device?: string }) => {
        const { device } = options;
        const event: CommandExecuted = {
          event: EventType.CommandExecuted,
          args: [
            'device',
            'timezone',
            ...(timezone ? ['<timezone>'] : []),
            ...(device ? ['--device'] : []),
          ],
        };
        await withDeviceTrace(event, async () => {
          const { toolProvider } = await initDeviceManager();
          await timezoneAction(toolProvider, timezone, device);
        });
      }
    ),
];
