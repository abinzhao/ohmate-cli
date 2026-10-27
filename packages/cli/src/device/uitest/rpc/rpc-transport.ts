/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type net from 'node:net';
import { tcpConnect } from '../common/utils/net.js';
import { createCodec, type Codec } from '../common/utils/framing.js';
import { requestId } from '../common/utils/id.js';
import { Semaphore } from '../common/utils/async.js';
import { RpcTransportError, RpcTimeoutError, RpcProtocolError } from '../common/errors.js';
import type { Logger } from '../common/logger.js';
import type { Dfx } from '../common/dfx.js';
import type { RpcResponse } from './protocol.js';

/** Concurrency mode constants */
export const ConcurrencyMode = {
  AUTO: 'auto',
  PIPELINED: 'pipelined',
  SERIAL: 'serial',
} as const;

export type ConcurrencyModeValue = (typeof ConcurrencyMode)[keyof typeof ConcurrencyMode];

export interface RpcTransportOptions {
  host?: string;
  port: number;
  name?: string;
  framing?: 'length-prefixed' | 'raw' | 'auto';
  concurrency?: string;
  maxInFlight?: number;
  strictPairing?: boolean;
  timeoutKillsConnection?: boolean;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketIdleTimeoutMs?: number;
  logger?: Logger | null;
  dfx?: Dfx | null;
}

export interface SendOptions {
  timeoutMs?: number;
}

export interface ConnectOptions {
  port?: number;
  timeoutMs?: number;
}

type Resolver = (value: unknown | PromiseLike<unknown>) => void;
type Rejecter = (reason?: unknown) => void;
type DfxEndFn = (extraFields?: Record<string, unknown>) => number;
type SettleFn = (fn: (arg: unknown) => void, arg: unknown) => void;

interface PendingEntry {
  resolve: Resolver;
  reject: Rejecter;
  timer: ReturnType<typeof setTimeout> | null;
  t0: number;
  gen: number;
  seq: number;
}

interface TransportStats {
  connectCount: number;
  requestCount: number;
  bytesIn: number;
  bytesOut: number;
  maxInFlight: number;
  timeouts: number;
  unmatchedResponses: number;
  queued: number;
}

export class RpcTransport {
  host: string;
  port: number;
  name: string;
  codec: Codec;
  frameDelimited: boolean;
  concurrency: string;
  maxInFlight: number;
  strictPairing: boolean;
  timeoutKillsConnection: boolean;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  socketIdleTimeoutMs: number;
  logger: Logger | null;
  dfx: Dfx | null;
  socket: net.Socket | null;
  buffer: Buffer;
  pending: Map<string, PendingEntry>;
  _sem: Semaphore;
  generation: number;
  _closed: boolean;
  _failure: Error | null;
  onClose: ((err: Error | null) => void) | null;
  _serverEchoesRequestId: boolean | null;
  _seq: number;
  stats: TransportStats;

