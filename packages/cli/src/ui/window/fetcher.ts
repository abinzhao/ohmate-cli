/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { debugLog } from '../../utils/logger.js';
import type { WindowInfo } from './types.js';

export class WindowAdapter {
  constructor(
    private readonly hdcPath: string,
    private readonly serial: string
  ) {}

  async listWindows(options?: { all?: boolean }): Promise<WindowInfo[]> {
    const stdout = await this.fetchDump();
    let windows = parseWindowList(stdout);
    if (!options?.all) {
      windows = windows.filter((w) => w.type === 1);
    }
    return windows;
  }

  private async fetchDump(): Promise<string> {
    const args = [
      '-t',
      this.serial,
      'shell',
      'hidumper',
      '-s',
      'WindowManagerService',
      '-a',
      '-a',
    ];
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const result = await runHdcWithRetry(this.hdcPath, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to query windows: ${(result.stderr || result.stdout).trim()}`
      );
    }
    return result.stdout;
  }
}

/**
 * Parse the `hidumper -s WindowManagerService -a -a` window table.
 *
 * Assumes the table is whitespace-separated with columns
 * `WindowName DisplayId PID WinId Type` and that `WindowName` is a single
 * token (no embedded spaces). The focused window is read from the trailing
 * `Focus window: <id>` line. Returns `[]` if the header row is absent.
 */
function parseWindowList(raw: string): WindowInfo[] {
  const lines = raw.split('\n');
  const headerIdx = lines.findIndex((l) =>
    l.trimStart().startsWith('WindowName')
  );
  if (headerIdx === -1) {
    return [];
  }

  const windows: Array<Omit<WindowInfo, 'focused'>> = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      !line ||
      /^-+$/.test(line) ||
      line.startsWith('Focus window') ||
      line.startsWith('total window')
    ) {
      break;
    }
    const tokens = line.split(/\s+/);
    if (tokens.length < 5) {
      continue;
    }
    const name = tokens[0];
    const displayId = Number(tokens[1]);
    const pid = Number(tokens[2]);
    const winId = Number(tokens[3]);
    const type = Number(tokens[4]);
    if (
      Number.isFinite(winId) &&
      Number.isFinite(displayId) &&
      Number.isFinite(pid)
    ) {
      windows.push({ id: winId, name, pid, displayId, type });
    }
  }

  const focusLine = lines.find((l) => l.trim().startsWith('Focus window'));
  const focusId = focusLine
    ? Number(focusLine.replace(/.*:\s*/, '').trim())
    : NaN;

  return windows.map((w) => ({ ...w, focused: w.id === focusId }));
}
