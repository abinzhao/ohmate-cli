/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { UiEvent } from './ReadonlyCollector';
import { UiNodeMetadata } from './PlatformUi';
import { KIT_UI_PATH } from './GeneratedContract';

export const UI_SOURCE_API: string =
  'UIContext.getFrameNodeById.FrameNode.getPositionToWindow.getMeasuredSize.isVisible.isAttached';
interface UiSource { id: string; kind: string; api: string; provenance: string; }
interface UiStructuralPayload extends UiNodeMetadata { windowId: string; }
export interface KitUiFile {
  path: string;
  source: UiSource;
  status: string;
  sampled: boolean;
  dropped: number;
  records: Record<string, Object>[];
}
export function makeUiFile(event: UiEvent, nodes: UiNodeMetadata[], dropped: number): KitUiFile {
  const clock: Record<string, Object> = {
    'clockId': event.clockId, 'bootId': event.bootId, 'wallTimeUtc': event.wallTimeUtc,
    'monotonicNs': event.monotonicNs, 'offsetUncertaintyMs': event.offsetUncertaintyMs
  };
  const records = nodes.map((node: UiNodeMetadata): Record<string, Object> => {
    const payload: UiStructuralPayload = {
      windowId: event.payload.windowId, nodeId: node.nodeId, parentId: node.parentId,
      role: node.role, childCount: node.childCount, bounds: node.bounds, visible: node.visible
    };
    return { 'clock': clock, 'payload': payload };
  });
  const source: UiSource = {
    id: 'arkui-tree', kind: 'platform-api', api: UI_SOURCE_API, provenance: 'peer-reported'
  };
  return { path: KIT_UI_PATH, source: source, status: 'captured', sampled: true, dropped: dropped, records: records };
}
