/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BrowserAccess, HttpError, body, checkOrigin, headers, json, matches } from './http-security.js';
import { handleApi } from './web-api.js';
import type { OHMateRuntime, ExecutionContext } from '../runtime/index.js';
import { BridgeHub } from '../debug/bridge-hub.js';
import type { BridgeStatus } from '../debug/bridge-status.js';
import { IdentitySchema } from '../debug-protocol/domain-schemas.js';
import { HdcSelectorSchema } from '../debug/hdc-forward.js';

const assets: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js',
  '/api.js': 'api.js', '/view.js': 'view.js', '/panels.js': 'panels.js', '/tasks.js': 'tasks.js',
  '/debug.js': 'debug.js', '/inspector.js': 'inspector.js', '/problem.js': 'problem.js', '/ui-model.js': 'ui-model.js',
  '/kit-readonly.html': 'kit-readonly.html', '/kit-readonly.js': 'kit-readonly.js', '/kit-readonly.css': 'kit-readonly.css',
};
function assetDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith('/web') || here.endsWith('\\web') ? resolve(here, '../../../../apps/web') : join(here, 'web');
}
async function staticAsset(path: string, response: ServerResponse): Promise<void> {
  const name = assets[path];
  if (!name) { throw new HttpError(404, 'ASSET_NOT_FOUND'); }
  const content = await readFile(join(assetDirectory(), name));
  response.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' :
    name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
  response.end(content);
}

interface ServerOptions {
  port?: number; controlSecret?: string; onClose?: () => Promise<void>;
  workbenchFingerprint?: string;
  debugSessionId?: string; journal?: { maxBytes?: number; maxEvents?: number };
  onBridgeStatus?: (status: BridgeStatus) => Promise<void>;
  // Explicit development-only admission; production workbenches never set this.
  devAutoPair?: boolean;
}
class WebRoutes {
  origin = '';
  active = 0;
  private streams = 0;
  readonly access = new BrowserAccess();
  constructor(private runtime: OHMateRuntime, private context: ExecutionContext, private signal: AbortSignal,
    private options: ServerOptions, private close: () => Promise<void>, readonly bridge?: BridgeHub) {}

