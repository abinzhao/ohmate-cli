/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option } from 'commander';
import { yellow } from 'colorette';
import { ToolProvider } from '../toolchain/index.js';
import { WindowAdapter } from '../ui/index.js';
import { renderTable } from '../utils/text-table.js';
import ora from 'ora';
import type { WindowInfo } from '../ui/index.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
} from '../trace/index.js';

interface WindowListOptions {
  device?: string;
  format: 'default' | 'json';
  all?: boolean;
}

const WINDOW_LIST_HEADERS = [
  'Id',
  'Name',
  'Pid',
  'DisplayId',
  'Focused',
] as const;

function formatWindowOutput(windows: WindowInfo[], format: 'default' | 'json') {
  if (format === 'json') {
    const output = windows.map((w) => ({
      id: w.id,
      name: w.name,
      pid: w.pid,
      displayId: w.displayId,
      focused: w.focused,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const rows = windows.map((w) => ({
    cells: [
      String(w.id),
      w.name,
      String(w.pid),
      String(w.displayId),
      String(w.focused),
    ],
    highlight: w.focused,
  }));
  console.log(renderTable(WINDOW_LIST_HEADERS, rows));
}

async function handleWindowList(options: WindowListOptions) {
  const spinner = ora({ text: 'Listing windows…', color: 'cyan' }).start();
  let windows: Awaited<ReturnType<WindowAdapter['listWindows']>>;
  try {
    const toolProvider = await ToolProvider.new();
    const serial = await resolveDeviceSerial(toolProvider, options.device);

    const windowAdapter = new WindowAdapter(toolProvider.hdcPath, serial);
    windows = await windowAdapter.listWindows({ all: options.all });
  } catch (error) {
    spinner.stop();
    throw new Error(`Failed to list windows: ${(error as Error).message}`, {
      cause: error,
    });
  }
  spinner.stop();

  if (windows.length === 0) {
    console.log(yellow('  No windows found.'));
    return;
  }

  formatWindowOutput(windows, options.format);
}

function buildWindowListEvent(options: WindowListOptions): CommandExecuted {
  const flags: string[] = [];
  if (options.device) {
    flags.push('--device');
  }
  if (options.format !== 'default') {
    flags.push('--format');
  }
  if (options.all) {
    flags.push('--all');
  }
  return {
    event: EventType.CommandExecuted,
    args: ['ui', 'window', 'list', ...flags],
  };
}

async function trackWindowListCommand(
  options: WindowListOptions
): Promise<void> {
  const event = buildWindowListEvent(options);
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await handleWindowList(options);
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

export const windowCommand = new Command('window').description(
  'Manage device windows'
);

windowCommand
  .command('list')
  .description('List windows on the device')
  .option('--device <name|serial>', 'Target device (name or serial)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['default', 'json'])
      .default('default')
  )
  .option('--all', 'Show all windows including system windows')
  .action(async (options: WindowListOptions) => {
    await trackWindowListCommand(options);
  });
