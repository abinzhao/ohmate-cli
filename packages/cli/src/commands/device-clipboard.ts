/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { gray } from 'colorette';
import ora from 'ora';
import {
  withDeviceTrace,
  initDeviceManager,
  TraceError,
  type CommandExecuted,
  EventType,
} from '../device/device-helpers.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { ClipboardAdapter } from '../device/clipboard/index.js';

async function clipboardAction(
  toolProvider: ToolProvider,
  operation: 'read' | 'write' | 'clear',
  text: string | undefined,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new ClipboardAdapter(toolProvider);
  const spinner = ora({
    text: `Clipboard ${operation}...`,
    color: 'cyan',
  }).start();

  try {
    let result: string;
    if (operation === 'read') {
      result = await adapter.readClipboard(serial);
    } else if (operation === 'write') {
      result = await adapter.writeClipboard(serial, text ?? '');
    } else {
      result = await adapter.clearClipboard(serial);
    }
    spinner.stop();
    if (operation === 'read') {
      // Strip "Pasteboard text: " prefix, output raw content only
      const content = result.trim().replace(/^Pasteboard text:\s*/, '');
      console.log(content || gray('(clipboard is empty)'));
    } else {
      const summary = operation === 'write' ? 'written' : 'cleared';
      console.log(`Clipboard ${summary}.`);
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Clipboard ${operation} failed: ${(error as Error).message}`,
      `Clipboard ${operation} failed.`
    );
  }
}

export const clipboardCommand = new Command('clipboard').description(
  'Read, write, or clear the device clipboard'
);

clipboardCommand
  .command('read')
  .description('Read current clipboard text from the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .action(async (options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'clipboard',
        'read',
        ...(device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await clipboardAction(toolProvider, 'read', undefined, device);
    });
  });

clipboardCommand
  .command('write')
  .description('Write text to the device clipboard')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<text>', 'Text to write to the clipboard')
  .action(
    async (text: string, options: { device?: string }) => {
      const { device } = options;
      const event: CommandExecuted = {
        event: EventType.CommandExecuted,
        args: [
          'device',
          'clipboard',
          'write',
          ...(device ? ['--device'] : []),
        ],
      };
      await withDeviceTrace(event, async () => {
        const { toolProvider } = await initDeviceManager();
        await clipboardAction(
          toolProvider,
          'write',
          text,
          device
        );
      });
    }
  );

clipboardCommand
  .command('clear')
  .description('Clear the device clipboard')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .action(async (options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'device',
        'clipboard',
        'clear',
        ...(device ? ['--device'] : []),
      ],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await clipboardAction(toolProvider, 'clear', undefined, device);
    });
  });
