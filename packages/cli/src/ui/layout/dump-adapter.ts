/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { debugLog } from '../../utils/logger.js';
import { WindowAdapter } from '../window/fetcher.js';
import type { WindowInfo } from '../window/types.js';
import {
  parseBounds,
  parseNullableBool,
  normalizeHitTestBehavior,
  resolveText,
} from './parsers.js';
import { collapse } from './collapse.js';
import type { RawDumpNode, RawDumpAttributes, ArkUiNode } from './types.js';
import { TraceError } from '../../trace/index.js';

function parseDumpFile(localPath: string): RawDumpNode {
  const jsonStr = readFileSync(localPath, 'utf-8').trim();
  if (!jsonStr) {
    throw new Error('Empty dumpLayout response from device');
  }
  return JSON.parse(jsonStr) as RawDumpNode;
}

function getAttr(node: RawDumpNode): RawDumpAttributes {
  return node.attributes ?? {};
}

function toSummaryTree(
  raw: RawDumpNode,
  maxDepth: number,
  currentDepth: number
): ArkUiNode {
  const a = getAttr(raw);
  const node: ArkUiNode = {
    id: a.id || undefined,
    type: a.type || undefined,
    text: resolveText(a),
    bounds: parseBounds(a.bounds),
    clickable: parseNullableBool(a.clickable) || undefined,
    longClickable: parseNullableBool(a.longClickable) || undefined,
    scrollable: parseNullableBool(a.scrollable) || undefined,
    checkable: parseNullableBool(a.checkable) || undefined,
    hitTestBehavior: normalizeHitTestBehavior(a.hitTestBehavior),
    children: [],
  };

  if (maxDepth > 0 && currentDepth + 1 >= maxDepth) {
    return node;
  }

  if (raw.children) {
    node.children = raw.children.map((child) =>
      toSummaryTree(child, maxDepth, currentDepth + 1)
    );
  }

  return node;
}

function resolveWindow(
  windows: WindowInfo[],
  windowId?: string
): WindowInfo {
  if (windowId) {
    const match = windows.find((w) => String(w.id) === windowId);
    if (!match) {
      const available = windows.map((w) => `${w.id} (${w.name})`).join(', ');
      throw new TraceError(
        `Window '${windowId}' not found. Available windows: ${available || 'none'}`,
        'Window not found.'
      );
    }
    return match;
  }
  const focused = windows.find((w) => w.focused);
  if (focused) {
    return focused;
  }
  throw new Error('No window id specified and could not detect focused window');
}

export class ArkUiDumpAdapter {
  private hdcPath: string;

  constructor(hdcPath: string) {
    this.hdcPath = hdcPath;
  }

  private buildRemoteDumpPath(): string {
    return `/data/local/tmp/deveco_cli_dump_${Date.now()}_${process.pid}.json`;
  }

  private async fetchRawDump(
    serial: string,
    windowId?: string,
    displayId?: number
  ): Promise<RawDumpNode> {
    const remoteDumpPath = this.buildRemoteDumpPath();
    const args = [
      '-t',
      serial,
      'shell',
      'uitest',
      'dumpLayout',
      '-p',
      remoteDumpPath,
    ];
    if (displayId !== undefined) {
      args.push('-d', String(displayId));
    }
    if (windowId) {
      args.push('-w', windowId);
    }
    debugLog(`Executing: ${this.hdcPath} ${args.join(' ')}`);
    const dumpResult = await runHdcWithRetry(this.hdcPath, args);
    if (dumpResult.exitCode !== 0) {
      throw new Error(
        `Failed to dump layout: ${(dumpResult.stderr || dumpResult.stdout).trim()}`
      );
    }
    return this.recvAndParseDump(serial, remoteDumpPath);
  }

  private async recvAndParseDump(
    serial: string,
    remoteDumpPath: string
  ): Promise<RawDumpNode> {
    const localPath = join(
      tmpdir(),
      `deveco_cli_dump_${Date.now()}_${process.pid}.json`
    );
    try {
      await this.recvDumpFile(serial, remoteDumpPath, localPath);
      return parseDumpFile(localPath);
    } finally {
      await this.cleanupDumpArtifacts(serial, localPath, remoteDumpPath);
    }
  }

  private async recvDumpFile(
    serial: string,
    remoteDumpPath: string,
    localPath: string
  ): Promise<void> {
    const recvArgs = [
      '-t',
      serial,
      'file',
      'recv',
      remoteDumpPath,
      localPath,
    ];
    debugLog(`Executing: ${this.hdcPath} ${recvArgs.join(' ')}`);
    const recvResult = await runHdcWithRetry(this.hdcPath, recvArgs);
    if (recvResult.exitCode !== 0) {
      throw new Error(
        `Failed to recv dump file: ${(recvResult.stderr || recvResult.stdout).trim()}`
      );
    }
  }

  private async cleanupDumpArtifacts(
    serial: string,
    localPath: string,
    remoteDumpPath: string
  ): Promise<void> {
    try {
      debugLog(`Removing local dump file: ${localPath}`);
      unlinkSync(localPath);
    } catch (error) {
      debugLog(
        `Failed to clean local dump file ${localPath}: ${(error as Error).message}`
      );
    }
    const rmArgs = ['-t', serial, 'shell', 'rm', '-f', remoteDumpPath];
    debugLog(`Executing: ${this.hdcPath} ${rmArgs.join(' ')}`);
    await runHdcWithRetry(this.hdcPath, rmArgs).catch((error) => {
      debugLog(
        `Failed to clean remote dump file ${remoteDumpPath}: ${(error as Error).message}`
      );
    });
  }

  private async dumpRawNodes(
    serial: string,
    windowId?: string,
    allWindows?: boolean
  ): Promise<RawDumpNode[]> {
    const windowAdapter = new WindowAdapter(this.hdcPath, serial);
    const windows = await windowAdapter.listWindows({ all: true });
    if (allWindows) {
      const displayIds = [...new Set(windows.map((w) => w.displayId))];
      const results: RawDumpNode[] = [];
      for (const displayId of displayIds) {
        results.push(await this.fetchRawDump(serial, undefined, displayId));
      }
      return results;
    }
    const win = resolveWindow(windows, windowId);
    return [await this.fetchRawDump(serial, String(win.id), win.displayId)];
  }

  async dumpFullTree(
    serial: string,
    depth: number,
    windowId?: string,
    allWindows?: boolean
  ): Promise<ArkUiNode[]> {
    const raws = await this.dumpRawNodes(serial, windowId, allWindows);
    return raws.map((raw) => toSummaryTree(raw, depth, 0));
  }

  async dumpFullTreeByDisplays(
    serial: string,
    depth: number,
    displayIds: number[]
  ): Promise<{ displayId: number; tree: ArkUiNode }[]> {
    const results: { displayId: number; tree: ArkUiNode }[] = [];
    for (const displayId of displayIds) {
      const raw = await this.fetchRawDump(serial, undefined, displayId);
      results.push({ displayId, tree: toSummaryTree(raw, depth, 0) });
    }
    return results;
  }

  async dumpCollapsedTree(
    serial: string,
    depth: number,
    windowId?: string,
    allWindows?: boolean
  ): Promise<ArkUiNode[]> {
    const raws = await this.dumpRawNodes(serial, windowId, allWindows);
    return raws.flatMap((raw) => collapse(toSummaryTree(raw, 0, 0), depth));
  }

  async dumpRawTree(serial: string, windowId?: string): Promise<RawDumpNode> {
    const raws = await this.dumpRawNodes(serial, windowId, false);
    return raws[0];
  }
}