  handle(request: IncomingMessage, response: ServerResponse): void {
    headers(response); this.active++;
    response.once('close', () => { this.active--; });
    void this.route(request, response).catch((error) => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      json(response, { code: error instanceof HttpError ? error.message : status === 400 ? 'INPUT_SCHEMA_INVALID' : 'REQUEST_FAILED' }, status);
    });
  }
  private async control(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.headers.host !== new URL(this.origin).host || request.headers.origin || request.method !== 'POST' ||
      url.search || request.headers['sec-fetch-site'] === 'cross-site' ||
      !this.options.controlSecret || !matches(request.headers['x-ohmate-control'], this.options.controlSecret)) { throw new HttpError(403, 'CONTROL_INVALID'); }
    if (url.pathname === '/_ohmate/ticket') { json(response, { ticket: this.access.ticket() }); return; }
    if (this.bridge && ['/_ohmate/pair', '/_ohmate/revoke'].includes(url.pathname)) {
      const input = z.strictObject({ cwd: z.string(), projectRoot: z.string().nullable(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        ...(url.pathname === '/_ohmate/pair' ? { target: IdentitySchema.omit({ fingerprint: true }), hdcDevice: HdcSelectorSchema.optional() } : {}) }).parse(await body(request));
      if (!this.options.workbenchFingerprint || input.fingerprint !== this.options.workbenchFingerprint ||
        input.cwd !== this.context.cwd || input.projectRoot !== this.context.projectRoot) { throw new HttpError(409, 'WORKBENCH_CHANGED'); }
      if ('target' in input) {
        const selector = 'hdcDevice' in input ? input.hdcDevice : undefined;
        json(response, typeof selector === 'string' ? await this.bridge.issueHdc(input.target, selector, Number(new URL(this.origin).port)) :
          await this.bridge.issue(input.target));
      }
      else { await this.bridge.revoke(); json(response, { revoked: true }); }
      return;
    }
    if (url.pathname === '/_ohmate/stop') {
      json(response, { stopped: true });
      setImmediate(() => { void this.close().catch(() => {}); }); return;
    }
    throw new HttpError(404, 'CONTROL_NOT_FOUND');
  }
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.active > 32) { throw new HttpError(429, 'REQUEST_LIMIT'); }
    const url = new URL(request.url ?? '/', this.origin);
    if (url.pathname.startsWith('/_ohmate/')) {
      await this.control(request, response, url); return;
    }
    checkOrigin(request, this.origin);
    if (this.options.devAutoPair && url.pathname === '/dev-invitation' && request.method === 'GET') {
      if (!this.bridge) { throw new HttpError(404, 'NOT_FOUND'); }
      const names = [...url.searchParams.keys()];
      if (!names.length || new Set(names).size !== names.length) { throw new HttpError(400, 'INPUT_SCHEMA_INVALID'); }
      const target = z.strictObject({
        buildId: z.string().min(1).max(512), device: z.string().min(1).max(128),
        process: z.string().min(1).max(128), sessionId: z.string().min(1).max(128),
      }).parse(Object.fromEntries(url.searchParams));
      const invitation = await this.bridge.issue(IdentitySchema.omit({ fingerprint: true }).parse({
        project: this.context.workspaceId, ...target,
      }));
      json(response, { endpoint: this.origin.replace('http:', 'ws:') + '/bridge/v1', invitation });
      return;
    }
    if (url.pathname === '/api/v1/connect' && request.method === 'POST') {
      this.access.connect(z.strictObject({ ticket: z.string() }).parse(await body(request)).ticket, response); json(response, { connected: true }); return;
    }
    if (!url.pathname.startsWith('/api/v1/')) {
      if (request.method !== 'GET') { throw new HttpError(405, 'METHOD_INVALID'); }
      await staticAsset(url.pathname, response); return;
    }
    const csrf = this.access.authorize(request), streaming = /\/(?:events|live)$/.test(url.pathname);
    if (this.bridge && url.pathname === '/api/v1/debug/bridge' && request.method === 'GET') {
      json(response, this.bridge.status()); return;
    }
    if (this.bridge && url.pathname === '/api/v1/debug/pairing' && request.method === 'POST') {
      json(response, await this.bridge.issue(await body(request))); return;
    }
    if (this.bridge && url.pathname === '/api/v1/debug/revoke' && request.method === 'POST') {
      z.strictObject({}).parse(await body(request)); await this.bridge.revoke(); json(response, this.bridge.status()); return;
    }
    if (streaming && this.streams >= 8) { throw new HttpError(429, 'STREAM_LIMIT'); }
    if (streaming) { this.streams++; }
    try { await handleApi(this.runtime, { ...this.context, abortSignal: this.signal }, request, response, url, csrf, this.signal, this.bridge); }
    finally { if (streaming) { this.streams--; } }
  }
}
export async function startWebServer(runtime: OHMateRuntime, context: ExecutionContext, options: ServerOptions = {}) {
  const controller = new AbortController();
  const bridge = options.debugSessionId ? new BridgeHub({ dataDir: context.dataDir, sessionId: options.debugSessionId,
    workspaceId: context.workspaceId, journal: options.journal, onStatus: options.onBridgeStatus,
    devAutoPair: options.devAutoPair === true }) : undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) { return closing; }
    controller.abort();
    closing = (async () => {
      try { await bridge?.close(); }
      finally {
        await new Promise<void>((resolve, reject) => {
          server.close(() => { Promise.resolve(options.onClose?.()).then(resolve, reject); }); server.closeAllConnections();
        });
      }
    })();
    return closing;
  };
  const routes = new WebRoutes(runtime, context, controller.signal, options, close, bridge);
  const server = createServer((request, response) => routes.handle(request, response));
  server.on('upgrade', (request, socket, head) => {
    if (bridge) { bridge.upgrade(request, socket, head, routes.origin); } else { socket.destroy(); }
  });
  server.maxConnections = 64; server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  routes.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin: routes.origin, ticket: () => routes.access.ticket(), close, bridgeStatus: () => bridge?.status() };
}
