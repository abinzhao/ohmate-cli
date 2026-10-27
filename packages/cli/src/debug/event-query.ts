/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { EventJournal } from './event-journal.js';
import { readDebugSession } from './debug-state.js';
import { InputInvalidError } from '../runtime/types.js';
import { ResourceBusyError } from '../runtime/execution-lock.js';
import { readdir } from 'node:fs/promises';
import { journalSessionDirectory } from './journal-files.js';
import { securityError } from '../debug-protocol/security-schemas.js';

export const DebugEventsQuerySchema = z.strictObject({
  id: z.string().uuid(), stream: z.string().uuid(),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(256).default(100),
});
export type DebugEventsQuery = z.infer<typeof DebugEventsQuerySchema>;
export const DebugStreamsQuerySchema = z.strictObject({
  id: z.string().uuid(), after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(64).default(20),
});
export type DebugStreamsQuery = z.infer<typeof DebugStreamsQuerySchema>;
async function streamNames(dataDir: string, id: string): Promise<string[]> {
  let directory: string;
  try { directory = await journalSessionDirectory(dataDir, id, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
  const names = (await readdir(directory)).sort();
  if (names.length > 1000 || names.some((name) => !z.string().uuid().safeParse(name).success)) {
    throw securityError('JOURNAL_INDEX_INVALID');
  }
  return names;
}
async function streamSummary(dataDir: string, id: string, streamId: string, active: boolean) {
  try {
    const { manifest, events, retention } = await EventJournal.read(dataDir, id, streamId);
    return { streamId, active, integrity: 'verified' as const, manifest, through: retention?.through ?? events.length,
      ...(retention ? { retainedFrom: retention.from, retainedCount: events.length, retentionGap: retention.gap } : {}),
      firstClock: events[0]?.clock ?? null, lastClock: events.at(-1)?.clock ?? null };
  } catch (error) {
    if (error instanceof ResourceBusyError) { throw error; }
    return { streamId, active: false, integrity: 'corrupt' as const, code: 'JOURNAL_CORRUPT' };
  }
}
export async function readDebugStreams(dataDir: string, input: DebugStreamsQuery) {
  const query = DebugStreamsQuerySchema.parse(input), session = await readDebugSession(dataDir, query.id);
  const names = await streamNames(dataDir, query.id);
  if (query.after && !names.includes(query.after)) { throw new InputInvalidError('STREAM_CURSOR_INVALID'); }
  const from = query.after ? names.indexOf(query.after) + 1 : 0;
  const selected = names.slice(from, from + query.limit), streams = [];
  for (const streamId of selected) {
    const active = session.state === 'serving' && 'streamId' in session.bridge &&
      session.bridge.streamId === streamId && session.bridge.state === 'connected';
    streams.push(await streamSummary(dataDir, query.id, streamId, active));
  }
  return { streams, nextCursor: selected.at(-1) ?? query.after ?? null, hasMore: from + selected.length < names.length };
}
export async function readDebugEvents(dataDir: string, input: DebugEventsQuery) {
  const query = DebugEventsQuerySchema.parse(input);
  await readDebugSession(dataDir, query.id);
  const journal = await EventJournal.read(dataDir, query.id, query.stream, { page: query });
  const through = journal.through;
  if (query.after > through) { throw new InputInvalidError('EVENT_CURSOR_AHEAD'); }
  const events = journal.events;
  const nextCursor = events.at(-1)?.index ?? Math.max(query.after, (journal.retention?.from ?? 1) - 1);
  return { manifest: journal.manifest, events, nextCursor, through, hasMore: nextCursor < through,
    ...(journal.retention ? { retainedFrom: journal.retention.from, retainedCount: journal.count,
      gap: query.after < journal.retention.from - 1 ? {
        missingFrom: query.after + 1, missingThrough: journal.retention.from - 1, reason: 'retention-quota',
      } : null } : {}) };
}
