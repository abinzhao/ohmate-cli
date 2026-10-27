/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ToolProvider } from '../../toolchain/tool-provider.js';
import { resolveDeviceSerial } from '../../utils/device-selector.js';
import { ArkUiDumpAdapter } from '../layout/dump-adapter.js';
import { WindowAdapter } from '../window/fetcher.js';
import type { WindowInfo } from '../window/types.js';
import { findNodesInTree } from '../layout/parsers.js';
import type { ArkUiNode } from '../layout/types.js';
import { runHdcWithRetry } from '../../utils/hdc-param.js';
import { TraceError } from '../../trace/index.js';
import { debugLog } from '../../utils/logger.js';

export async function initDevice(deviceArg?: string) {
  const toolProvider = await ToolProvider.new();
  const deviceId = await resolveDeviceSerial(toolProvider, deviceArg);
  return { hdcPath: toolProvider.hdcPath, deviceId };
}

export async function resolveTarget(
  hdcPath: string,
  deviceId: string,
  x: number | undefined,
  y: number | undefined,
  nodeId: string | undefined,
  windowId: string | undefined
): Promise<{ x: number; y: number }> {
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }
  if (nodeId === undefined) {
    throw new Error('Either provide x y coordinates or use --id');
  }

  const windowAdapter = new WindowAdapter(hdcPath, deviceId);
  const windows = await windowAdapter.listWindows({ all: true });
  const dumpAdapter = new ArkUiDumpAdapter(hdcPath);
  return resolveByNodeId(dumpAdapter, deviceId, windows, nodeId, windowId);
}

async function resolveByNodeId(
  dumpAdapter: ArkUiDumpAdapter,
  deviceId: string,
  windows: WindowInfo[],
  nodeId: string,
  windowId: string | undefined
): Promise<{ x: number; y: number }> {
  if (windowId !== undefined) {
    const win = windows.find((w) => String(w.id) === windowId);
    if (win && win.displayId !== 0) {
      throw new TraceError(
        `Window "${windowId}" is on display ${win.displayId}. ` +
        'The current command only supports operations on the primary display.',
        'The current command only supports operations on the primary display.'
      );
    }
    const tree = await dumpAdapter.dumpFullTree(deviceId, 0, windowId, false);
    return findSingleMatch(tree, nodeId);
  }
  return resolveAcrossDisplays(dumpAdapter, deviceId, windows, nodeId);
}

async function resolveAcrossDisplays(
  dumpAdapter: ArkUiDumpAdapter,
  deviceId: string,
  windows: WindowInfo[],
  nodeId: string
): Promise<{ x: number; y: number }> {
  const displayIds = [...new Set(windows.map((w) => w.displayId))];
  const displayTrees = await dumpAdapter.dumpFullTreeByDisplays(deviceId, 0, displayIds);

  const allMatches: { node: ArkUiNode; displayId: number }[] = [];
  for (const { displayId, tree } of displayTrees) {
    for (const node of findNodesInTree([tree], nodeId)) {
      allMatches.push({ node, displayId });
    }
  }

  if (allMatches.length === 0) {
    throw new TraceError(`Node "${nodeId}" not found.`, 'Node not found.');
  }
  if (allMatches.length > 1) {
    throw new TraceError(`Multiple nodes found with id "${nodeId}".`, 'Multiple nodes found');
  }
  if (allMatches[0].displayId !== 0) {
      throw new TraceError(
        `Node "${nodeId}" is on display ${allMatches[0].displayId}. ` +
        'The current command only supports operations on the primary display.',
        'The current command only supports operations on the primary display.'
      );
  }
  return extractNodeBounds(allMatches[0].node, nodeId);
}

function findSingleMatch(
  tree: ArkUiNode[],
  nodeId: string
): { x: number; y: number } {
  const matched = findNodesInTree(tree, nodeId);
  if (matched.length === 0) {
    throw new TraceError(`Node "${nodeId}" not found.`, 'Node not found.');
  }
  if (matched.length > 1) {
    throw new TraceError(`Multiple nodes found with id "${nodeId}".`, 'Multiple nodes found');
  }
  return extractNodeBounds(matched[0], nodeId);
}

function extractNodeBounds(
  node: ArkUiNode,
  nodeId: string
): { x: number; y: number } {
  const nodeBounds = node.bounds;
  if (!nodeBounds) {
    throw new TraceError(`Node "${nodeId}" has no bounds.`, 'Node has no bounds.');
  }
  const [left, top, right, bottom] = nodeBounds;
  return {
    x: Math.ceil((left + right) / 2),
    y: Math.ceil((top + bottom) / 2),
  };
}

export async function runHdcShell(
  hdcPath: string,
  deviceId: string,
  shellArgs: string[]
): Promise<void> {
  const args = ['-t', deviceId, 'shell', ...shellArgs];
  debugLog(`Executing: ${hdcPath} ${args.join(' ')}`);
  const result = await runHdcWithRetry(hdcPath, args);

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
      result.stdout ||
      `uitest exited with code ${result.exitCode}`
    );
  }

  const lower = result.stdout.toLowerCase();
  const failKeywords = [
    'illegal',
    'fail',
    'error',
    'incorrect',
    'please confirm that the coordinate values are correct',
  ];
  if (
    failKeywords.some((k) => lower.includes(k)) &&
    !lower.includes('no error')
  ) {
    throw new Error(result.stdout.trim() || 'uitest command failed');
  }
}
