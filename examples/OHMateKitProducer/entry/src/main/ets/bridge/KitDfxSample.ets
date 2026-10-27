/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { WebEvent } from './ReadonlyCollector';
import { KIT_DFX_PATH } from './GeneratedContract';
import { KitMemoryFile } from './KitMemorySample';

export function makeDfxFile(event: WebEvent, dropped: number): KitMemoryFile {
  const output: Record<string, Object> = {
    'project': event.project, 'buildId': event.buildId, 'device': event.device, 'process': event.process,
    'sessionId': event.sessionId, 'protocolVersion': event.protocolVersion, 'channelVersion': event.channelVersion,
    'messageId': event.messageId, 'sessionEpoch': event.sessionEpoch, 'sequence': event.sequence,
    'channel': event.channel, 'type': event.type, 'capability': event.capability, 'clockId': event.clockId,
    'bootId': event.bootId, 'wallTimeUtc': event.wallTimeUtc, 'monotonicNs': event.monotonicNs,
    'offsetUncertaintyMs': event.offsetUncertaintyMs, 'payload': event.payload, 'redaction': event.redaction
  };
  return {
    path: KIT_DFX_PATH,
    source: { id: 'system-event-names', kind: 'platform-api', api: 'hiAppEvent.addWatcher.onReceive', provenance: 'peer-reported' },
    status: 'summary-only', dropped: dropped, sampled: true, records: [output]
  };
}
