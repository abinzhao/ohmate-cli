/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExecutionContext } from '../runtime/types.js';
import { inspectorCatalog } from '../debug/inspector-catalog.js';
import { InspectorQuerySchema, readInspector } from '../debug/inspector.js';
import { queryError } from './debug-events.js';
import { HttpError, json } from './http-security.js';

export async function handleDebugInspector(context: ExecutionContext, request: IncomingMessage,
  response: ServerResponse, url: URL): Promise<boolean> {
  const path = /^\/api\/v1\/debug\/sessions\/([^/]+)\/streams\/([^/]+)\/inspect\/([^/]+)$/.exec(url.pathname);
  const catalog = url.pathname === '/api/v1/debug/inspectors';
  if (!path && !catalog) { return false; }
  if (request.method !== 'GET') { throw new HttpError(405, 'METHOD_INVALID'); }
  try {
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((key) => catalog || !['after', 'limit', 'through'].includes(key))) {
      throw new HttpError(400, 'EVENT_QUERY_INVALID');
    }
    if (catalog) { json(response, inspectorCatalog()); return true; }
    const query = InspectorQuerySchema.parse({ id: path![1], stream: path![2], channel: path![3],
      ...Object.fromEntries(url.searchParams) });
    json(response, await readInspector(query, context)); return true;
  } catch (error) { throw queryError(error); }
}