  constructor(options: RpcTransportOptions) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port;
    this.name = options.name || 'rpc';
    this.codec = createCodec(options.framing || 'auto');
    this.frameDelimited = this.codec.frameDelimited === true;
    this.concurrency = options.concurrency || ConcurrencyMode.AUTO;
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 16);
    this.strictPairing = options.strictPairing === true;
    this.timeoutKillsConnection = options.timeoutKillsConnection === true;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.socketIdleTimeoutMs = options.socketIdleTimeoutMs ?? 30000;
    this.logger = options.logger ?? null;
    this.dfx = options.dfx ?? null;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this._sem = new Semaphore(this._initialLimit());
    this.generation = 0;
    this._closed = true;
    this._failure = null;
    this.onClose = null;
    this._serverEchoesRequestId = null;
    this._seq = 0;
    this.stats = {
      connectCount: 0,
      requestCount: 0,
      bytesIn: 0,
      bytesOut: 0,
      maxInFlight: 0,
      timeouts: 0,
      unmatchedResponses: 0,
      queued: 0,
    };
  }

  get isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed && !this._closed;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  get concurrencyMode(): string {
    if (this.concurrency === ConcurrencyMode.SERIAL) {
      return 'serial';
    }
    if (!this.frameDelimited) {
      return 'serial(raw)';
    }
    if (this.concurrency === ConcurrencyMode.PIPELINED) {
      return 'pipelined';
    }
    return this._serverEchoesRequestId === true ? 'pipelined(auto)' : 'serial(auto)';
  }

  /** Establish connection */
  async connect(options: ConnectOptions = {}): Promise<void> {
    await this.destroy();
    const port = options.port ?? this.port;
    const timeoutMs = options.timeoutMs ?? this.connectTimeoutMs;
    const end = this.dfx ? this.dfx.timer('rpc.connect', { endpoint: this.name }) : null;
    try {
      this.socket = await tcpConnect({ host: this.host, port, timeoutMs });
    } catch (err) {
      const error = err as Error;
      if (end) {
        end({ ok: 0 });
      }
      if (this.dfx) {
        this.dfx.counter('rpc.connect.error', 1, { endpoint: this.name });
      }
      throw new RpcTransportError(`connect ${this.host}:${port} failed: ${error.message}`, {
        cause: error,
        details: { endpoint: this.name, host: this.host, port },
      });
    }

    const gen = ++this.generation;
    this._postConnectSetup();
    if (end) {
      end({ ok: 1 });
    }
    if (this.dfx) {
      this.dfx.counter('rpc.connect.ok', 1, { endpoint: this.name });
    }

    const socket = this.socket;
    socket.setTimeout(this.socketIdleTimeoutMs);
    this._attachSocketHandlers(socket, gen);

    if (this.logger) {
      this.logger.info(`connected to ${this.host}:${port} (${this.name}, gen=${gen})`);
    }
  }

  _postConnectSetup(): void {
    this._closed = false;
    this._failure = null;
    this.buffer = Buffer.alloc(0);
    this.pending.clear();
    this._serverEchoesRequestId = null;
    this._sem.resize(this._computeLimit());
    this.stats.connectCount += 1;
  }

  _attachSocketHandlers(socket: net.Socket, gen: number): void {
    socket.on('data', (chunk: Buffer) => {
      if (gen !== this.generation) {
        return;
      }
      this._onData(chunk);
    });
    socket.on('error', (err: Error) => {
      if (gen !== this.generation) {
        return;
      }
      this._fail(new RpcTransportError(`socket error: ${err.message}`, { cause: err }));
    });
    socket.on('timeout', () => {
      if (gen !== this.generation) {
        return;
      }
      this._fail(new RpcTimeoutError(`socket idle timeout after ${this.socketIdleTimeoutMs}ms`));
    });
    socket.on('close', () => {
      if (gen !== this.generation) {
        return;
      }
      this._fail(new RpcTransportError('connection closed by peer'));
    });
  }

  _onData(chunk: Buffer): void {
    this.stats.bytesIn += chunk.length;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const decoded = this.codec.decode(this.buffer);
        if (!decoded) {
          break;
        }
        this.buffer = decoded.rest;
        this._dispatch(decoded.value);
      }
    } catch (err) {
      const error = err as Error;
      this._fail(error instanceof RpcProtocolError ? error : new RpcProtocolError(`decode failed: ${error.message}`));
    }
  }

  /** Response dispatch: the sole place that decides "which response belongs to which request" */
  _dispatch(value: unknown): void {
    const obj = value as RpcResponse | null;
    const id = obj && typeof obj === 'object' ? obj.request_id : undefined;
    let key: string | null = null;

    if (id != null && this.pending.has(id)) {
      key = id;
    } else if (id == null) {
      if (this.pending.size === 1) {
        key = [...this.pending.keys()][0];
      }
      this._noteNoRequestId();
    }

    if (key == null) {
      this.stats.unmatchedResponses += 1;
      if (this.dfx) {
        this.dfx.counter('rpc.response.unmatched', 1, {
          endpoint: this.name,
          hasId: String(id != null),
        });
      }
      if (this.logger) {
        this.logger.warn(`drop unmatched response (request_id=${id}, pending=${this.pending.size})`);
      }
      if (this.strictPairing) {
        this._fail(new RpcProtocolError(`unmatched response, request_id=${id}, pending=${this.pending.size}`));
      }
      return;
    }

    const entry = this.pending.get(key) as PendingEntry;
    this.pending.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    if (id != null && this._serverEchoesRequestId !== true) {
      this._serverEchoesRequestId = true;
      this._applyLimit();
    }
    entry.resolve(value);
  }

  /** Server does not return request_id: degrade to serial to avoid inability to distinguish ownership under multiplexing */
  _noteNoRequestId(): void {
    if (this._serverEchoesRequestId === false) {
      return;
    }
    this._serverEchoesRequestId = false;
    this._applyLimit();
    if (this.logger) {
      this.logger.warn('server does not echo request_id, degrade to serial mode for this connection');
    }
    if (this.dfx) {
      this.dfx.counter('rpc.concurrency.degrade', 1, { endpoint: this.name });
    }
  }

  _computeLimit(): number {
    if (this.concurrency === ConcurrencyMode.SERIAL) {
      return 1;
    }
    if (!this.frameDelimited) {
      return 1;
    }
    if (this.concurrency === ConcurrencyMode.PIPELINED) {
      return this.maxInFlight;
    }
    return this._serverEchoesRequestId === true ? this.maxInFlight : 1;
  }

  _initialLimit(): number {
    if (this.concurrency === ConcurrencyMode.SERIAL) {
      return 1;
    }
    if (!this.frameDelimited) {
      return 1;
    }
    if (this.concurrency === ConcurrencyMode.PIPELINED) {
      return this.maxInFlight;
    }
    return 1;
  }

  _applyLimit(): void {
    this._sem.resize(this._computeLimit());
  }

  /** Allocate a request_id unique within this connection */
  _nextRequestId(preferred: unknown): string {
    if (preferred != null && !this.pending.has(String(preferred))) {
      return String(preferred);
    }
    let id = requestId();
    while (this.pending.has(id)) {
      id = requestId();
    }
    return id;
  }

  /**
   * Send a request and wait for the paired response (concurrency-safe)
   */
  async send(payload: Record<string, unknown>, options: SendOptions = {}): Promise<unknown> {
    this._assertUsable();
    const release = await this._acquireSendSlot();
    try {
      this._assertUsable();

      const gen = this.generation;
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const id = this._nextRequestId(payload && payload.request_id);
      const frame = { ...payload, request_id: id };
      const seq = ++this._seq;
      const end = this.dfx ? this.dfx.timer('rpc.request', { endpoint: this.name }) : null;

      const value = await this._awaitResponse(id, frame, gen, seq, timeoutMs, end);

      if (end) {
        end({ ok: 1 });
      }
      if (this.dfx) {
        this.dfx.counter('rpc.request.ok', 1, { endpoint: this.name });
      }
      return value;
    } finally {
      if (release) {
        release();
      }
    }
  }

  async _acquireSendSlot(): Promise<(() => void) | null> {
    // eslint-disable-next-line no-useless-assignment
    let release: (() => void) | null = null;
    try {
      if (this._sem.available <= 0 || this._sem.waiting > 0) {
        this.stats.queued += 1;
      }
      release = await this._sem.acquire();
    } catch (err) {
      const error = err as Error;
      throw new RpcTransportError(`request rejected while queued: ${error.message}`, {
        cause: error,
        details: { endpoint: this.name },
      });
    }
    return release;
  }

  _awaitResponse(
    id: string,
    frame: Record<string, unknown>,
    gen: number,
    seq: number,
    timeoutMs: number,
    end: DfxEndFn | null,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingEntry = { resolve: resolve as Resolver, reject: reject as Rejecter, timer: null, t0: Date.now(), gen, seq };
      const settle = this._createSettleFn(id, entry);
      entry.timer = setTimeout(() => this._onRequestTimeout(id, timeoutMs, end, settle, reject), timeoutMs);
      this._registerPending(id, entry);
      this._writeFrame(frame, seq, settle, reject);
    });
  }

  _createSettleFn(id: string, entry: PendingEntry): SettleFn {
    return (fn: (arg: unknown) => void, arg: unknown) => {
      if (this.pending.get(id) !== entry) {
        return undefined;
      }
      this.pending.delete(id);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      fn(arg);
      return undefined;
    };
  }

  _onRequestTimeout(
    id: string,
    timeoutMs: number,
    end: DfxEndFn | null,
    settle: SettleFn,
    reject: Rejecter,
  ): void {
    this.stats.timeouts += 1;
    const err = new RpcTimeoutError(`rpc request ${id} timeout after ${timeoutMs}ms`, {
      details: { endpoint: this.name, requestId: id },
    });
    if (end) {
      end({ ok: 0, reason: 'timeout' });
    }
    if (this.dfx) {
      this.dfx.counter('rpc.request.error', 1, { endpoint: this.name, reason: 'timeout' });
    }
    settle(reject as (arg: unknown) => void, err);
    if (this.timeoutKillsConnection) {
      this._fail(err);
    }
  }

  _registerPending(id: string, entry: PendingEntry): void {
    this.pending.set(id, entry);
    this.stats.requestCount += 1;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.pending.size);
  }

  _writeFrame(
    frame: Record<string, unknown>,
    seq: number,
    settle: SettleFn,
    reject: Rejecter,
  ): void {
    // eslint-disable-next-line no-useless-assignment
    let written = false;
    try {
      const data = this.codec.encode(frame);
      this.stats.bytesOut += data.length;
      if (this.logger) {
        this.logger.debug(`-> ${this.name} #${seq} ${JSON.stringify(frame).slice(0, 300)}`);
      }
      const sock = this.socket;
      if (!sock) {
        throw new RpcTransportError('socket is null');
      }
      written = sock.write(data, (err: Error | null | undefined) => {
        if (!err) {
          return;
        }
        settle(reject as (arg: unknown) => void, new RpcTransportError(`write failed: ${err.message}`, { cause: err }));
      });
    } catch (err) {
      const error = err as Error;
      settle(reject as (arg: unknown) => void, new RpcTransportError(`write failed: ${error.message}`, { cause: error }));
      return;
    }
    if (!written && this.logger) {
      this.logger.debug(`socket backpressure on #${seq}`);
    }
  }

  _assertUsable(): void {
    if (this.isConnected) {
      return;
    }
    throw new RpcTransportError(
      this._failure ? `connection broken: ${this._failure.message}` : 'transport is not connected',
      { cause: this._failure || undefined, details: { endpoint: this.name } },
    );
  }

  /** Unified failure handling: reject all in-flight requests + wake up queued callers + close socket */
  _fail(err: Error): void {
    if (this._closed && this.pending.size === 0 && this._sem.waiting === 0) {
      return;
    }
    this._failure = err;
    this._rejectAll(err);
    this._closeSocket();
    if (this.onClose) {
      try {
        this.onClose(err);
      } catch {
        /* noop */
      }
    }
  }

  _rejectAll(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      try {
        entry.reject(err);
      } catch {
        /* noop */
      }
    }
    this._sem.abortAll(err);
  }

  _closeSocket(): void {
    this._closed = true;
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Active close (normal release)
   */
  async close(reason: string = 'closed by client'): Promise<void> {
    const err = new RpcTransportError(`transport closed: ${reason}`);
    this._failure = null;
    this._rejectAll(err);
    this._closeSocket();
    if (this.logger) {
      this.logger.debug(`transport closed: ${reason}`);
    }
  }

  async destroy(): Promise<void> {
    await this.close('destroy');
  }

  /** Diagnostic snapshot */
  getSnapshot(): Record<string, unknown> {
    return {
      name: this.name,
      host: this.host,
      port: this.port,
      connected: this.isConnected,
      generation: this.generation,
      concurrency: this.concurrency,
      concurrencyMode: this.concurrencyMode,
      maxInFlight: this._sem.limit,
      inFlight: this.pending.size,
      queued: this._sem.waiting,
      serverEchoesRequestId: this._serverEchoesRequestId,
      stats: { ...this.stats },
    };
  }
}
