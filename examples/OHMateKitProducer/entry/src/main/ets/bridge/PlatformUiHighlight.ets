/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { UIContext, FrameNode } from '@kit.ArkUI';
import { CryptoPort, canonical, requireWire } from './Wire';
import { readUiBounds } from './PlatformUi';

export function readUiHighlightSource(context: UIContext, crypto: CryptoPort): string {
  // 文档依据：自定义能力 text/05-frame-node.md；API26 UIContext/FrameNode.d.ts。
  // Geometry validates presence only. Page movement is not an identity change.
  const root = context.getFrameNodeById('bridge_capture_root');
  const target = context.getFrameNodeById('bridge_snapshot_target');
  requireWire(root !== null && root !== undefined && target !== null && target !== undefined,
    'UI_HIGHLIGHT_SOURCE_INVALID');
  if (root === null || root === undefined || target === null || target === undefined) {
    throw new Error('UI_HIGHLIGHT_SOURCE_INVALID');
  }
  const rootId = root.getUniqueId();
  const rootBounds = readUiBounds(context, root);
  requireWire(Number.isSafeInteger(rootId) && rootId > 0 && root.isVisible() === true &&
    rootBounds.width > 0 && rootBounds.height > 0, 'UI_HIGHLIGHT_SOURCE_INVALID');
  const ids: number[] = [];
  let node: FrameNode | null = target;
  for (let depth = 0; depth <= 32 && node !== null; depth++) {
    const id = node.getUniqueId();
    const bounds = readUiBounds(context, node);
    requireWire(Number.isSafeInteger(id) && id > 0 && !ids.includes(id) &&
      node.isVisible() === true && bounds.width > 0 && bounds.height > 0, 'UI_HIGHLIGHT_SOURCE_INVALID');
    ids.push(id);
    if (id === rootId) {
      // Native FrameNode proxies need not preserve JavaScript object identity.
      return crypto.hash(canonical(ids));
    }
    node = node.getParent();
  }
  throw new Error('UI_HIGHLIGHT_SOURCE_INVALID');
}
