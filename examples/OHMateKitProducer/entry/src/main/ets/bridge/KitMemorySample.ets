/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { MetricEvent } from './ReadonlyCollector';
import { KIT_MEMORY_PATH } from './GeneratedContract';

interface KitPlatformSource {
  id: string;
  kind: string;
  api: string;
  provenance: string;
}
export interface KitMemoryFile {
  path: string;
  source: KitPlatformSource;
  status: string;
  dropped: number;
  sampled: boolean;
  records: Record<string, Object>[];
}
export function makeMemoryFile(event: MetricEvent, api: string, dropped: number = event.sequence - 1): KitMemoryFile {
  const record: Record<string, Object> = {
    'project': event.project, 'buildId': event.buildId, 'device': event.device, 'process': event.process,
    'sessionId': event.sessionId, 'protocolVersion': event.protocolVersion, 'channelVersion': event.channelVersion,
    'messageId': event.messageId, 'sessionEpoch': event.sessionEpoch, 'sequence': event.sequence,
    'channel': event.channel, 'type': event.type, 'capability': event.capability, 'clockId': event.clockId,
    'bootId': event.bootId, 'wallTimeUtc': event.wallTimeUtc, 'monotonicNs': event.monotonicNs,
    'offsetUncertaintyMs': event.offsetUncertaintyMs, 'payload': event.payload, 'redaction': event.redaction
  };
  const source: KitPlatformSource = {
    id: event.payload.metric === 'cpuPercent' ? 'process-cpu' : 'process-pss',
    kind: 'platform-api', api: api, provenance: 'peer-reported'
  };
  return { path: KIT_MEMORY_PATH, source: source, status: 'summary-only', dropped: dropped,
    sampled: true, records: [record] };
}
