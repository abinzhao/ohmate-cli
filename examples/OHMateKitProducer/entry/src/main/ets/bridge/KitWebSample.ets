/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { WebEvent } from './ReadonlyCollector';
import { WebNodeMetadata, WEB_DOM_API } from './PlatformWeb';
import { KIT_WEB_DOM_DIRECTORY, KIT_WEB_CONSOLE_PATH, KIT_NETWORK_PATH, KIT_WEB_STORAGE_PATH } from './GeneratedContract';

interface WebSource { id: string; kind: string; api: string; provenance: string; }
interface WebStructuralPayload extends WebNodeMetadata { targetId: string; }
export interface KitWebFile {
  path: string;
  source: WebSource;
  status: string;
  sampled: boolean;
  dropped: number;
  records: Record<string, Object>[];
}
export function makeWebFile(event: WebEvent, nodes: WebNodeMetadata[], dropped: number): KitWebFile {
  const dom = event.channel === 'arkweb.dom';
  const storage = event.channel === 'arkweb.storage';
  const source: WebSource = {
    id: dom ? 'registered-web-dom' : storage ? 'registered-web-cookie' :
      event.channel === 'arkweb.console' ? 'registered-web-console' : 'registered-web-navigation',
    kind: dom || storage ? 'platform-api' : 'registered-adapter',
    api: dom ? WEB_DOM_API : storage ? 'WebCookieManager.fetchCookie' :
      event.channel === 'arkweb.console' ? 'Web.onConsole' : 'Web.onPageBegin.onPageEnd',
    provenance: 'peer-reported'
  };
  const records: Record<string, Object>[] = [];
  if (dom) {
    const clock: Record<string, Object> = {
      'clockId': event.clockId, 'bootId': event.bootId, 'wallTimeUtc': event.wallTimeUtc,
      'monotonicNs': event.monotonicNs, 'offsetUncertaintyMs': event.offsetUncertaintyMs
    };
    for (const node of nodes) {
      const payload: WebStructuralPayload = {
        targetId: event.payload['targetId'] as string, nodeId: node.nodeId, parentId: node.parentId,
        role: node.role, childCount: node.childCount
      };
      records.push({ 'clock': clock, 'payload': payload });
    }
  } else {
    const record = JSON.parse(JSON.stringify(event)) as Record<string, Object>;
    const safe: Record<string, Object> = {};
    for (const key of Object.keys(record)) { if (key !== 'fingerprint') { safe[key] = record[key]; } }
    records.push(safe);
  }
  return {
    path: dom ? KIT_WEB_DOM_DIRECTORY + '/' + event.payload['targetId'] + '.json' :
      storage ? KIT_WEB_STORAGE_PATH : event.channel === 'arkweb.console' ? KIT_WEB_CONSOLE_PATH : KIT_NETWORK_PATH,
    source: source, status: dom ? 'captured' : 'summary-only', sampled: true, dropped: dropped, records: records
  };
}
