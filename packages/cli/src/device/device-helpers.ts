/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ToolProvider } from '../toolchain/index.js';
import { DeviceManager } from '../service/device-manager.js';
import { red } from 'colorette';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
  TraceError,
} from '../trace/index.js';

export async function withDeviceTrace(
  event: CommandExecuted,
  action: () => Promise<void>
): Promise<void> {
  const start = Date.now();
  let success = true;
  let errorCode: string | null = null;
  try {
    await action();
  } catch (error) {
    success = false;
    errorCode = toTraceErrorCode(error);
    console.error(red((error as Error).message));
    process.exitCode = 1;
  } finally {
    const measurement: TrackMeasurement = {
      duration_ms: Date.now() - start,
      success,
      error_code: errorCode,
    };
    await telemetry.track(event, measurement);
  }
}

export async function initDeviceManager(): Promise<{
  manager: DeviceManager;
  toolProvider: ToolProvider;
}> {
  try {
    const toolProvider = await ToolProvider.new();
    const manager = DeviceManager.from(toolProvider);
    return { manager, toolProvider };
  } catch (error) {
    throw new TraceError(
      `Failed to initialize device manager: ${(error as Error).message}`,
      'Failed to initialize device manager.'
    );
  }
}

export { TraceError };
export type { CommandExecuted };
export { EventType };
