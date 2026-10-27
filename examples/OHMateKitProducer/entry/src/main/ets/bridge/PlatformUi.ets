/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { UIContext, FrameNode, ChildrenCountMode, ExpandMode } from '@kit.ArkUI';
import { requireWire } from './Wire';

export interface UiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: string;
  origin: string;
}
export interface UiNodeMetadata {
  nodeId: string;
  parentId: string | null;
  role: string;
  childCount: number;
  bounds: UiBounds;
  visible: boolean;
}
interface PendingNode { node: FrameNode; parentId: string | null; depth: number; }

export function readUiBounds(context: UIContext, node: FrameNode): UiBounds {
  // 文档依据：自定义能力 text/05-frame-node.md L1244-L1355；API26 FrameNode.d.ts。
  requireWire(!node.isDisposed() && node.isAttached(), 'UI_NODE_UNAVAILABLE');
  const position = node.getPositionToWindow();
  const size = node.getMeasuredSize();
  requireWire(Number.isFinite(size.width) && Number.isFinite(size.height) &&
    size.width >= 0 && size.height >= 0, 'UI_GEOMETRY_INVALID');
  const bounds: UiBounds = {
    x: position.x, y: position.y, width: context.px2vp(size.width), height: context.px2vp(size.height),
    unit: 'vp', origin: 'window'
  };
  requireWire(Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) && Number.isFinite(bounds.height) &&
    bounds.width >= 0 && bounds.height >= 0, 'UI_GEOMETRY_INVALID');
  return bounds;
}

export function readUiTree(context: UIContext, rootId: string): UiNodeMetadata[] {
  // 文档依据：自定义能力 text/05-frame-node.md；API26 FrameNode.d.ts 查询接口。
  const root = context.getFrameNodeById(rootId);
  requireWire(root !== null && root !== undefined, 'UI_ROOT_UNAVAILABLE');
  if (root === null || root === undefined) { throw new Error('UI_ROOT_UNAVAILABLE'); }
  const pending: PendingNode[] = [{ node: root, parentId: null, depth: 0 }];
  const result: UiNodeMetadata[] = [];
  const seen: number[] = [];
  const roles: string[] = ['Column', 'Row', 'Stack', 'Flex', 'Text', 'Span', 'Button', 'TextInput',
    'TextArea', 'Scroll', 'List', 'ListItem', 'Grid', 'GridItem', 'Image', 'Navigation', 'NavDestination',
    'Toggle', 'Checkbox', 'Radio', 'Select', 'Slider', 'Progress', 'Web', 'Divider', 'Blank'];
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    // Scrolling containers may keep detached descendants in the expanded tree.
    // The root stays strict; unusable descendants are skipped rather than
    // aborting the whole capture.
    if (index > 0 && (item.node.isDisposed() || !item.node.isAttached())) { continue; }
    const bounds = readUiBounds(context, item.node);
    const id = item.node.getUniqueId();
    requireWire(Number.isSafeInteger(id) && id > 0 && !seen.includes(id) && item.depth <= 32, 'UI_TREE_INVALID');
    seen.push(id);
    // Never expand LazyForEach or inspect arbitrary properties/text.
    const count = item.node.getChildrenCount(ChildrenCountMode.ONLY_EXPANDED);
    requireWire(Number.isSafeInteger(count) && count >= 0 && pending.length + count <= 256, 'UI_TREE_LIMIT');
    const role = item.node.getNodeType();
    const visible = item.node.isVisible();
    requireWire(typeof visible === 'boolean', 'UI_VISIBILITY_INVALID');
    const nodeId = 'node-' + id;
    const metadata: UiNodeMetadata = {
      nodeId: nodeId, parentId: item.parentId, role: roles.includes(role) ? role : 'Component', childCount: count,
      bounds: bounds, visible: visible
    };
    result.push(metadata);
    for (let childIndex = 0; childIndex < count; childIndex++) {
      const child = item.node.getChild(childIndex, ExpandMode.NOT_EXPAND);
      requireWire(child !== null && child !== undefined, 'UI_TREE_CHANGED');
      if (child === null || child === undefined) { throw new Error('UI_TREE_CHANGED'); }
      const next: PendingNode = { node: child, parentId: nodeId, depth: item.depth + 1 };
      pending.push(next);
    }
  }
  return result;
}
