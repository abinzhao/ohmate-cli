/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { HashSchema, IdentifierSchema, IdentitySchema } from './domain-schemas.js';
import { ClockSchema, EventEnvelopeSchema, type EventEnvelope } from './envelopes.js';
import { assertIdentity, negotiateReadonly, type Handshake, type NegotiatedReadonly } from './handshake.js';
import { advanceClock, ClockSegmentSchema, type ClockSegment } from './clock-segments.js';
import { alignClock } from './clock-calibration.js';
import { hashContract } from './canonical-hash.js';
import { parseProtocol, ProtocolError } from './protocol-error.js';
import { RetainedWindow } from './retained-window.js';
import type { CommittedEvent } from './readonly-bridge.js';

export interface CommittedHistoryAnchor {
  sequence: number;
  sessionEpoch: string;
  clock: ClockSegment;
}

export function validateCommittedAnchor(anchor: CommittedHistoryAnchor, epochs: string[], clockBudget = 10) {
  const clock = parseProtocol(ClockSegmentSchema, structuredClone(anchor.clock));
  const epochIndex = epochs.indexOf(anchor.sessionEpoch);
  if (!Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1 || epochIndex < 0 ||
    clock.segment > anchor.sequence || (clock.reason === 'initial') !== (anchor.sequence === 1)) {
    throw new ProtocolError('RESUME_MISMATCH');
  }
  const observation = clock.alignment?.observation;
  if (observation && (observation.sessionEpoch !== anchor.sessionEpoch ||
    hashContract(alignClock(clock, observation, clockBudget)) !== hashContract(clock.alignment))) {
    throw new ProtocolError('RESUME_MISMATCH');
  }
  if (clock.mergeable !== (clock.alignment?.mergeable ?? clock.offsetUncertaintyMs <= clockBudget)) {
    throw new ProtocolError('RESUME_MISMATCH');
  }
  return { clock, epochIndex };
}

export function assertReadonlyEventScope(event: EventEnvelope, negotiated: NegotiatedReadonly, epoch: string | null): void {
  const identity = Object.fromEntries(Object.keys(IdentitySchema.shape).map((key) => [
    key, event[key as keyof EventEnvelope],
  ]));
  assertIdentity(negotiated.identity, parseProtocol(IdentitySchema, identity));
  if (event.sessionEpoch !== epoch) { throw new ProtocolError('EPOCH_MISMATCH'); }
  if (event.protocolVersion !== negotiated.protocolVersion) { throw new ProtocolError('VERSION_MISMATCH'); }
  if (!negotiated.channels.some((offer) => offer.channel === event.channel &&
    offer.channelVersion === event.channelVersion && offer.capability === event.capability)) {
    throw new ProtocolError('CHANNEL_MISMATCH');
  }
}

// Recorder validation holds no channel, transport keys or authenticated connection state.
export class CommittedHistory {
  readonly negotiated: NegotiatedReadonly;
  readonly window: RetainedWindow;
  clock: ClockSegment | null = null;
  sequence = 0;
  private epochIndex = 0;
  private readonly epochs: string[];
  constructor(local: Handshake, peer: unknown, epochs: string[], private readonly clockBudget = 10,
    anchor?: CommittedHistoryAnchor) {
    if (!epochs.length || new Set(epochs).size !== epochs.length) { throw new ProtocolError('INVALID_STATE'); }
    this.epochs = epochs.map((epoch) => parseProtocol(IdentifierSchema, epoch));
    this.negotiated = negotiateReadonly(local, peer);
    this.window = new RetainedWindow(this.negotiated.resumeWindow);
    if (anchor) {
      const { clock, epochIndex } = validateCommittedAnchor(anchor, this.epochs, clockBudget);
      this.clock = clock; this.sequence = anchor.sequence; this.epochIndex = epochIndex;
    }
  }
  append(record: CommittedEvent): void {
    const event = parseProtocol(EventEnvelopeSchema, record.event);
    const currentEpoch = this.epochs.indexOf(event.sessionEpoch);
    if (event.sequence !== this.sequence + 1 || currentEpoch < this.epochIndex) {
      throw new ProtocolError('RESUME_MISMATCH');
    }
    assertReadonlyEventScope(event, this.negotiated, event.sessionEpoch);
    const observation = record.clock.alignment?.observation;
    if (observation && observation.sessionEpoch !== event.sessionEpoch) { throw new ProtocolError('RESUME_MISMATCH'); }
    const clock = Object.fromEntries(Object.keys(ClockSchema.shape).map((key) => [key, event[key as keyof EventEnvelope]]));
    const next = advanceClock(this.clock, clock, this.clockBudget, observation);
    if (hashContract(next) !== hashContract(record.clock)) { throw new ProtocolError('RESUME_MISMATCH'); }
    this.window.rememberDigest(event, parseProtocol(HashSchema, record.digest), next);
    this.clock = next; this.epochIndex = currentEpoch; this.sequence = event.sequence;
  }
}
