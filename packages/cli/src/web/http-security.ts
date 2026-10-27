/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
export function headers(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
export async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') { throw new HttpError(415, 'JSON_REQUIRED'); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) { throw new HttpError(413, 'BODY_TOO_LARGE'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON_INVALID'); }
}
export const secret = () => randomBytes(32).toString('hex');
export function matches(value: unknown, expected: string): boolean {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export class BrowserAccess {
  private readonly tickets = new Map<string, number>();
  private readonly sessions = new Map<string, { csrf: string; expires: number }>();
  ticket(): string {
    this.prune();
    if (this.tickets.size >= 32) { throw new HttpError(429, 'TOO_MANY_TICKETS'); }
    const ticket = secret();
    this.tickets.set(ticket, Date.now() + 60_000);
    return ticket;
  }
  connect(value: unknown, response: ServerResponse): void {
    this.prune();
    if (typeof value !== 'string' || !this.tickets.delete(value)) { throw new HttpError(401, 'TICKET_INVALID_OR_EXPIRED'); }
    if (this.sessions.size >= 32) { throw new HttpError(429, 'TOO_MANY_BROWSER_SESSIONS'); }
    const id = secret();
    this.sessions.set(id, { csrf: secret(), expires: Date.now() + 8 * 60 * 60_000 });
    response.setHeader('set-cookie', `ohmate=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  }
  authorize(request: IncomingMessage): string {
    this.prune();
    const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith('ohmate='))?.slice(7);
    const session = cookie ? this.sessions.get(cookie) : undefined;
    if (!session) { throw new HttpError(401, 'BROWSER_SESSION_REQUIRED'); }
    if (request.method !== 'GET' && !matches(request.headers['x-ohmate-csrf'], session.csrf)) { throw new HttpError(403, 'CSRF_INVALID'); }
    return session.csrf;
  }
  private prune(): void {
    for (const [id, expires] of this.tickets) { if (expires <= Date.now()) { this.tickets.delete(id); } }
    for (const [id, session] of this.sessions) { if (session.expires <= Date.now()) { this.sessions.delete(id); } }
  }
}

export function checkOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'HOST_OR_SITE_INVALID');
  }
  if ((request.headers.origin && request.headers.origin !== origin) ||
    (request.method !== 'GET' && request.headers.origin !== origin)) { throw new HttpError(403, 'ORIGIN_INVALID'); }
}
