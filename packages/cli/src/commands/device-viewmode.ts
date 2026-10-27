/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { red } from 'colorette';
import ora from 'ora';
import {
  withDeviceTrace,
  initDeviceManager,
  TraceError,
  type CommandExecuted,
  EventType,
} from '../device/device-helpers.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { ViewmodeAdapter } from '../device/viewmode/index.js';

async function viewmodeAction(
  toolProvider: ToolProvider,
  mode: string | undefined,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new ViewmodeAdapter(toolProvider);
  const isSet = mode !== undefined;

  if (isSet && mode !== 'dark' && mode !== 'light') {
    throw new TraceError(
      `Invalid viewmode "${mode}". Valid values: dark, light`,
      'Invalid viewmode value.'
    );
  }

  const spinner = ora({
    text: isSet
      ? `Setting viewmode to ${mode}...`
      : 'Getting viewmode...',
    color: 'cyan',
  }).start();

  try {
    const output = isSet
      ? await adapter.setViewmode(serial, mode)
      : await adapter.getViewmode(serial);
    spinner.stop();
    const result = output.trim();
    if (/fail/i.test(result)) {
      console.error(red(result));
      process.exitCode = 1;
    } else {
      console.log(result);
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Viewmode ${isSet ? 'set' : 'get'} failed: ${(error as Error).message}`,
      `Viewmode ${isSet ? 'set' : 'get'} failed.`
    );
  }
}

export const viewmodeCommand = new Command('viewmode')
  .description('Get or set the device view mode')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('[mode]', 'View mode to set (dark|light); omit to get current')
  .action(async (mode: string | undefined, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'viewmode',
        ...(mode ? [mode] : []),
        ...(device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await viewmodeAction(toolProvider, mode, device);
    });
  });
