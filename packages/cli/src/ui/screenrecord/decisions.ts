/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { sameSession } from './session-identity.js';
import {
  ScreenRecordError,
  type RecorderRecord,
  type RecordingSession,
  type RecordingSnapshot,
  type RecordingStatus,
} from './types.js';

/** Finalize mode: interactive foreground or standalone stop/recover. */
export type FinalizeMode = 'interactive' | 'stop-or-recover';

interface ErrorPlan {
  plan: 'error';
  error: ScreenRecordError;
}

export type StartPlan =
  | { plan: 'start-new' }
  | { plan: 'discard-first'; session: RecordingSession }
  | ErrorPlan;

/** Start precheck from a classified snapshot: start, discard the old registration, or reject. */
export function decideStart(snapshot: RecordingSnapshot): StartPlan {
  if (snapshot.status === 'recording') {
    return {
      plan: 'error',
      error: new ScreenRecordError(
        'CLI_RECORDING_ACTIVE',
        'A CLI recording session is already running; run stop first'
      ),
    };
  }
  if (snapshot.status === 'busy') {
    return {
      plan: 'error',
      error: new ScreenRecordError(
        'EXTERNAL_RECORDING',
        'A recording not started by this CLI is in progress; run stop --force first'
      ),
    };
  }
  if (snapshot.session) {
    return { plan: 'discard-first', session: snapshot.session };
  }
  return { plan: 'start-new' };
}

export type AfterDiscardPlan = { plan: 'start-new' } | ErrorPlan;

/** After discarding an interrupted registration, only idle without a session may start. */
export function decideAfterDiscard(
  snapshot: RecordingSnapshot
): AfterDiscardPlan {
  if (snapshot.status === 'idle' && !snapshot.session) {
    return { plan: 'start-new' };
  }
  return {
    plan: 'error',
    error: new ScreenRecordError(
      'STATE_CHANGED',
      'Device state changed while discarding the interrupted registration; not starting'
    ),
  };
}

export type StopEntryPlan =
  | { plan: 'force-stop-external'; activeId?: number }
  | { plan: 'finalize-session'; session: RecordingSession }
  | ErrorPlan;

/** Stop entry classification: foreign recordings need force, idle needs a session. */
export function decideStopEntry(
  snapshot: RecordingSnapshot,
  force: boolean
): StopEntryPlan {
  if (snapshot.status === 'busy') {
    if (!force) {
      return {
        plan: 'error',
        error: new ScreenRecordError(
          'EXTERNAL_RECORDING',
          'Recording was not started by this CLI. Stop it on the device or run stop --force.'
        ),
      };
    }
    return { plan: 'force-stop-external', activeId: snapshot.activeId };
  }
  if (!snapshot.session) {
    return {
      plan: 'error',
      error: new ScreenRecordError(
        'NO_CLI_SESSION',
        'No CLI recording session on this device'
      ),
    };
  }
  return { plan: 'finalize-session', session: snapshot.session };
}

export type SessionIdentityPlan =
  | { plan: 'proceed' }
  | { plan: 'completed-elsewhere' }
  | ErrorPlan;

/** Before finalizing, the stored session must still be the expected one. */
export function decideSessionIdentity(
  current: RecordingSession | undefined,
  expected: RecordingSession,
  mode: FinalizeMode
): SessionIdentityPlan {
  if (sameSession(current, expected)) {
    return { plan: 'proceed' };
  }
  if (mode === 'interactive') {
    return { plan: 'completed-elsewhere' };
  }
  return {
    plan: 'error',
    error: new ScreenRecordError(
      'SESSION_CHANGED',
      'The recording session changed; leaving the current one untouched'
    ),
  };
}

export type FinalizeActionPlan =
  | { plan: 'stop-recording' }
  | { plan: 'retrieve' }
  | ErrorPlan;

/** Locked-finalize action: stop a live session, retrieve when idle. */
export function decideFinalizeAction(
  snapshot: RecordingSnapshot
): FinalizeActionPlan {
  if (snapshot.status === 'busy') {
    return {
      plan: 'error',
      error: new ScreenRecordError(
        'EXTERNAL_RECORDING',
        'A recording not started by this CLI is in progress; not toggling'
      ),
    };
  }
  if (snapshot.status === 'recording') {
    return { plan: 'stop-recording' };
  }
  return { plan: 'retrieve' };
}

