/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { EventJournal } from './event-journal.js';
import { readDebugSession } from './debug-state.js';
import { inspectorDescription } from './inspector-catalog.js';
import { ChannelSchema } from '../debug-protocol/domain-schemas.js';
import { InputInvalidError, type ExecutionContext } from '../runtime/types.js';
import { negotiateReadonly } from '../debug-protocol/handshake.js';
import { hashContract } from '../debug-protocol/canonical-hash.js';

export const InspectorQuerySchema = z.strictObject({
  id: z.string().uuid(), stream: z.string().uuid(), channel: ChannelSchema,
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(256).default(100),
  through: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type InspectorQuery = z.infer<typeof InspectorQuerySchema>;
export function isInspectorTool(id: string): boolean {
  return id === 'debug.inspect' || id === 'debug.inspectors';
}

export async function readInspector(input: InspectorQuery, context: ExecutionContext) {
  const query = InspectorQuerySchema.parse(input);
  const session = await readDebugSession(context.dataDir, query.id);
  if (session.cwd !== context.cwd || session.projectRoot !== context.projectRoot) {
    throw new InputInvalidError('DEBUG_SCOPE_CHANGED');
  }
  const { events, manifest, retention } = await EventJournal.read(context.dataDir, query.id, query.stream);
  const tail = retention?.through ?? events.length, through = query.through ?? tail;
  if (through > tail || query.after > through) { throw new InputInvalidError('INSPECTOR_CURSOR_INVALID'); }
  if (retention && through < retention.from - 1) { throw new InputInvalidError('INSPECTOR_CURSOR_EVICTED'); }
  const channels = manifest.schemaVersion !== '1.1' ? negotiateReadonly(manifest.handshake, manifest.peer).channels :
    manifest.handshake.channels.filter((offer) => offer.available && offer.read);
  const offered = channels.some((offer) => offer.channel === query.channel);
  const matching = events.filter((record) => record.index <= through && record.event.channel === query.channel);
  const remaining = matching.filter((record) => record.index > query.after);
  const selected = remaining.slice(0, query.limit), hasMore = selected.length < remaining.length;
  return { schemaVersion: '1.0', inspector: inspectorDescription(query.channel),
    availability: matching.length ? 'recorded' : offered ? 'not-captured' : 'not-negotiated',
    source: 'peer-reported', identity: manifest.handshake.identity,
    buildVerification: manifest.buildVerification, deviceProvenance: manifest.deviceProvenance,
    authentication: 'not-restored',
    clockCalibration: matching.some((record) => record.clock.alignment?.observation.sample) ? 'per-record' : 'not-calibrated', samplingRate: null,
    events: selected, count: matching.length, through,
    snapshotHash: retention ? hashContract({ retainedFrom: retention.from, through,
      hashes: events.filter((record) => record.index <= through).map((record) => record.hash) }) : through ? events[through - 1].hash : null,
    ...(retention ? { retainedFrom: retention.from,
      gap: query.after < retention.from - 1 ? { missingFrom: query.after + 1,
        missingThrough: retention.from - 1, reason: 'retention-quota' } : null } : {}),
    records: selected.map(({ index, clock }) => ({ index, coverageLevel: 'summary-only', source: 'peer-reported',
      observation: 'registered', clockCalibration: clock.alignment?.status ?? 'not-calibrated' })),
    nextCursor: hasMore ? selected.at(-1)!.index : through, hasMore };
}
