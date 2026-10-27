/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExecutionContext } from '../runtime/types.js';
import { ResourceBusyError } from '../runtime/execution-lock.js';
import { readDebugSession } from '../debug/debug-state.js';
import type { BridgeHub } from '../debug/bridge-hub.js';
import type { BridgeUpdateSubscription } from '../debug/bridge-updates.js';
import { DebugEventsQuerySchema, readDebugEvents, type DebugEventsQuery,
  DebugStreamsQuerySchema, readDebugStreams } from '../debug/event-query.js';
import { HttpError, json } from './http-security.js';

export function queryError(error: unknown): HttpError {
  if (error instanceof HttpError) { return error; }
  if (error instanceof Error && error.message === 'DEBUG_SCOPE_CHANGED') { return new HttpError(403, 'DEBUG_SCOPE_CHANGED'); }
  if (error instanceof z.ZodError || (error instanceof Error &&
    ['EVENT_CURSOR_AHEAD', 'STREAM_CURSOR_INVALID', 'INSPECTOR_CURSOR_INVALID'].includes(error.message))) {
    return new HttpError(400, 'EVENT_QUERY_INVALID');
  }
  if (error instanceof ResourceBusyError) { return new HttpError(503, 'JOURNAL_BUSY'); }
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { return new HttpError(404, 'DEBUG_EVIDENCE_NOT_FOUND'); }
  return new HttpError(409, 'JOURNAL_CORRUPT');
}
async function scopedSession(context: ExecutionContext, id: string) {
  const session = await readDebugSession(context.dataDir, id);
  if (session.cwd !== context.cwd || session.projectRoot !== context.projectRoot) { throw new HttpError(403, 'DEBUG_SCOPE_CHANGED'); }
  return session;
}
async function write(response: ServerResponse, value: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) { return; }
  if (response.write(value)) { return; }
  await new Promise<void>((resolve) => {
    const done = () => { response.off('drain', done); signal.removeEventListener('abort', done); resolve(); };
    response.once('drain', done); signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) { done(); }
  });
}
function retentionFrame(page: Awaited<ReturnType<typeof readDebugEvents>>, previous: string) {
  if (!('retainedFrom' in page)) { return { value: '', range: previous }; }
  const range = JSON.stringify({ retainedFrom: page.retainedFrom, retainedCount: page.retainedCount, through: page.through });
  if (page.gap) {
    return { range, value: `id: ${page.gap.missingThrough}\nevent: gap\ndata: ${JSON.stringify({
      ...page.gap, retainedFrom: page.retainedFrom, retainedCount: page.retainedCount, through: page.through,
    })}\n\n` };
  }
  return { range, value: range === previous ? '' : `event: retention\ndata: ${range}\n\n` };
}
async function stream(context: ExecutionContext, query: DebugEventsQuery, response: ServerResponse, serviceSignal: AbortSignal,
  subscription?: BridgeUpdateSubscription) {
  let page = await readDebugEvents(context.dataDir, query), cursor = query.after, heartbeat = Date.now();
  let retention = '';
  if (serviceSignal.aborted || response.destroyed) { response.end(); return; }
  const disconnected = new AbortController(), signal = AbortSignal.any([serviceSignal, disconnected.signal]);
  const close = () => disconnected.abort(), stop = () => response.destroy();
  response.on('close', close); serviceSignal.addEventListener('abort', stop, { once: true });
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  response.flushHeaders();
  try {
    while (!signal.aborted) {
      const frame = retentionFrame(page, retention);
      if (frame.value) {
        await write(response, frame.value, signal);
        if (signal.aborted) { break; }
        retention = frame.range;
        if (page.gap) { cursor = page.gap.missingThrough; }
      }
      if (page.events.length) {
        await write(response, page.events.map((record) => `id: ${record.index}\ndata: ${JSON.stringify(record)}\n\n`).join(''), signal);
        if (signal.aborted) { break; }
        cursor = page.nextCursor;
      }
      const session = await scopedSession(context, query.id);
      const active = session.state === 'serving' && 'streamId' in session.bridge && session.bridge.streamId === query.stream &&
        session.bridge.state === 'connected';
      if (!page.hasMore && !active) {
        await write(response, `event: end\ndata: ${JSON.stringify({ state: session.state, through: page.through })}\n\n`, signal); break;
      }
      if (Date.now() - heartbeat >= 15_000) { await write(response, ': heartbeat\n\n', signal); heartbeat = Date.now(); }
      if (!page.hasMore) {
        if (subscription) { await subscription.wait(signal); }
        else { await setTimeout(1000, undefined, { signal }); }
      }
      if (signal.aborted) { break; }
      page = await readDebugEvents(context.dataDir, { ...query, after: cursor });
    }
  } catch (error) {
    if (!signal.aborted) { await write(response, `event: fault\ndata: ${JSON.stringify({ code: queryError(error).message })}\n\n`, signal); }
  } finally { response.off('close', close); serviceSignal.removeEventListener('abort', stop); response.end(); }
}
export async function handleDebugEvents(context: ExecutionContext, request: IncomingMessage, response: ServerResponse,
  url: URL, signal: AbortSignal, bridge?: Pick<BridgeHub, 'watch'>): Promise<boolean> {
  const path = /^\/api\/v1\/debug\/sessions\/([^/]+)\/streams\/([^/]+)\/(events|live)$/.exec(url.pathname);
  const listing = /^\/api\/v1\/debug\/sessions\/([^/]+)\/streams$/.exec(url.pathname);
  if (!path && !listing) { return false; }
  if (request.method !== 'GET') { throw new HttpError(405, 'METHOD_INVALID'); }
  try {
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((key) => !['after', 'limit'].includes(key))) {
      throw new HttpError(400, 'EVENT_QUERY_INVALID');
    }
    if (listing) {
      const query = DebugStreamsQuerySchema.parse({ id: listing[1], ...Object.fromEntries(url.searchParams) });
      await scopedSession(context, query.id);
      json(response, await readDebugStreams(context.dataDir, query)); return true;
    }
    const query = DebugEventsQuerySchema.parse({ id: path![1], stream: path![2], ...Object.fromEntries(url.searchParams),
      ...(request.headers['last-event-id'] && path![3] === 'live' ? { after: request.headers['last-event-id'] } : {}) });
    await scopedSession(context, query.id);
    if (path![3] === 'live') {
      const subscription = bridge?.watch(query.id, query.stream);
      try { await stream(context, query, response, signal, subscription); }
      finally { subscription?.close(); }
    }
    else { json(response, await readDebugEvents(context.dataDir, query)); }
    return true;
  } catch (error) { throw queryError(error); }
}
