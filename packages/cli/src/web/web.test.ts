/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import type { OHMateRuntime, ExecutionContext } from '../runtime/index.js';
import type { TaskRecord } from '../tasks/types.js';
import { TaskManager } from '../tasks/task-manager.js';
import { serviceSpec } from '../agent/service-spec.js';
import { z } from 'zod';
import { runInNewContext } from 'node:vm';

let root: string, runtime: OHMateRuntime, context: ExecutionContext;
let server: { origin: string; ticket: () => string; close: () => Promise<void> };
let cookie: string, csrf: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-web-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  runtime = await createRuntime();
});
afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });

async function start() {
  const module = await import('./web-server.js');
  server = await module.startWebServer(runtime, context);
}
async function connect() {
  const response = await fetch(`${server.origin}/api/v1/connect`, {
    method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: server.ticket() }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  const bootstrap = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  csrf = bootstrap.csrf;
}
async function api(path: string, input?: unknown) {
  return fetch(`${server.origin}/api/v1/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
}

function resourceProbe(script: string, request: (url: string, options: RequestInit) => Promise<Response>) {
  const listeners = new Map<string, () => void | Promise<void>>();
  const pageEvents = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const nodes = new Map<string, { textContent: string; disabled: boolean; addEventListener: (name: string, action: () => void | Promise<void>) => void }>();
  for (const id of ['emit', 'result', 'resource-probe', 'resource-result']) {
    nodes.set(id, { textContent: '', disabled: false, addEventListener: (name, action) => listeners.set(`${id}:${name}`, action) });
  }
  runInNewContext(script, {
    document: { getElementById: (id: string) => nodes.get(id) },
    window: { addEventListener: (name: string, action: () => void) => pageEvents.set(name, action) },
    console: { info: () => {} }, AbortController, fetch: request,
    setTimeout: (action: () => void, delay: number) => {
      expect(delay).toBe(3000); const id = ++timerId; timers.set(id, action); return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { click: () => listeners.get('resource-probe:click')?.(), hide: () => pageEvents.get('pagehide')?.(),
    button: nodes.get('resource-probe')!, result: nodes.get('resource-result')!, timers };
}

describe('same-runtime local Web workbench', () => {
  it('serves the bounded Kit Web reference without credentials and rejects non-read methods and foreign origins', async () => {
    await start();
    const response = await fetch(`${server.origin}/kit-readonly.html`);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('OHMate');
    expect(page).toContain('src="/kit-readonly.js"');
    const script = await (await fetch(`${server.origin}/kit-readonly.js`)).text();
    expect(script).toContain('console.info');
    expect(page + script).not.toMatch(/XMLHttpRequest|localStorage|sessionStorage|document.cookie|https:\/\//);
    expect(page).toContain('id="resource-probe"');
    let requests = 0;
    const probe = resourceProbe(script, async (url, options) => {
      requests++;
      expect(url).toBe('/kit-readonly.css');
      expect(options.credentials).toBe('omit'); expect(options.redirect).toBe('error');
      expect(options.cache).toBe('no-store'); expect(options.signal).toBeInstanceOf(AbortSignal);
      return fetch(server.origin + url, options);
    });
    expect(requests).toBe(0);
    await probe.click();
    expect(requests).toBe(1); expect(probe.button.disabled).toBe(false);
    expect(probe.result.textContent).toBe('本次请求收到原始资源响应。');
    expect(probe.timers.size).toBe(0);
    expect((await fetch(`${server.origin}/kit-readonly.html`, { method: 'POST', headers: { origin: server.origin } })).status).toBe(405);
    expect((await fetch(`${server.origin}/kit-readonly.html`, { headers: { origin: 'https://outside.invalid' } })).status).toBe(403);
    expect((await fetch(`${server.origin}/api/v1/capabilities`)).status).toBe(401);
  });
  it('cancels the resource probe body without applying or retaining its contents', async () => {
    await start();
    const script = await (await fetch(`${server.origin}/kit-readonly.js`)).text();
    let cancelled = 0;
    const probe = resourceProbe(script, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('private-fixture-never-rendered')); },
      cancel() { cancelled++; },
    }), { headers: { 'X-OHMate-Resource': 'fixture-opaque-id' } }));
    await probe.click();
    expect(cancelled).toBe(1); expect(probe.result.textContent).not.toContain('private-fixture');
    expect(probe.result.textContent).toBe('本次请求收到覆盖响应。当前授权和命中数以应用为准。');
    expect(probe.timers.size).toBe(0);
  });
  it('invalidates a pending resource probe on pagehide without a stale completion or stuck button', async () => {
    await start();
    const script = await (await fetch(`${server.origin}/kit-readonly.js`)).text();
    let resolve!: (value: Response) => void, signal: AbortSignal | undefined, calls = 0;
    const probe = resourceProbe(script, async (_url, options) => {
      signal = options.signal ?? undefined; calls++;
      return new Promise<Response>((done) => { resolve = done; });
    });
    const pending = probe.click();
    expect(probe.button.disabled).toBe(true);
    await probe.click(); expect(calls).toBe(1);
    probe.hide(); expect(signal?.aborted).toBe(true);
    const text = probe.result.textContent;
    resolve(new Response('discarded'));
    await pending;
    expect(probe.result.textContent).toBe(text);
    expect(probe.button.disabled).toBe(false);
    expect(probe.timers.size).toBe(0);
  });
  it('aborts resource probe timeout and hides the original error text', async () => {
    await start();
    const script = await (await fetch(`${server.origin}/kit-readonly.js`)).text();
    const probe = resourceProbe(script, async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('private-fixture-error')));
    }));
    const pending = probe.click();
    expect(probe.timers.size).toBe(1);
    for (const action of probe.timers.values()) { action(); }
    await pending;
    expect(probe.result.textContent).toBe('资源请求未完成，可重试。');
    expect(probe.button.disabled).toBe(false); expect(probe.timers.size).toBe(0);
  });
  it('opens without a model or project and exposes the actual registry', async () => {
    await start();
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${server.origin}/api/v1/capabilities`)).status).toBe(401);
    await connect();
    const response = await api('capabilities');
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((spec: { id: string }) => spec.id))
      .toEqual(runtime.registry.describe().map((spec) => (spec as { id: string }).id));
    const model = await (await api('execute', { toolId: 'model.list', input: {} })).json();
    expect(model.data).toEqual({ models: [], selected: null });
  });

  it('rejects forged origins, missing CSRF, ticket reuse, and arbitrary execution scope', async () => {
    await start();
    const ticket = server.ticket();
    const exchange = (origin: string) => fetch(`${server.origin}/api/v1/connect`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
    });
    expect((await exchange('https://other.example')).status).toBe(403);
    expect((await exchange(server.origin)).status).toBe(200);
    expect((await exchange(server.origin)).status).toBe(401);
    await connect();
    const forbidden = await fetch(`${server.origin}/api/v1/tasks`, {
      method: 'POST', headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ toolId: 'doctor', input: {} }),
    });
    expect(forbidden.status).toBe(403);
    expect((await api('tasks', { toolId: 'doctor', input: {}, projectRoot: '/unapproved' })).status).toBe(400);
    expect((await api('execute', { toolId: 'task.approve', input: {} })).status).toBe(400);
    expect((await api('tasks', { toolId: 'deveco.serve.mcp', input: { argv: [] } })).status).toBe(400);
    expect((await api('tasks', { toolId: 'ui.open', input: {} })).status).toBe(400);
  });

  it('shares task identity and receipt with terminal tools and replays ordered SSE cursors', async () => {
    await start(); await connect();
    const submitted = await (await api('tasks', { toolId: 'capabilities', input: {}, wait: true })).json();
    expect(submitted.data.state).toBe('succeeded');
    const task: TaskRecord = submitted.data;
    const cli = await runtime.execute('task.show', { id: task.id }, context);
    expect(cli.data).toEqual(task);
    const eventsResponse = await api(`tasks/${task.id}/events?after=1`);
    expect(eventsResponse.headers.get('content-type')).toContain('text/event-stream');
    const text = await eventsResponse.text();
    const events = text.split('\n\n').filter((block) => block.startsWith('id: ')).map((block) =>
      JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event, index) => event.taskId === task.id && event.sequence === index + 2)).toBe(true);
    const history = await (await api(`tasks/${task.id}/events?format=json&limit=2`)).json();
    expect(history.nextCursor).toBe(task.sequence);
    expect(history.events).toHaveLength(2);
    expect(history.truncated).toBe(true);
    expect(history.events.every((event: { taskId: string }) => event.taskId === task.id)).toBe(true);
    expect(text).toContain('event: end');
    const resumed = await fetch(`${server.origin}/api/v1/tasks/${task.id}/events`, {
      headers: { cookie, 'last-event-id': String(task.sequence - 1) },
    });
    expect(await resumed.text()).toContain(`id: ${task.sequence}`);
    await server.close();
    expect((await runtime.execute('task.show', { id: task.id }, context)).data).toEqual(task);
  });

  it('routes R2 through the same single-use approval without executing before confirmation', async () => {
    await start(); await connect();
    const submitted = await (await api('tasks', { toolId: 'deveco.ui', input: { argv: [] }, wait: true })).json();
    const task: TaskRecord = submitted.data;
    expect(task.state).toBe('awaiting-approval');
    expect(task.plan?.risk).toBe('R2');
    expect((await api(`tasks/${task.id}/approve`, { planId: 'wrong' })).status).toBe(400);
    const cancelled = await (await api(`tasks/${task.id}/cancel`, {})).json();
    expect(cancelled.data.state).toBe('cancelled');
    expect(cancelled.data.receipt.exitCode).toBe(130);
    expect((await runtime.execute('task.show', { id: task.id }, context)).data).toEqual(cancelled.data);
  });

  it('applies a confirmed R2 operation once through HTTP and refuses reuse', async () => {
    let writes = 0;
    runtime.registry.register({ ...serviceSpec('fixture.write', 'Write only a test-owned file', z.strictObject({}), async () => {
      writes++; await writeFile(join(root, 'confirmed.txt'), String(writes)); return { exitCode: 0, data: { writes } };
    }), risk: 'R2' });
    await start(); await connect();
    const task: TaskRecord = (await (await api('tasks', { toolId: 'fixture.write', input: {}, wait: true })).json()).data;
    expect(writes).toBe(0);
    expect(task.state).toBe('awaiting-approval');
    const approved = await (await api(`tasks/${task.id}/approve`, { planId: task.plan!.planId, wait: true })).json();
    expect(approved.data.state).toBe('succeeded');
    expect(await readFile(join(root, 'confirmed.txt'), 'utf8')).toBe('1');
    expect((await api(`tasks/${task.id}/approve`, { planId: task.plan!.planId, wait: true })).status).toBe(400);
    expect(writes).toBe(1);
  });

  it('ends cancelled event streams after the recorded worker is dead', async () => {
    await start(); await connect();
    const manager = new TaskManager(runtime, context);
    const task = await manager.store.create({ toolId: 'doctor', input: {}, projectRoot: null, cwd: root });
    await manager.store.transition(task.id, 'planning');
    await manager.store.transition(task.id, 'running');
    await manager.store.append(task.id, 'process.started', {
      pid: 2147483647, identity: 'a'.repeat(64), group: false, attempt: '6dc72396-bf69-4f44-bf80-687f1089fd0a',
    });
    expect((await manager.cancel(task.id, true)).state).toBe('cancelled');
    const response = await fetch(`${server.origin}/api/v1/tasks/${task.id}/events`, {
      headers: { cookie }, signal: AbortSignal.timeout(1500),
    });
    expect(await response.text()).toContain('event: end');
  });

  it('serves only bundled assets with CSP and never resolves a requested filesystem path', async () => {
    await start();
    const response = await fetch(server.origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).toContain('OHMate');
    expect(html).not.toContain('experience-data.js');
    expect((await fetch(`${server.origin}/package.json`)).status).toBe(404);
    expect((await fetch(`${server.origin}/%2e%2e%2fAGENTS.md`)).status).toBe(404);
  });

  it('lists a bounded public workspace tree without exposing private, excluded or traversal paths', async () => {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'oh_modules'));
    await mkdir(join(root, 'hvigor'));
    await mkdir(join(root, '.cache'));
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'src/main.ets'), '@Entry struct Main {}');
    await writeFile(join(root, 'README.md'), '# Public');
    await writeFile(join(root, '.env'), 'SECRET=private');
    await writeFile(join(root, 'node_modules/private.js'), 'private');
    await writeFile(join(root, 'data/private.json'), 'private');
    await start(); await connect();

    const response = await api('workspace/tree', { projectRoot: null, path: '', limit: 20 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: '', truncated: false, limit: 20,
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file', bytes: 8 },
      ],
    });
    const child = await api('workspace/tree', { projectRoot: null, path: 'src', limit: 20 });
    expect(await child.json()).toEqual({
      path: 'src', truncated: false, limit: 20,
      entries: [{ name: 'main.ets', path: 'src/main.ets', type: 'file', bytes: 21 }],
    });
    expect((await api('workspace/tree', { projectRoot: null, path: '../', limit: 20 })).status).toBe(400);
    expect((await api('workspace/tree', { projectRoot: null, path: 'node_modules', limit: 20 })).status).toBe(400);
  });

  it('registers real projects through a CLI-accessible tool and disallows incomplete directories', async () => {
    await start(); await connect();
    const invalid = await (await api('execute', { toolId: 'project.register', input: { path: root } })).json();
    expect(invalid.exitCode).not.toBe(0);
    await mkdir(join(root, 'AppScope'));
    await writeFile(join(root, 'AppScope/app.json5'), '{app:{bundleName:"com.example.web",versionCode:1,versionName:"1.0"}}');
    await writeFile(join(root, 'build-profile.json5'), '{app:{products:[{name:"default",compatibleSdkVersion:"6.0.0(20)"}]},modules:[]}');
    const registered = await (await api('execute', { toolId: 'project.register', input: { path: root } })).json();
    expect(registered.exitCode).toBe(0);
    const list = await runtime.execute('project.list', {}, context);
    expect(list.data).toEqual([expect.objectContaining({ root, name: 'web' })]);
    expect((await api('tasks', { toolId: 'project.inspect', input: {}, projectRoot: root, wait: true })).status).toBe(200);
    expect(await readFile(join(root, 'AppScope/app.json5'), 'utf8')).toContain('com.example.web');
  });
});
