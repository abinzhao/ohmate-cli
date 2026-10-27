/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { debugLog } from '../../utils/logger.js';
import type { ArkUiNode } from './types.js';

interface StackEntry {
  current: ArkUiNode;
  parent: ArkUiNode | null;
  depth: number;
}

/**
 * Collapse a UI tree by folding non-interactive, label-less nodes into their
 * nearest emitted ancestor. A node is collapsible when it has no id, no text,
 * and no interactive flag (clickable / longClickable / scrollable / checkable);
 * the root is always emitted. `maxDepth` (>0) trims the collapsed output to
 * the given depth (nodes at `depth` where `depth + 1 >= maxDepth` are leaves).
 */
export function collapse(node: ArkUiNode, maxDepth: number): ArkUiNode[] {
  const roots: ArkUiNode[] = [];
  const stack: StackEntry[] = [{ current: node, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const { current, parent, depth } = stack.pop()!;
    const isRoot = parent === null;
    const collapsible =
      !current.id &&
      !current.text &&
      !current.clickable &&
      !current.longClickable &&
      !current.scrollable &&
      !current.checkable;
    const emitted = isRoot || !collapsible;
    let childTarget = parent;
    if (emitted) {
      const copy: ArkUiNode = { ...current, children: [] };
      if (isRoot) {
        roots.push(copy);
      } else {
        parent!.children.push(copy);
      }
      childTarget = copy;
      if (maxDepth > 0 && depth + 1 >= maxDepth) {
        continue;
      }
    }
    if (process.env.DEVECO_CLI_DEBUG) {
      const label = current.type
        ? current.id
          ? `${current.type}#${current.id}`
          : current.type
        : '#';
      const reason = isRoot ? 'root' : collapsible ? 'collapsed' : 'emitted';
      debugLog(`collapse ${label} depth=${depth} -> ${reason}`);
    }
    const childDepth = emitted ? depth + 1 : depth;
    for (let i = current.children.length - 1; i >= 0; i--) {
      stack.push({
        current: current.children[i],
        parent: childTarget,
        depth: childDepth,
      });
    }
  }
  return roots;
}
