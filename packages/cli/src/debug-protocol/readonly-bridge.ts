/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { IdentifierSchema, IdentitySchema } from './domain-schemas.js';
import type { Identity } from './domain-schemas.js';
import {
  AckSchema,
  ClockSchema,
  EventEnvelopeSchema,
  ResumeSchema,
} from './envelopes.js';
import type { Ack, EventEnvelope } from './envelopes.js';
import {
  assertIdentity,
  HandshakeSchema,
  negotiateReadonly,
} from './handshake.js';
import type { Handshake, NegotiatedReadonly } from './handshake.js';
import { advanceClock, assertClockBudget } from './clock-segments.js';
import type { ClockSegment } from './clock-segments.js';
import type { ClockObservation } from './clock-calibration.js';
import { hashContract } from './canonical-hash.js';
import { parseProtocol, ProtocolError } from './protocol-error.js';
import { RetainedWindow } from './retained-window.js';
import { CommittedHistory, assertReadonlyEventScope, type CommittedHistoryAnchor } from './committed-history.js';

export type BridgeState =
  | 'disconnected'
  | 'connected'
  | 'suspended'
  | 'revoked'
  | 'expired';
export interface BridgeOptions {
  clockUncertaintyBudgetMs?: number;
}
export interface AcceptedEvent {
  disposition: 'accepted' | 'duplicate' | 'replay';
  ack: Ack;
  event: EventEnvelope;
  clock: ClockSegment;
}
export interface CommittedEvent {
  event: EventEnvelope;
  clock: ClockSegment;
  digest: string;
}
export interface BridgeStatus {
  state: BridgeState;
  sessionEpoch: string | null;
  ackThrough: number;
  lastSequence: number;
  retainedFrom: number | null;
}

function decodeEvent(input: unknown, maxFrame: number): EventEnvelope {
  let decoded = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > maxFrame) {
      throw new ProtocolError('FRAME_TOO_LARGE');
    }
    try {
      decoded = JSON.parse(input);
    } catch {
      throw new ProtocolError('INVALID_SCHEMA');
    }
  }
  const event = parseProtocol(EventEnvelopeSchema, decoded);
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > maxFrame) {
    throw new ProtocolError('FRAME_TOO_LARGE');
  }
  return event;
}

function eventIdentity(event: Identity) {
  return Object.fromEntries(
    Object.keys(IdentitySchema.shape).map((key) => [
      key,
      event[key as keyof Identity],
    ])
  );
}

function eventClock(event: EventEnvelope) {
  return Object.fromEntries(
    Object.keys(ClockSchema.shape).map((key) => [
      key,
      event[key as keyof EventEnvelope],
    ])
  );
}

export class ReadonlyBridge {
  private readonly local: Handshake;
  private readonly clockBudget: number;
  private state: BridgeState = 'disconnected';
  private sessionEpoch: string | null = null;
  private readonly usedEpochs = new Set<string>();
  private negotiation: NegotiatedReadonly | null = null;
  private window: RetainedWindow | null = null;
  private ackThrough = 0;
  private lastSequence = 0;
  private clock: ClockSegment | null = null;

  constructor(local: unknown, options: BridgeOptions = {}) {
    this.local = parseProtocol(HandshakeSchema, local);
    this.clockBudget = options.clockUncertaintyBudgetMs ?? 10;
    assertClockBudget(this.clockBudget);
  }

  connect(peer: unknown, epoch: string): NegotiatedReadonly {
    this.assertState('disconnected');
    if (this.sessionEpoch !== null) {
      throw new ProtocolError('INVALID_STATE');
    }
    const sessionEpoch = parseProtocol(IdentifierSchema, epoch);
    const negotiated = negotiateReadonly(this.local, peer);
    this.negotiation = negotiated;
    this.window = new RetainedWindow(negotiated.resumeWindow);
    this.activate(sessionEpoch);
    return structuredClone(negotiated);
  }

  // Restores only recorder evidence. No transport keys or authentication are restored.
  restoreCommitted(peer: unknown, epochs: string[], records: CommittedEvent[], anchor?: CommittedHistoryAnchor): void {
    this.assertState('disconnected');
    if (this.sessionEpoch !== null) { throw new ProtocolError('INVALID_STATE'); }
    const history = new CommittedHistory(this.local, peer, epochs, this.clockBudget, anchor);
    for (const record of records) { history.append(record); }
    this.negotiation = history.negotiated; this.window = history.window; this.clock = history.clock;
    this.lastSequence = history.sequence; this.ackThrough = history.sequence;
    this.sessionEpoch = epochs.at(-1)!;
    for (const epoch of epochs) { this.usedEpochs.add(epoch); }
  }

