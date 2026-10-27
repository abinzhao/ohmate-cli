/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { ArkUiNode, RawDumpAttributes } from './types.js';

export function normalizeHitTestBehavior(raw?: string): string | undefined {
  if (!raw || raw === 'HitTestMode.Default') {
    return undefined;
  }
  return raw.startsWith('HitTestMode.')
    ? raw.slice('HitTestMode.'.length)
    : raw;
}

export function parseNullableBool(value: unknown): boolean | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

export function parseBounds(
  raw: unknown
): [number, number, number, number] | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const nums = raw.match(/-?\d+/g);
  if (!nums || nums.length < 4) {
    return undefined;
  }
  return [Number(nums[0]), Number(nums[1]), Number(nums[2]), Number(nums[3])];
}

export function resolveText(a: RawDumpAttributes): string | undefined {
  return a.originalText || undefined;
}

export function findNodesInTree(
  nodes: ArkUiNode[],
  id: string
): ArkUiNode[] {
  const found: ArkUiNode[] = [];
  const stack: ArkUiNode[] = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) {
      found.push(node);
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }
  return found;
}
