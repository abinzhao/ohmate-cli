/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreClock, CoreEnvelope, CoreEvent, CoreHost, CoreLoss, CoreOptions, CoreSegment } from '../api/CoreTypes';
import { coreIdentifier, SchemaRegistry } from '../core/SchemaRegistry';

export class RecoverySummary {
  status: string = 'none';
  bytes: number = 0;
}
export function exactKeys(value: Object, required: string[]): boolean {
  const keys: string[] = Object.keys(value);
  return keys.length === required.length && keys.every((key: string): boolean => required.includes(key));
}
function clockValid(clock: CoreClock): boolean {
  return exactKeys(clock, ['clockId', 'bootId', 'monotonicNs', 'wallTimeUtc']) &&
    coreIdentifier(clock.clockId) && coreIdentifier(clock.bootId) &&
    Number.isSafeInteger(clock.monotonicNs) && clock.monotonicNs >= 0 &&
    typeof clock.wallTimeUtc === 'string' &&
    new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$').test(clock.wallTimeUtc);
}
export function lossValid(loss: CoreLoss): boolean {
  return exactKeys(loss, ['dropped', 'criticalDropped', 'firstSequence', 'lastSequence', 'rangeKind']) &&
    loss.rangeKind === 'envelope' &&
    [loss.dropped, loss.criticalDropped, loss.firstSequence, loss.lastSequence].every((value: number): boolean =>
      Number.isSafeInteger(value) && value >= 0) &&
    loss.criticalDropped <= loss.dropped && loss.firstSequence <= loss.lastSequence;
}
export function eventValid(event: CoreEvent, segment: CoreSegment, schemas: SchemaRegistry): boolean {
  if (!exactKeys(event, ['sequence', 'source', 'name', 'priority', 'sessionId', 'clock', 'fields']) ||
    event.sessionId !== segment.sessionId || !coreIdentifier(event.name) ||
    !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !clockValid(event.clock) ||
    !['critical', 'high', 'normal', 'verbose'].includes(event.priority)) { return false; }
  if (event.source === 'recorder') {
    return ['active', 'heartbeat', 'pause', 'resume', 'close'].includes(event.name) &&
      event.priority === 'high' && Object.keys(event.fields).length === 0;
  }
  if (event.source !== 'application') { return false; }
  if (event.priority === 'critical') {
    return ['crash', 'freeze', 'oom', 'render-exit', 'unhandled-error'].includes(event.name) &&
      Object.keys(event.fields).length === 0;
  }
  const projection = schemas.project(event.name, event.fields);
  return projection !== undefined && projection.valid && projection.rejected === 0;
}
export function recoverSegments(history: string[], host: CoreHost, options: CoreOptions, schemas: SchemaRegistry): RecoverySummary {
  const result = new RecoverySummary();
  try {
    if (!Array.isArray(history) || history.length > 256) { throw new Error('RECOVERY_BOUND'); }
    const sessions: Map<string, CoreEvent> = new Map<string, CoreEvent>();
    for (const text of history) {
      result.bytes += host.byteLength(text);
      if (result.bytes > options.maxStorageBytes) { throw new Error('RECOVERY_BOUND'); }
      const envelope: CoreEnvelope = JSON.parse(text) as CoreEnvelope;
      if (!exactKeys(envelope, ['schemaVersion', 'bytes', 'sha256', 'payload']) || envelope.schemaVersion !== '1.0' ||
        typeof envelope.payload !== 'string' || envelope.bytes !== host.byteLength(envelope.payload) ||
        envelope.sha256 !== host.hash(envelope.payload)) { throw new Error('RECOVERY_CHECKSUM'); }
      const segment: CoreSegment = JSON.parse(envelope.payload) as CoreSegment;
      if (!exactKeys(segment, ['schemaVersion', 'sessionId', 'buildId', 'buildVerification', 'firstSequence',
        'lastSequence', 'events', 'loss']) || segment.schemaVersion !== '1.0' || !coreIdentifier(segment.sessionId) ||
        typeof segment.buildId !== 'string' || segment.buildId.length > 128 ||
        !new RegExp('^[A-Za-z0-9_.@-]*$').test(segment.buildId) || !lossValid(segment.loss) ||
        segment.buildVerification !== 'unverified-build' || !Array.isArray(segment.events) ||
        segment.events.length === 0 || segment.events.length > 1024 ||
        segment.firstSequence !== segment.events[0].sequence ||
        segment.lastSequence !== segment.events[segment.events.length - 1].sequence) { throw new Error('RECOVERY_SCHEMA'); }
      for (const event of segment.events) {
        const last: CoreEvent | undefined = sessions.get(segment.sessionId);
        if (!eventValid(event, segment, schemas) || (last !== undefined &&
          ((last.source === 'recorder' && last.name === 'close') ||
            event.sequence <= last.sequence || event.clock.clockId !== last.clock.clockId ||
            event.clock.bootId !== last.clock.bootId || event.clock.monotonicNs < last.clock.monotonicNs))) {
          throw new Error('RECOVERY_SCHEMA');
        }
        sessions.set(segment.sessionId, event);
      }
    }
    if (sessions.size > 0) {
      result.status = 'closed';
      sessions.forEach((last: CoreEvent): void => {
        if (last.source !== 'recorder' || last.name !== 'close') { result.status = 'uncertain-exit'; }
      });
    }
  } catch (_) { result.status = 'corrupt'; }
  result.bytes = Math.min(result.bytes, options.maxStorageBytes); return result;
}
