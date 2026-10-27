/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { createExecutionContext } from '../runtime/context.js';
import { toolContext } from '../runtime/tool-context.js';
import { registeredProjects } from '../project-model/project-specs.js';
import { TaskManager } from '../tasks/task-manager.js';
import { HttpError, body, json } from './http-security.js';
import { streamTaskEvents } from './task-events.js';
import { handleDebugEvents } from './debug-events.js';
import { handleDebugInspector } from './debug-inspector.js';
import { listWorkspaceTree, workspaceTreeSchema } from './workspace-tree.js';
import { isProblemPackageTool } from '../problem-package/index.js';
import { isInspectorTool } from '../debug/index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OHMateRuntime, ExecutionContext } from '../runtime/index.js';
import type { BridgeHub } from '../debug/bridge-hub.js';
import { InputInvalidError } from '../runtime/types.js';

const fastTools = /^(?:model\.(?:list|add|select|remove)|context\.(?:inspect|preview)|session\.(?:list|show|resume|export)|rules\.(?:list|check)|memory\.(?:list|add|remove)|extensions\.(?:list|disable)|project\.(?:list|register))$/;
const requestSchema = z.strictObject({
  toolId: z.string(), input: z.unknown().default({}), projectRoot: z.string().nullable().optional(), wait: z.boolean().default(false),
});

async function scopedContext(base: ExecutionContext, root?: string | null): Promise<ExecutionContext> {
  if (!root) { return createExecutionContext({ cwd: base.cwd, dataDir: base.dataDir, locale: base.locale, abortSignal: base.abortSignal }); }
  if (root !== base.projectRoot && !(await registeredProjects(base)).some((project) => project.root === root)) {
    throw new HttpError(400, 'PROJECT_NOT_REGISTERED');
  }
  return createExecutionContext({ cwd: root, projectRoot: root, dataDir: base.dataDir, locale: base.locale, abortSignal: base.abortSignal });
}

async function taskEventHistory(runtime: OHMateRuntime, context: ExecutionContext, id: string, url: URL) {
  const after = Number(url.searchParams.get('after') ?? 0), rawLimit = Number(url.searchParams.get('limit') ?? 800);
  if (!Number.isSafeInteger(after) || after < 0) { throw new HttpError(400, 'EVENT_CURSOR_INVALID'); }
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 800;
  const all = await new TaskManager(runtime, context).store.events(id, after);
  const events = all.slice(-limit);
  return { events, nextCursor: all.at(-1)?.sequence ?? after, truncated: all.length > limit };
}

async function invoke(runtime: OHMateRuntime, base: ExecutionContext, input: unknown, direct: boolean) {
  const request = requestSchema.parse(input);
  const spec = runtime.registry.get(request.toolId);
  if (!spec || spec.hidden || spec.protocol ||
    (/^(?:task|ui|debug|devtools)\./.test(spec.id) && !isProblemPackageTool(spec.id) && !isInspectorTool(spec.id)) || spec.id === 'agent.chat') {
    throw new HttpError(400, 'TOOL_REQUIRES_TERMINAL_OR_CONTROL_ROUTE');
  }
  const context = await scopedContext(base, request.projectRoot);
  const parsed = spec.inputSchema.parse(request.input), target = await toolContext(spec, parsed, context);
  if (target.projectRoot !== context.projectRoot) { throw new HttpError(400, 'TOOL_PROJECT_SCOPE_CHANGED'); }
  if (direct) {
    if (!fastTools.test(spec.id)) { throw new HttpError(400, 'USE_PERSISTENT_TASK'); }
    return runtime.execute(spec.id, parsed, context);
  }
  return runtime.execute('task.submit', { toolId: spec.id, input: parsed, wait: request.wait }, context);
}

export async function handleApi(runtime: OHMateRuntime, context: ExecutionContext, request: IncomingMessage,
  response: ServerResponse, url: URL, csrf: string, serviceSignal: AbortSignal, bridge?: Pick<BridgeHub, 'watch'>): Promise<void> {
  const path = url.pathname.slice('/api/v1/'.length), read = request.method === 'GET';
  if (await handleDebugInspector(context, request, response, url)) { return; }
  if (await handleDebugEvents(context, request, response, url, serviceSignal, bridge)) { return; }
  if (read && path === 'bootstrap') {
    json(response, { csrf, cwd: context.cwd, projectRoot: context.projectRoot, version: '0.1.0',
      device: { status: 'not-probed' }, model: { default: 'disabled' } }); return;
  }
  if (read && path === 'capabilities') { json(response, await runtime.execute('capabilities', {}, context)); return; }
  if (read && path === 'debug/status') { json(response, await runtime.execute('debug.status', {}, context)); return; }
  if (read && path === 'debug/protocol') { json(response, await runtime.execute('debug.protocol', {}, context)); return; }
  if (read && path === 'debug/sessions') { json(response, await runtime.execute('debug.list', {}, context)); return; }
  const debug = /^debug\/sessions\/([a-f0-9-]+)$/.exec(path);
  if (read && debug) { json(response, await runtime.execute('debug.show', { id: debug[1] }, context)); return; }
  if (read && path === 'tasks') { json(response, await runtime.execute('task.list', {}, context)); return; }
  if (request.method === 'POST' && path === 'workspace/tree') {
    const input = workspaceTreeSchema.parse(await body(request));
    const scoped = await scopedContext(context, input.projectRoot);
    try { json(response, await listWorkspaceTree(scoped, input.path, input.limit)); }
    catch (error) {
      if (error instanceof InputInvalidError) { throw new HttpError(400, 'WORKSPACE_PATH_INVALID'); }
      throw error;
    }
    return;
  }
  if (request.method === 'POST' && (path === 'tasks' || path === 'execute')) {
    json(response, await invoke(runtime, context, await body(request), path === 'execute')); return;
  }
  const match = /^tasks\/([a-f0-9-]+)(?:\/(events|approve|cancel|resume))?$/.exec(path);
  if (!match) { throw new HttpError(404, 'API_NOT_FOUND'); }
  const id = z.string().uuid().parse(match[1]), action = match[2];
  if (read && action === 'events' && url.searchParams.get('format') === 'json') {
    json(response, await taskEventHistory(runtime, context, id, url)); return;
  }
  if (read && action === 'events') {
    const after = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
    await streamTaskEvents(new TaskManager(runtime, context).store, id, after, request, response, serviceSignal); return;
  }
  if (read && !action) { json(response, await runtime.execute('task.show', { id }, context)); return; }
  if (request.method !== 'POST' || !['approve', 'cancel', 'resume'].includes(action)) { throw new HttpError(405, 'METHOD_INVALID'); }
  const input = await body(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'id' in input) { throw new HttpError(400, 'TASK_REQUEST_INVALID'); }
  const receipt = await runtime.execute(`task.${action}`, { ...input, id }, context);
  json(response, receipt, receipt.exitCode === 4 ? 400 : receipt.exitCode === 2 ? 404 : 200);
}