export type StopObservation =
  | { outcome: 'gone' }
  | { outcome: 'still-recording'; activeId: number }
  | { outcome: 'error'; error: ScreenRecordError };

/** One observation while confirming a stop: the unique record must be the expected one. */
export function decideStopObservation(
  records: RecorderRecord[],
  expectedId: number
): StopObservation {
  if (records.length === 0) {
    return { outcome: 'gone' };
  }
  if (records.length > 1) {
    return {
      outcome: 'error',
      error: new ScreenRecordError(
        'STATE_CHANGED',
        'Multiple recorder records while confirming stop; not toggling again'
      ),
    };
  }
  const activeId = records[0].abilityRecordId;
  if (activeId !== expectedId) {
    return {
      outcome: 'error',
      error: new ScreenRecordError(
        'STATE_CHANGED',
        `A different recording (ID ${activeId}) appeared while stopping; leaving it alone`
      ),
    };
  }
  return { outcome: 'still-recording', activeId };
}

export type StartObservation =
  | { outcome: 'pending' }
  | { outcome: 'confirmed'; record: RecorderRecord }
  | { outcome: 'error'; error: ScreenRecordError };

/** One observation while confirming a start. */
export function decideStartObservation(
  records: RecorderRecord[]
): StartObservation {
  if (records.length === 1) {
    return { outcome: 'confirmed', record: records[0] };
  }
  if (records.length > 1) {
    return {
      outcome: 'error',
      error: new ScreenRecordError(
        'AMBIGUOUS_DEVICE_STATE',
        'Multiple recorder records after start; refusing to pick one'
      ),
    };
  }
  return { outcome: 'pending' };
}

export type ExternalStopPlan =
  | { plan: 'already-stopped' }
  | { plan: 'stop'; currentId: number; startedAtMs?: number }
  | ErrorPlan;

/** Precheck before force-stopping a foreign recording. */
export function decideExternalStop(
  records: RecorderRecord[],
  activeId: number | undefined
): ExternalStopPlan {
  if (records.length === 0) {
    return { plan: 'already-stopped' };
  }
  if (records.length > 1) {
    return {
      plan: 'error',
      error: new ScreenRecordError(
        'AMBIGUOUS_DEVICE_STATE',
        'Multiple recorder records; refusing to force-stop'
      ),
    };
  }
  const record = records[0];
  if (activeId !== undefined && record.abilityRecordId !== activeId) {
    return {
      plan: 'error',
      error: new ScreenRecordError(
        'STATE_CHANGED',
        'The recording changed while stopping; leaving it alone'
      ),
    };
  }
  return {
    plan: 'stop',
    currentId: record.abilityRecordId,
    startedAtMs: record.startedAtMs,
  };
}

/** Public status mapping: idle with a leftover registration carries a note. */
export function decideStatusSnapshot(
  snapshot: RecordingSnapshot
): RecordingStatus {
  if (snapshot.status === 'idle' && snapshot.session) {
    return {
      status: 'idle',
      note: 'interrupted session found; retrievable via ui screenrecord stop',
    };
  }
  return { status: snapshot.status };
}

/** The foreground wait exits when the session changed or the recording ended. */
export function shouldForegroundFinalize(
  snapshot: RecordingSnapshot,
  started: RecordingSession
): boolean {
  return (
    !sameSession(snapshot.session, started) || snapshot.status !== 'recording'
  );
}

/** Settle deadline for an own session: registration start time plus the budget. */
export function sessionSettleUntil(
  session: RecordingSession,
  stopReadyMs: number
): number {
  return session.startTime + stopReadyMs;
}

/** Settle deadline for a foreign recording: remaining wait from its device-side age. */
export function foreignSettleUntil(
  ageMs: number,
  stopReadyMs: number,
  now: number
): number {
  return now + Math.max(0, stopReadyMs - ageMs);
}
