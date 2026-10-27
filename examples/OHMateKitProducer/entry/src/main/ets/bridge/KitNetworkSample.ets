/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { NetworkEvent } from './ReadonlyCollector';
import { NETWORK_SOURCE_API } from './PlatformNetwork';
import { KIT_NETWORK_PATH } from './GeneratedContract';

interface NetworkSource { id: string; kind: string; api: string; provenance: string; }
export interface KitNetworkFile {
  path: string;
  source: NetworkSource;
  status: string;
  sampled: boolean;
  dropped: number;
  records: Record<string, Object>[];
}
export function makeNetworkFile(event: NetworkEvent, dropped: number): KitNetworkFile {
  const record: Record<string, Object> = {
    'project': event.project, 'buildId': event.buildId, 'device': event.device, 'process': event.process,
    'sessionId': event.sessionId, 'protocolVersion': event.protocolVersion, 'channelVersion': event.channelVersion,
    'messageId': event.messageId, 'sessionEpoch': event.sessionEpoch, 'sequence': event.sequence,
    'channel': event.channel, 'type': event.type, 'capability': event.capability, 'clockId': event.clockId,
    'bootId': event.bootId, 'wallTimeUtc': event.wallTimeUtc, 'monotonicNs': event.monotonicNs,
    'offsetUncertaintyMs': event.offsetUncertaintyMs, 'payload': event.payload, 'redaction': event.redaction
  };
  const source: NetworkSource = {
    id: 'registered-http', kind: 'registered-adapter', api: NETWORK_SOURCE_API, provenance: 'peer-reported'
  };
  return { path: KIT_NETWORK_PATH, source: source, status: 'summary-only', sampled: true, dropped: dropped, records: [record] };
}
