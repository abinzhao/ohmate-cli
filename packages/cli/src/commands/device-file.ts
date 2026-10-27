/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../toolchain/index.js';
import { yellow } from 'colorette';
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
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { FileAdapter } from '../device/file/index.js';

async function fileAction(
  toolProvider: ToolProvider,
  direction: 'send' | 'recv',
  src: string,
  dst: string,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const isSend = direction === 'send';
  // Validate local file exists for send operation
  if (isSend && !existsSync(src)) {
    throw new TraceError(
      `File not found: ${src}`,
      'File not found.'
    );
  }
  const adapter = new HdcAdapter(toolProvider);
  const spinner = ora({
    text: isSend
      ? `Sending ${src} to ${dst}...`
      : `Receiving ${src} to ${dst}...`,
    color: 'cyan',
  }).start();

  try {
    await adapter.transferFile(serial, direction, src, dst);
    spinner.stop();
    const summary = isSend ? 'Sent to device' : 'Received from device';
    console.log(`${summary}: ${src} -> ${dst}`);
  } catch (error) {
    spinner.stop();
    const verb = isSend ? 'Send' : 'Recv';
    throw new TraceError(
      (error as Error).message,
      `File ${verb} failed.`
    );
  }
}

async function fileExistAction(
  toolProvider: ToolProvider,
  remotePath: string,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new FileAdapter(toolProvider);
  const spinner = ora({
    text: `Checking ${remotePath}...`,
    color: 'cyan',
  }).start();

  try {
    const exists = await adapter.fileExists(serial, remotePath);
    spinner.stop();
    if (exists) {
      console.log(`exists: ${remotePath}`);
    } else {
      console.log(yellow(`not found: ${remotePath}`));
      process.exitCode = 1;
    }
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Existence check failed: ${(error as Error).message}`,
      'Existence check failed.'
    );
  }
}

async function fileDeleteAction(
  toolProvider: ToolProvider,
  remotePath: string,
  device?: string
): Promise<void> {
  const serial = await resolveDeviceSerial(toolProvider, device);
  const adapter = new FileAdapter(toolProvider);
  const spinner = ora({
    text: `Deleting ${remotePath}...`,
    color: 'cyan',
  }).start();

  try {
    // Check if file exists before deleting
    const exists = await adapter.fileExists(serial, remotePath);
    if (!exists) {
      spinner.stop();
      throw new TraceError(
        `File not found: ${remotePath}`,
        'File not found.'
      );
    }
    const result = await adapter.deleteFile(serial, remotePath);
    spinner.stop();
    const trimmed = result.trim();
    if (trimmed && /error|no such file/i.test(trimmed)) {
      throw new Error(trimmed);
    }
    console.log(`Deleted ${remotePath}.`);
  } catch (error) {
    spinner.stop();
    throw new TraceError(
      `Delete failed: ${(error as Error).message}`,
      'Delete failed.'
    );
  }
}

export const fileCommand = new Command('file').description(
  'Transfer files between the host and a connected device'
);

fileCommand
  .command('send')
  .description('Send a local file to a device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<src>', 'Local file path to upload')
  .argument('<dst>', 'Remote path on the device')
  .action(async (src: string, dst: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'file', 'send', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fileAction(toolProvider, 'send', src, dst, device);
    });
  });

fileCommand
  .command('recv')
  .description('Receive a file from a device to the host')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<src>', 'Remote path on the device')
  .argument('<dst>', 'Local file path to save')
  .action(async (src: string, dst: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'file', 'recv', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fileAction(toolProvider, 'recv', src, dst, device);
    });
  });

fileCommand
  .command('exist')
  .description('Check if a file exists on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<path>', 'Remote path on the device to check')
  .action(async (path: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'file', 'exist', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fileExistAction(toolProvider, path, device);
    });
  });

fileCommand
  .command('delete')
  .description('Delete a file on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .argument('<path>', 'Remote path on the device to delete')
  .action(async (path: string, options: { device?: string }) => {
    const { device } = options;
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: ['device', 'file', 'delete', ...(device ? ['--device'] : [])],
    };
    await withDeviceTrace(event, async () => {
      const { toolProvider } = await initDeviceManager();
      await fileDeleteAction(toolProvider, path, device);
    });
  });
