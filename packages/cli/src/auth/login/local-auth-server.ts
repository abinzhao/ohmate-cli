/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { CallbackData } from '../types/auth-types.js';

// ============ LocalAuthServer ============
export class LocalAuthServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private clientSecret: string;
  private callbackPath: string = '/callback';
  private resolveCallback: ((value: CallbackData) => void) | null = null;
  private rejectCallback: ((reason: Error) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private baseUrl: string;
  private successRedirectUrl: string;
  private failedRedirectUrl: string;

  constructor(
    clientSecret: string,
    baseUrl: string,
    successRedirectUrl: string,
    failedRedirectUrl: string
  ) {
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl;
    this.successRedirectUrl = successRedirectUrl;
    this.failedRedirectUrl = failedRedirectUrl;
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.keepAliveTimeout = 1;
      server.on('error', (err) => {
        reject(new Error('Failed to start local auth server', { cause: err }));
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        const address = server.address() as AddressInfo;
        // 系统分配port
        this.port = address.port;
        resolve();
      });
    });
  }

  public async waitForCallback(timeout: number = 30000): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = (value: CallbackData) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        resolve(value);
      };
      this.rejectCallback = (reason: Error) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        reject(reason);
      };
      this.timeoutId = setTimeout(() => {
        this.timeoutId = null;
        this.rejectCallback?.(new Error('Callback timeout'));
      }, timeout);
    });
  }

  public async stop(): Promise<void> {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const server = this.server!;
      this.server = null;

      // 强制关闭所有连接（Node.js 18.2.0+）
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }

      // 设置超时保护，最多等待 100ms
      const timeout = setTimeout(() => {
        resolve();
      }, 100);

      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private handleRequest(_req: IncomingMessage, res: ServerResponse): void {
    const host = _req.headers.host || '';
    const expectedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!expectedHosts.includes(host.toLowerCase())) {
      res.writeHead(400);
      res.end('Bad Host');
      return;
    }
    const url = new URL(_req.url ?? '', `http://${host}`);

    if (url.pathname !== this.callbackPath) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    try {
      const urlParams = url.searchParams;

      if (_req.method === 'POST') {
        this.readBody(_req, res, urlParams);
      } else {
        this.handleCallbackRequest(_req, res, urlParams, '');
      }
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      this.rejectCallback?.(err as Error);
    }
  }

  private readBody(
    _req: IncomingMessage,
    res: ServerResponse,
    urlParams: URLSearchParams
  ): void {
    let body = '';
    let bodySize = 0;
    const MAX_BODY_SIZE = 65536;
    _req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        _req.destroy(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    _req.on('end', () => {
      this.handleCallbackRequest(_req, res, urlParams, body);
    });
  }

  private handleCallbackRequest(
    _req: IncomingMessage,
    res: ServerResponse,
    urlParams: URLSearchParams,
    body: string
  ): void {
    try {
      const params = this.parseParams(urlParams, body);
      const code = params.get('code');
      const tempToken = params.get('tempToken');
      const siteId = params.get('siteId');
      const quit = params.get('quit');

      if (!this.validateCode(code)) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      if (this.isQuitRequest(quit)) {
        this.handleQuitRequest(res);
        return;
      }

      if (!tempToken || !siteId) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      const callbackData: CallbackData = {
        tempToken,
        siteId,
        quit: quit ?? undefined,
      };

      this.resolveCallback?.(callbackData);
      this.sendSuccessResponse(res);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      this.rejectCallback?.(err as Error);
    }
  }

  private parseParams(
    urlParams: URLSearchParams,
    body: string
  ): URLSearchParams {
    if (body && body.trim()) {
      return new URLSearchParams(body);
    }
    return urlParams;
  }

  private validateCode(code: string | null): boolean {
    const codeBuffer = Buffer.from(code || '', 'utf8');
    const secretBuffer = Buffer.from(this.clientSecret, 'utf8');
    return (
      codeBuffer.length === secretBuffer.length &&
      crypto.timingSafeEqual(codeBuffer, secretBuffer)
    );
  }

  private isQuitRequest(quit: string | null): boolean {
    return quit === 'true' || quit === 'access_denied' || quit === 'quit';
  }

  private handleQuitRequest(res: ServerResponse): void {
    this.rejectCallback?.(new Error('User quit the login process'));
    res.writeHead(302, {
      Location: `${this.baseUrl}/${this.failedRedirectUrl}`,
    });
    res.end();
  }

  private sendSuccessResponse(res: ServerResponse): void {
    res.writeHead(302, {
      Location: `${this.baseUrl}/${this.successRedirectUrl}`,
    });
    res.end();
  }

  public getPort(): number {
    return this.port;
  }
}