  accept(input: unknown, observation?: ClockObservation): AcceptedEvent {
    this.assertState('connected');
    const negotiated = this.negotiation!;
    const event = decodeEvent(input, negotiated.maxFrame);
    this.assertEventScope(event, negotiated);
    if (observation && observation.sessionEpoch !== event.sessionEpoch) { throw new ProtocolError('EPOCH_MISMATCH'); }
    const remembered = this.window!.check(
      event,
      this.ackThrough,
      this.lastSequence
    );
    const disposition =
      event.sequence <= this.ackThrough
        ? 'duplicate'
        : remembered
          ? 'replay'
          : 'accepted';
    const clock =
      remembered?.clock ??
      advanceClock(this.clock, eventClock(event), this.clockBudget, observation);
    if (!remembered) {
      this.window!.remember(event, clock);
      this.clock = clock;
      this.lastSequence = event.sequence;
    }
    this.ackThrough = Math.max(this.ackThrough, event.sequence);
    return { disposition, ack: this.ack(), event, clock: structuredClone(clock) };
  }

  resume(
    peer: unknown,
    input: unknown
  ): { negotiated: NegotiatedReadonly; ack: Ack } {
    this.assertState('disconnected', 'suspended');
    if (!this.negotiation || !this.window) {
      throw new ProtocolError('INVALID_STATE');
    }
    const request = parseProtocol(ResumeSchema, input);
    const identity = parseProtocol(IdentitySchema, eventIdentity(request));
    assertIdentity(this.local.identity, identity);
    if (request.previousEpoch !== this.sessionEpoch) {
      throw new ProtocolError('EPOCH_MISMATCH');
    }
    if (this.usedEpochs.has(request.sessionEpoch)) {
      throw new ProtocolError('EPOCH_REUSED');
    }
    if (request.protocolVersion !== this.negotiation.protocolVersion) {
      throw new ProtocolError('VERSION_MISMATCH');
    }
    const negotiated = negotiateReadonly(this.local, peer);
    if (hashContract(negotiated) !== hashContract(this.negotiation)) {
      throw new ProtocolError('RESUME_MISMATCH');
    }
    this.window.assertResume(request.resumeFrom, this.lastSequence);
    this.ackThrough = request.resumeFrom - 1;
    this.activate(request.sessionEpoch);
    return { negotiated: structuredClone(negotiated), ack: this.ack() };
  }

  suspend(): void {
    this.assertState('connected');
    this.state = 'suspended';
  }

  disconnect(): void {
    this.assertState('connected', 'suspended');
    this.state = 'disconnected';
  }

  revoke(): void {
    this.terminate('revoked');
  }

  expire(): void {
    this.terminate('expired');
  }

  status(): BridgeStatus {
    return {
      state: this.state,
      sessionEpoch: this.sessionEpoch,
      ackThrough: this.ackThrough,
      lastSequence: this.lastSequence,
      retainedFrom: this.window?.firstSequence() ?? null,
    };
  }

  private assertEventScope(
    event: EventEnvelope,
    negotiated: NegotiatedReadonly,
    epoch = this.sessionEpoch
  ): void {
    assertReadonlyEventScope(event, negotiated, epoch);
  }

  private ack(): Ack {
    return parseProtocol(AckSchema, {
      ...this.local.identity,
      type: 'ack',
      protocolVersion: this.negotiation!.protocolVersion,
      sessionEpoch: this.sessionEpoch,
      ackThrough: this.ackThrough,
    });
  }

  private activate(epoch: string): void {
    this.sessionEpoch = epoch;
    this.usedEpochs.add(epoch);
    this.state = 'connected';
  }

  private assertState(...states: BridgeState[]): void {
    if (!states.includes(this.state)) {
      throw new ProtocolError('INVALID_STATE');
    }
  }

  private terminate(state: 'revoked' | 'expired'): void {
    this.assertState('connected', 'disconnected', 'suspended');
    this.state = state;
    this.window?.clear();
    this.clock = null;
  }
}

export function createReadonlyBridge(
  local: unknown,
  options: BridgeOptions = {}
): ReadonlyBridge {
  return new ReadonlyBridge(local, options);
}
