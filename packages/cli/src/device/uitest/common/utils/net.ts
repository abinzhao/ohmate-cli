/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import net from 'node:net';

/**
 * Check if a host port is connectable (someone is listening)
 */
export function isPortOpen(host: string, port: number, timeoutMs: number = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) {
        return undefined;
      }
      settled = true;
      socket.destroy();
      resolve(value);
      return undefined;
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/**
 * Get a free local port (actually tries to listen, more reliable than "cannot connect")
 */
export async function getFreePort({
  host = '127.0.0.1',
  start = 10000,
  end = 19999,
  exclude,
}: {
  host?: string;
  start?: number;
  end?: number;
  exclude?: Set<number>;
} = {}): Promise<number> {
  const tried = new Set(exclude || []);
  for (let port = start; port <= end; port++) {
    if (tried.has(port)) {
      continue;
    }
    const ok = await canListen(host, port);
    if (ok) {
      return port;
    }
  }
  throw new Error(`no free port in range ${start}-${end}`);
}

/** Semantic alias for local free port detection (getFreePort uses listen-based probing) */
export const getFreeLocalPort = getFreePort;

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Remote free port detection
 *
 * When the hdc server runs on **another host** (`hdc -s host:port`),
 * `fport tcp:<hostPort>` binds a port on that remote host, and the local machine cannot
 * use listen-based probing. Instead, TCP connect to candidate ports one by one:
 * if connectable, it's occupied; if not (refused/timeout), it's considered free
 * (aligned with hypium getFreePort's remote branch).
 *
 * Note: This approach has a race condition (the port may be taken between probing and actual binding),
 * so the caller must still handle fport failure and retry with the next port.
 */
export async function getFreeRemotePort({
  host = '127.0.0.1',
  start = 10000,
  end = 19999,
  exclude,
  timeoutMs = 500,
  stepDelayMs = 0,
}: {
  host?: string;
  start?: number;
  end?: number;
  exclude?: Set<number>;
  timeoutMs?: number;
  stepDelayMs?: number;
} = {}): Promise<number> {
  if (!host) {
    throw new Error('getFreeRemotePort requires host');
  }
  const tried = new Set(exclude || []);
  for (let port = start; port <= end; port++) {
    if (tried.has(port)) {
      continue;
    }
    const open = await isPortOpen(host, port, timeoutMs);
    if (!open) {
      return port;
    }
    if (stepDelayMs > 0) {
      await new Promise((r) => setTimeout(r, stepDelayMs));
    }
  }
  throw new Error(`no free port on remote ${host} in range ${start}-${end}`);
}

/**
 * Unified free port detection: use listen-based probing when hdc server is local,
 * TCP connect-based probing when remote
 */
export async function getFreeForwardPort({
  hdcHost = '127.0.0.1',
  start,
  end,
  exclude,
}: {
  hdcHost?: string;
  start?: number;
  end?: number;
  exclude?: Set<number>;
} = {}): Promise<{ port: number; scope: 'local' | 'remote' }> {
  const local = !hdcHost || hdcHost === '127.0.0.1' || hdcHost === 'localhost';
  if (local) {
    const port = await getFreeLocalPort({ host: hdcHost || '127.0.0.1', start, end, exclude });
    return { port, scope: 'local' };
  }
  const port = await getFreeRemotePort({ host: hdcHost, start, end, exclude, stepDelayMs: 50 });
  return { port, scope: 'remote' };
}

/**
 * Establish a TCP connection
 */
export function tcpConnect({
  host,
  port,
  timeoutMs = 5000,
  keepAliveMs,
}: {
  host: string;
  port: number;
  timeoutMs?: number;
  keepAliveMs?: number;
}): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const onError = (err: Error) => {
      if (settled) {
        return undefined;
      }
      settled = true;
      socket.destroy();
      reject(err);
      return undefined;
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      const err = new Error(`connect to ${host}:${port} timeout after ${timeoutMs}ms`) as Error & { code?: string };
      err.code = 'ETIMEDOUT';
      onError(err);
    });
    socket.once('error', onError);
    socket.connect(port, host, () => {
      if (settled) {
        return undefined;
      }
      settled = true;
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onError);
      if (keepAliveMs && keepAliveMs > 0) {
        socket.setKeepAlive(true, keepAliveMs);
      }
      socket.setNoDelay(true);
      resolve(socket);
      return undefined;
    });
  });
}

/**
 * Parse endpoints in the form `localabstract:uitest_socket` / `tcp:8012`
 */
export function parseDeviceEndpoint(endpoint: string): { scheme: string; value: string } {
  const idx = endpoint.indexOf(':');
  if (idx <= 0) {
    return { scheme: '', value: endpoint };
  }
  return { scheme: endpoint.slice(0, idx), value: endpoint.slice(idx + 1) };
}
