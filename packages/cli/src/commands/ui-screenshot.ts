/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green } from 'colorette';
import { ToolProvider } from '../toolchain/index.js';
import { resolveDeviceSerial } from '../utils/device-selector.js';
import { ScreenshotCapturer } from '../ui/index.js';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
} from '../trace/index.js';

interface ScreenshotOptions {
  device?: string;
  display?: string;
  path?: string;
}

function buildScreenshotEvent(options: ScreenshotOptions): CommandExecuted {
  return {
    event: EventType.CommandExecuted,
    args: ['ui', 'screenshot', ...(options.device ? ['--device'] : [])],
  };
}

function parseDisplayId(input: string): string {
  const text = input.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error('--display must be a non-negative integer.');
  }
  return text;
}

async function screenshotAction(options: ScreenshotOptions): Promise<void> {
  const event = buildScreenshotEvent(options);
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    if (options.device !== undefined && !options.device.trim()) {
      throw new Error('--device must not be empty.');
    }
    const display =
      options.display !== undefined
        ? parseDisplayId(options.display)
        : undefined;
    const toolProvider = await ToolProvider.new();
    const capturer = new ScreenshotCapturer(toolProvider);
    const localPath = capturer.resolveDestinationPath(options.path);
    const serial = await resolveDeviceSerial(toolProvider, options.device);
    await capturer.captureToPath(serial, localPath, display);
    console.log(green(`Screenshot saved to ${localPath}`));
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

export const screenshotCommand = new Command('screenshot')
  .description('Capture a screenshot of the device screen')
  .option(
    '--device <name|serial>',
    'Target device name or serial; required when multiple devices are connected'
  )
  .option('--display <displayId>', 'Target display id; omit for default screen')
  .option(
    '--path <path>',
    'Required directory or PNG file path; destination must be writable'
  )
  .action(screenshotAction);
