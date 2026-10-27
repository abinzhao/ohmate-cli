/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { red } from 'colorette';
import { existsSync } from 'node:fs';
import ora from 'ora';
import {
  withDeviceTrace,
  initDeviceManager,
  TraceError,
  type CommandExecuted,
  EventType,
} from '../device/device-helpers.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { FontAdapter } from '../device/font/index.js';

async function fontAction(
  toolProvider: ToolProvider,
  op: 'install' | 'info' | 'uninstall',
  fontPath: string,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  // Validate local file exists for install/info operations (uninstall takes a font name, not a file path)
  if (op !== 'uninstall' && !existsSync(fontPath)) {
    throw new TraceError(
      `Font file not found: ${fontPath}`,
      'Font file not found.'
    );
  }
  const adapter = new FontAdapter(toolProvider);
  const spinner = ora({
    text: `Font ${op} ${fontPath}...`,
    color: 'cyan',
  }).start();

  try {
    let output: string;
    if (op === 'install') {
      output = await adapter.installFont(serial, fontPath);
    } else if (op === 'info') {
      output = await adapter.getFontInfo(serial, fontPath);
    } else {
      output = await adapter.uninstallFont(serial, fontPath);
    }
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
      (error as Error).message,
      `Font ${op} failed.`
    );
  }
}

export const fontCommand = new Command('font').description(
  'Manage device fonts'
);

fontCommand
  .command('install')
  .description('Install a font on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<fontpath>', 'Local font file path to install')
  .action(async (fontPath: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'font', 'install', '<fontpath>', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fontAction(toolProvider, 'install', fontPath, device);
    });
  });

fontCommand
  .command('info')
  .description('Get font name from a font file')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<fontpath>', 'Local font file path to query')
  .action(async (fontPath: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'font', 'info', '<fontpath>', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fontAction(toolProvider, 'info', fontPath, device);
    });
  });

fontCommand
  .command('uninstall')
  .description('Uninstall a font from the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<name>', 'Font name to uninstall')
  .action(async (name: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'font', 'uninstall', '<name>', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fontAction(toolProvider, 'uninstall', name, device);
    });
  });
