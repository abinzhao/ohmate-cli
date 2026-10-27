/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { hashContract } from './canonical-hash.js';
import type { EventEnvelope } from './envelopes.js';
import type { ClockSegment } from './clock-segments.js';
import { ProtocolError } from './protocol-error.js';

interface RetainedEvent {
  digest: string;
  messageId: string;
  clock: ClockSegment;
}

export function eventDigest(event: EventEnvelope): string {
  // Epoch changes on reconnect; the immutable recorder event must not change.
  return hashContract(
    Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'sessionEpoch')
    )
  );
}

export function sequenceGap(
  expected: number,
  received: number,
  missingFrom: number,
  missingThrough: number
): ProtocolError {
  return new ProtocolError('SEQUENCE_GAP', {
    expected,
    received,
    missingFrom,
    missingThrough,
  });
}

export class RetainedWindow {
  private readonly events = new Map<number, RetainedEvent>();
  private readonly messageIds = new Map<string, number>();

  constructor(private readonly capacity: number) {}

  firstSequence(): number | null {
    return this.events.keys().next().value ?? null;
  }

  check(
    event: EventEnvelope,
    ackThrough: number,
    lastSequence: number
  ): RetainedEvent | undefined {
    const remembered = this.events.get(event.sequence);
    const priorSequence = this.messageIds.get(event.messageId);
    if (
      priorSequence !== undefined &&
      (priorSequence !== event.sequence ||
        remembered?.digest !== eventDigest(event))
    ) {
      throw new ProtocolError('MESSAGE_ID_CONFLICT');
    }
    if (remembered && remembered.messageId !== event.messageId) {
      throw new ProtocolError('SEQUENCE_CONFLICT');
    }
    if (event.sequence <= lastSequence && !remembered) {
      throw new ProtocolError('REPLAY_OUTSIDE_WINDOW', {
        expected: ackThrough + 1,
        received: event.sequence,
        missingFrom: event.sequence,
        missingThrough: (this.firstSequence() ?? lastSequence + 1) - 1,
      });
    }
    if (event.sequence > ackThrough + 1) {
      throw sequenceGap(
        ackThrough + 1,
        event.sequence,
        ackThrough + 1,
        event.sequence - 1
      );
    }
    return remembered;
  }

  remember(event: EventEnvelope, clock: ClockSegment): void {
    this.rememberDigest(event, eventDigest(event), clock);
  }

  rememberDigest(event: EventEnvelope, digest: string, clock: ClockSegment): void {
    if (this.messageIds.has(event.messageId)) {
      throw new ProtocolError('MESSAGE_ID_CONFLICT');
    }
    this.events.set(event.sequence, {
      digest,
      messageId: event.messageId,
      clock,
    });
    this.messageIds.set(event.messageId, event.sequence);
    const oldest = this.firstSequence();
    if (this.events.size > this.capacity && oldest !== null) {
      this.messageIds.delete(this.events.get(oldest)!.messageId);
      this.events.delete(oldest);
    }
  }

  assertResume(resumeFrom: number, lastSequence: number): void {
    const oldest = this.firstSequence() ?? lastSequence + 1;
    if (resumeFrom < oldest) {
      throw sequenceGap(oldest, resumeFrom, resumeFrom, oldest - 1);
    }
    if (resumeFrom > lastSequence + 1) {
      throw sequenceGap(
        lastSequence + 1,
        resumeFrom,
        lastSequence + 1,
        resumeFrom - 1
      );
    }
  }

  clear(): void {
    this.events.clear();
    this.messageIds.clear();
  }

  retireThrough(sequence: number): void {
    for (const [index, record] of this.events) {
      if (index > sequence) { break; }
      this.messageIds.delete(record.messageId);
      this.events.delete(index);
    }
  }
}
