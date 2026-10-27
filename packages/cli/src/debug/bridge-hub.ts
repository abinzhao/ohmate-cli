/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { IdentitySchema } from '../debug-protocol/domain-schemas.js';
import { PairingAuthority } from '../debug-protocol/security.js';
import { HttpError } from '../web/http-security.js';
import { BridgeConnection } from './bridge-connection.js';
import { BridgeUpdates } from './bridge-updates.js';
import { BridgeStatusSchema, initialBridgeStatus } from './bridge-status.js';
import type { BridgeStatus } from './bridge-status.js';
import { ForwardAcquisitionError, HdcReadonlyForward } from './hdc-forward.js';
import type { ForwardDependencies } from './hdc-forward.js';
import type { PairingInvitation } from '../debug-protocol/security.js';

export interface BridgeHubOptions {
  dataDir: string; sessionId: string; workspaceId: string;
  journal?: { maxBytes?: number; maxEvents?: number };
  onStatus?: (status: BridgeStatus) => Promise<void>;
  forwardDependencies?: ForwardDependencies;
  pairingTtlMs?: number;
  // Development-only: allow a loopback client that appends its own Origin value.
  devAutoPair?: boolean;
}
export class BridgeHub {
  private authority: PairingAuthority;
  private readonly websocket = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 96 * 1024, perMessageDeflate: false });
  private readonly connections = new Set<BridgeConnection>();
  private state: BridgeStatus;
  private publication = Promise.resolve();
  private publicationError: unknown;
  private closed = false;
  private forwarding?: HdcReadonlyForward;
  private issuance?: Promise<PairingInvitation>;
  private pairingExpiry?: ReturnType<typeof setTimeout>;
  private shutdown?: Promise<void>;
  private controller = new AbortController();
  private revoking = false;
  private readonly updates = new BridgeUpdates();
  constructor(private options: BridgeHubOptions) {
    this.authority = this.newAuthority();
    this.state = initialBridgeStatus(this.authority.fingerprint);
  }
  private newAuthority(): PairingAuthority {
    return new PairingAuthority({ maxPending: 1, pairingTtlMs: this.options.pairingTtlMs });
  }
  status(): BridgeStatus { return structuredClone(this.state); }
  watch(sessionId: string, streamId: string) {
    if (this.closed || sessionId !== this.options.sessionId) { return undefined; }
    return this.updates.watch(streamId);
  }
  async issue(input: unknown) {
    this.assertAvailable();
    this.issuance = this.invite(input);
    try { return await this.issuance; } finally { this.issuance = undefined; }
  }
  async issueHdc(input: unknown, selector: string, port: number): Promise<PairingInvitation> {
    this.assertAvailable();
    const target = this.target(input);
    this.issuance = this.forwardAndInvite(target, selector, port);
    try { return await this.issuance; } finally { this.issuance = undefined; }
  }
  private assertAvailable(): void {
    if (this.closed || this.revoking || this.connections.size || this.forwarding || this.issuance) {
      throw new HttpError(409, 'BRIDGE_BUSY');
    }
  }
  private target(input: unknown) {
    const target = IdentitySchema.omit({ fingerprint: true }).parse(input);
    if (target.project !== this.options.workspaceId) { throw new HttpError(400, 'PAIRING_PROJECT_MISMATCH'); }
    return target;
  }
  private async forwardAndInvite(target: ReturnType<BridgeHub['target']>, selector: string, port: number): Promise<PairingInvitation> {
    try {
      this.forwarding = await HdcReadonlyForward.acquire({ dataDir: this.options.dataDir, selector, port,
        signal: this.controller.signal }, this.options.forwardDependencies);
    } catch (error) {
      if (error instanceof ForwardAcquisitionError) {
        this.forwarding = error.owner;
        this.state = BridgeStatusSchema.parse({ ...this.state, state: 'degraded',
          reason: 'HDC_FORWARD_CLEANUP_REQUIRED', hdcForward: error.owner.binding });
        await this.options.onStatus?.(this.state);
      }
      if (this.closed) { throw new Error('BRIDGE_CLOSED', { cause: error }); }
      throw error;
    }
    try {
      if (this.closed || this.revoking) { throw new Error('BRIDGE_CLOSED'); }
      return await this.invite(target);
    } catch (error) { await this.releaseForward(); throw error; }
  }
  private async invite(input: unknown): Promise<PairingInvitation> {
    const target = this.target(input);
    const invitation = this.authority.issue(target);
    try {
      await this.publish({ state: 'pairing', authentication: 'unpaired', target: null, ackThrough: 0, streamId: null, reason: null, gap: null,
        ...(this.forwarding ? { hdcForward: this.forwarding.binding } : {}) });
    } catch (error) { this.authority.close(); this.authority = this.newAuthority(); throw error; }
    clearTimeout(this.pairingExpiry);
    this.pairingExpiry = setTimeout(() => {
      if (this.state.state === 'pairing') { void this.publish({ state: 'expired', reason: 'PAIRING_EXPIRED' }).catch(() => {}); }
    }, Math.max(0, invitation.expiresAt - Date.now()));
    this.pairingExpiry.unref();
    return invitation;
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, origin: string): void {
    const url = new URL(request.url ?? '/', origin);
    const originHeader = request.headers.origin;
    const originAccepted = !originHeader || originHeader === origin ||
      (this.options.devAutoPair === true && originHeader.split(',').map((item) => item.trim()).includes(origin));
    if (this.closed || this.connections.size || request.method !== 'GET' || request.headers.host !== new URL(origin).host ||
      url.pathname !== '/bridge/v1' || url.search || !originAccepted ||
      !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress ?? '') ||
      request.headers['sec-websocket-protocol'] !== 'ohmate-readonly-v1') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    this.websocket.handleUpgrade(request, socket, head, (ws) => {
      const connection = new BridgeConnection(ws, { ...this.options, authority: this.authority,
        publish: (update) => this.publish(update), released: (current) => { this.connections.delete(current); } });
      this.connections.add(connection);
    });
  }
  async publish(update: Partial<BridgeStatus>): Promise<void> {
    const next = this.publication.then(async () => {
      if (update.state && update.state !== 'pairing' && update.state !== 'waiting-pairing') { clearTimeout(this.pairingExpiry); }
      if (update.state && ['disconnected', 'revoked', 'expired', 'degraded'].includes(update.state)) {
        await this.releaseForward();
      }
      const snapshot = BridgeStatusSchema.parse({ ...this.state, ...update });
      await this.options.onStatus?.(snapshot);
      const previousStream = this.state.streamId;
      this.state = snapshot; this.publicationError = undefined;
      this.updates.notify(previousStream, snapshot.streamId);
    });
    this.publication = next.catch((error: unknown) => {
      this.publicationError = error;
      if (this.forwarding?.binding.state !== 'cleanup-failed') {
        this.state = BridgeStatusSchema.parse({ ...this.state, state: 'degraded', reason: 'STATUS_PERSISTENCE_FAILED' });
      }
    });
    await next;
  }
  private async releaseForward(): Promise<void> {
    const forwarding = this.forwarding;
    if (!forwarding) { return; }
    try {
      await forwarding.close();
      this.state = BridgeStatusSchema.parse({ ...this.state, hdcForward: forwarding.binding });
      this.forwarding = undefined;
    } catch (error) {
      this.state = BridgeStatusSchema.parse({ ...this.state, hdcForward: forwarding.binding,
        state: 'degraded', reason: 'HDC_FORWARD_CLEANUP_FAILED' });
      await this.options.onStatus?.(this.state);
      throw error;
    }
  }
  async revoke(): Promise<void> {
    if (this.revoking) { throw new HttpError(409, 'BRIDGE_BUSY'); }
    this.revoking = true;
    try {
      await this.issuance?.catch(() => {});
      for (const connection of [...this.connections]) { await connection.close(); }
      this.authority.close(); this.authority = this.newAuthority();
      await this.publish({ state: 'revoked', fingerprint: this.authority.fingerprint, reason: 'USER_REVOKED' });
    } finally { this.revoking = false; }
  }
  close(): Promise<void> {
    if (!this.shutdown) {
      this.closed = true; this.controller.abort(); clearTimeout(this.pairingExpiry);
      this.updates.close();
      this.shutdown = this.stop();
    }
    return this.shutdown;
  }
  private async stop(): Promise<void> {
    await this.issuance?.catch(() => {});
    for (const connection of [...this.connections]) { await connection.close(); }
    this.authority.close();
    await new Promise<void>((resolve) => { this.websocket.close(() => resolve()); });
    await this.publication;
    await this.releaseForward();
    if (this.state.hdcForward) { await this.publish({ state: 'disconnected', reason: 'SERVICE_CLOSED' }); }
    if (this.publicationError) { throw this.publicationError; }
  }
}
