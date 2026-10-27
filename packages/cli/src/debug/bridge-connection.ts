/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import type WebSocket from 'ws';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createReadonlyBridge, ProtocolError, EventBatchSchema } from '../debug-protocol/index.js';
import type { ReadonlyBridge, Handshake } from '../debug-protocol/index.js';
import type { PairingAuthority, SecureChannel } from '../debug-protocol/security.js';
import { securityError } from '../debug-protocol/security-schemas.js';
import { ClockReplySchema, validateClockSample, type ClockSample } from '../debug-protocol/clock-calibration.js';
import { EventJournal } from './event-journal.js';
import type { BridgeStatus } from './bridge-status.js';

export interface ConnectionOwner {
  authority: PairingAuthority; dataDir: string; sessionId: string;
  journal?: { maxBytes?: number; maxEvents?: number };
  publish(update: Partial<BridgeStatus>): Promise<void>;
  released(connection: BridgeConnection): void;
}
const readySchema = z.strictObject({
  type: z.literal('ready'), sessionEpoch: z.string().uuid(),
  clockSync: z.literal('four-timestamp-v1').optional(),
  eventBatch: z.literal('events-v1').optional(),
  retention: z.literal('rolling-v1').optional(),
  resume: z.strictObject({ streamId: z.string().uuid(), previousEpoch: z.string().uuid(),
    resumeFrom: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
}).refine((ready) => !ready.retention || ready.eventBatch === 'events-v1');
export class BridgeConnection {
  private channel: SecureChannel | null = null;
  private bridge: ReadonlyBridge | null = null;
  private journal: EventJournal | null = null;
  private epoch = randomUUID();
  private connected = false;
  private closed = false;
  private queuedFrames = 0;
  private queuedBytes = 0;
  private tail = Promise.resolve();
  private terminalPublication = Promise.resolve();
  private released = false;
  private expiry?: ReturnType<typeof setTimeout>;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly desktopClockId = randomUUID();
  private clockSync = false;
  private eventBatch = false;
  private clockSample: ClockSample | null = null;
  private pendingProbe: { probeId: string; t0: string } | null = null;
  private probeDeadline?: ReturnType<typeof setTimeout>;
  constructor(private socket: WebSocket, private owner: ConnectionOwner) {
    this.timeout = setTimeout(() => { void this.fail('PAIRING_TIMEOUT'); }, 10_000); this.timeout.unref();
    socket.on('message', (bytes, binary) => this.enqueue(bytes.toString(), binary));
    socket.once('error', () => { void this.fail('CONNECTION_FAILED'); });
    socket.once('close', () => { void this.disconnect(); });
  }
  private enqueue(text: string, binary: boolean): void {
    if (this.closed) { return; }
    const receivedNs = process.hrtime.bigint().toString();
    if (binary || ++this.queuedFrames > 8 || (this.queuedBytes += Buffer.byteLength(text)) > 512 * 1024) {
      void this.fail('FRAME_BACKPRESSURE'); return;
    }
    this.tail = this.tail.then(async () => {
      if (!this.closed) { await this.receive(JSON.parse(text), receivedNs); }
    }).catch((error: unknown) => this.fail(this.reason(error), error instanceof ProtocolError ? error.gap : undefined)).finally(() => {
      this.queuedFrames--; this.queuedBytes -= Buffer.byteLength(text);
    });
  }
  private async receive(input: unknown, receivedNs: string): Promise<void> {
    if (!this.channel) {
      const accepted = this.owner.authority.accept(input);
      this.handshake = accepted.handshake;
      this.peer = accepted.peer;
      this.negotiatedVersion = accepted.negotiated.protocolVersion;
      this.channel = accepted.channel; this.bridge = createReadonlyBridge(accepted.handshake);
      this.bridge.connect(accepted.peer, this.epoch);
      this.expiry = setTimeout(() => { void this.fail('KEY_EXPIRED'); }, Math.max(0, accepted.reply.expiresAt - Date.now()));
      this.expiry.unref();
      this.write(JSON.stringify(accepted.reply));
      this.send({ type: 'ready', sessionEpoch: this.epoch });
      return;
    }
    const plaintext = this.channel.open(input);
    if (!this.connected) {
      const ready = readySchema.parse(plaintext);
      if (ready.sessionEpoch !== this.epoch) { throw new ProtocolError('EPOCH_MISMATCH'); }
      await this.confirm(ready); return;
    }
    if (typeof plaintext === 'object' && plaintext !== null && 'type' in plaintext && plaintext.type === 'clock-reply') {
      this.receiveClock(plaintext, receivedNs); return;
    }
    if (typeof plaintext === 'object' && plaintext !== null && 'type' in plaintext && plaintext.type === 'event-batch') {
      if (!this.eventBatch) { throw new ProtocolError('INVALID_SCHEMA'); }
      await this.events(EventBatchSchema.parse(plaintext).events, receivedNs); return;
    }
    await this.event(plaintext, receivedNs);
  }
  private async confirm(ready: z.infer<typeof readySchema>): Promise<void> {
    let ackThrough = 0;
    if (ready.resume) {
      const restored = await EventJournal.resume(this.owner.dataDir, this.owner.sessionId, ready.resume.streamId,
        this.bridgeIdentity(), this.peer!, { ...this.bridgeIdentity().identity, type: 'resume',
          protocolVersion: this.negotiatedVersion,
          sessionEpoch: this.epoch, previousEpoch: ready.resume.previousEpoch, resumeFrom: ready.resume.resumeFrom },
        { segmented: ready.eventBatch === 'events-v1', ...(ready.retention ? { retention: ready.retention } : {}) });
      this.journal = restored.journal; this.bridge = restored.bridge; ackThrough = restored.ack.ackThrough;
    } else {
      this.journal = await EventJournal.create(this.owner.dataDir, this.owner.sessionId, this.bridgeIdentity(),
        { ...this.owner.journal, segmented: ready.eventBatch === 'events-v1',
          ...(ready.retention ? { retention: ready.retention } : {}), resume: { peer: this.peer!, epoch: this.epoch } });
    }
    if (this.closed) { return; }
    this.connected = true; clearTimeout(this.timeout);
    await this.publish({ state: 'connected', authentication: 'pairing-proof', target: this.bridgeIdentity().identity,
      streamId: this.journal.streamId, ackThrough, reason: null, gap: null });
    this.send({ type: ready.resume ? 'resumed' : 'connected', sessionEpoch: this.epoch,
      ...(ready.eventBatch ? { eventBatch: ready.eventBatch } : {}),
      ...(ready.retention ? { retention: ready.retention } : {}),
      ...(ready.resume ? { streamId: this.journal.streamId, ackThrough } : {}) });
    this.clockSync = ready.clockSync === 'four-timestamp-v1';
    this.eventBatch = ready.eventBatch === 'events-v1';
    if (this.clockSync) { this.probeClock(); }
  }
  private handshake: Handshake | null = null;
  private peer: Handshake | null = null;
  private negotiatedVersion: '1.1' | '1.0' | undefined;
  private bridgeIdentity(): Handshake {
    if (!this.handshake) { throw new Error('BRIDGE_REJECTED'); }
    return this.handshake;
  }
  private probeClock(): void {
    if (this.pendingProbe) { return; }
    const probeId = randomUUID(), t0 = process.hrtime.bigint().toString();
    this.pendingProbe = { probeId, t0 };
    this.send({ type: 'clock-probe', version: '1', probeId, sessionEpoch: this.epoch, t0 });
    this.probeDeadline = setTimeout(() => { void this.fail('CLOCK_SAMPLE_INVALID'); }, 10000);
    this.probeDeadline.unref();
  }
  private receiveClock(input: unknown, receivedNs: string): void {
    const parsed = ClockReplySchema.safeParse(input);
    if (!parsed.success || !this.clockSync || !this.pendingProbe) { throw new Error('CLOCK_SAMPLE_INVALID'); }
    const reply = parsed.data;
    if (reply.sessionEpoch !== this.epoch || reply.probeId !== this.pendingProbe.probeId || reply.t0 !== this.pendingProbe.t0) {
      throw new Error('CLOCK_SAMPLE_INVALID');
    }
    this.clockSample = validateClockSample({ probeId: reply.probeId, sessionEpoch: reply.sessionEpoch, t0: reply.t0,
      clockId: reply.clockId, bootId: reply.bootId, t1: reply.t1, t2: reply.t2, precisionNs: reply.precisionNs,
      desktopClockId: this.desktopClockId, t3: receivedNs });
    clearTimeout(this.probeDeadline);
    this.pendingProbe = null;
  }
  private async event(input: unknown, receivedNs: string): Promise<void> {
    await this.events([input], receivedNs);
  }
  private async events(inputs: unknown[], receivedNs: string): Promise<void> {
    const accepted = inputs.map((input) => {
      const item = this.bridge!.accept(input, {
        sessionEpoch: this.epoch, desktopClockId: this.desktopClockId, receivedNs, sample: this.clockSample,
      });
      if (item.clock.alignment?.status === 'drift' || item.clock.alignment?.status === 'clock-changed') {
        this.clockSample = null;
      }
      return item;
    });
    const fresh = accepted.filter((item) => item.disposition === 'accepted');
    if (fresh.length) {
      try {
        if (this.eventBatch) { await this.journal!.appendBatch(fresh); }
        else { await this.journal!.append(fresh[0]); }
      }
      catch (error) {
        if (error instanceof Error && error.message === 'JOURNAL_LIMIT') {
          await this.publish({ gap: { missingFrom: fresh[0].event.sequence, missingThrough: fresh.at(-1)!.event.sequence } });
        }
        throw error;
      }
      if (this.closed) { return; }
    }
    if (this.closed) { return; }
    const ack = accepted.at(-1)!.ack;
    await this.publish({ ackThrough: ack.ackThrough });
    this.send(ack);
    if (this.clockSync && (!this.clockSample || BigInt(receivedNs) - BigInt(this.clockSample.t3) >= 5000000000n)) {
      // An unanswered probe cannot keep a connection or an old sample alive.
      if (this.pendingProbe && BigInt(receivedNs) - BigInt(this.pendingProbe.t0) >= 10000000000n) {
        throw new Error('CLOCK_SAMPLE_INVALID');
      }
      this.probeClock();
    }
  }
  private send(value: unknown): void {
    if (!this.closed) { this.write(JSON.stringify(this.channel!.seal(value))); }
  }
  private write(text: string): void {
    if (this.socket.readyState !== this.socket.OPEN ||
      this.socket.bufferedAmount + Buffer.byteLength(text) > 512 * 1024) { throw securityError('FRAME_BACKPRESSURE'); }
    this.socket.send(text, (error) => { if (error) { void this.fail('CONNECTION_FAILED'); } });
  }
  private async publish(update: Partial<BridgeStatus>): Promise<void> {
    try { await this.owner.publish(update); }
    catch { throw securityError('STATUS_PERSISTENCE_FAILED'); }
  }
  private reason(error: unknown): string {
    if (error instanceof ProtocolError) { return error.code; }
    const allowed = new Set(['JOURNAL_LIMIT', 'KEY_EXPIRED', 'KEY_ROTATION_REQUIRED', 'FRAME_REPLAY', 'PAIRING_INVALID',
      'FRAME_BACKPRESSURE', 'STATUS_PERSISTENCE_FAILED', 'JOURNAL_CORRUPT', 'JOURNAL_UNSAFE', 'JOURNAL_WRITER_STALE',
      'JOURNAL_RESUME_UNAVAILABLE', 'JOURNAL_EPOCH_LIMIT', 'JOURNAL_BATCH_INVALID', 'RESUME_MISMATCH', 'CLOCK_SAMPLE_INVALID']);
    return error instanceof Error && allowed.has(error.message) ? error.message : 'BRIDGE_REJECTED';
  }
  private async fail(reason: string, gap?: { missingFrom: number; missingThrough: number }): Promise<void> {
    if (this.closed) { return; }
    this.closed = true; this.release();
    this.terminalPublication = this.owner.publish({
      state: reason === 'JOURNAL_LIMIT' ? 'degraded' : reason === 'KEY_EXPIRED' ? 'expired' : 'disconnected', reason,
      ...(gap ? { gap: { missingFrom: gap.missingFrom, missingThrough: gap.missingThrough } } : {}),
    }).catch(() => {});
    try {
      if (this.socket.readyState === this.socket.OPEN && this.socket.bufferedAmount < 512 * 1024) {
        this.socket.send(JSON.stringify({ type: 'error', code: 'BRIDGE_REJECTED' }));
        this.socket.close(1008, 'BRIDGE_REJECTED');
      } else { this.socket.terminate(); }
    } catch { this.socket.terminate(); }
    await this.terminalPublication;
  }
  private async disconnect(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true; this.release();
    this.terminalPublication = this.owner.publish({ state: 'disconnected', reason: 'CONNECTION_CLOSED' }).catch(() => {});
    await this.terminalPublication;
  }
  private release(): void {
    if (this.released) { return; }
    this.released = true;
    clearTimeout(this.timeout);
    clearTimeout(this.expiry);
    clearTimeout(this.probeDeadline);
    this.clockSample = null; this.pendingProbe = null;
    if (this.channel) { this.owner.authority.release(this.channel); }
    this.owner.released(this);
  }
  async close(): Promise<void> {
    this.closed = true; this.release(); this.socket.terminate(); await this.tail; await this.terminalPublication;
  }
}
