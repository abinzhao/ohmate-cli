/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from 'vitest';
import {
  decideAfterDiscard,
  decideExternalStop,
  decideFinalizeAction,
  decideSessionIdentity,
  decideStart,
  decideStartObservation,
  decideStatusSnapshot,
  decideStopEntry,
  decideStopObservation,
  foreignSettleUntil,
  sessionSettleUntil,
  shouldForegroundFinalize,
} from './decisions.js';
import type {
  RecorderRecord,
  RecordingSession,
  RecordingSnapshot,
} from './types.js';

function session(id: number): RecordingSession {
  return {
    fileName: 'devecocli-20260918-110000000-a3f2.mp4',
    abilityRecordId: id,
    startTime: 1789700000000,
    localPath: 'C:\\out\\demo.mp4',
  };
}

function record(id: number, startedAtMs?: number): RecorderRecord {
  return {
    abilityRecordId: id,
    bundleName: 'com.huawei.hmos.screenrecorder',
    abilityName: 'com.huawei.hmos.screenrecorder.ServiceExtAbility',
    startedAtMs,
  };
}

function snapshot(
  status: RecordingSnapshot['status'],
  extra: Partial<RecordingSnapshot> = {}
): RecordingSnapshot {
  return { status, ...extra };
}

describe('decideStart', () => {
  it('rejects when a CLI recording is active', () => {
    const plan = decideStart(
      snapshot('recording', { session: session(27), activeId: 27 })
    );
    expect(plan).toMatchObject({ plan: 'error' });
    if (plan.plan === 'error') {
      expect(plan.error.code).toBe('CLI_RECORDING_ACTIVE');
    }
  });

  it('rejects when a foreign recording is active', () => {
    const plan = decideStart(snapshot('busy', { activeId: 42 }));
    expect(plan).toMatchObject({ plan: 'error' });
    if (plan.plan === 'error') {
      expect(plan.error.code).toBe('EXTERNAL_RECORDING');
    }
  });

  it('discards the old registration when idle with a leftover registration', () => {
    const leftover = session(27);
    expect(decideStart(snapshot('idle', { session: leftover }))).toEqual({
      plan: 'discard-first',
      session: leftover,
    });
  });

  it('starts new when idle without a registration', () => {
    expect(decideStart(snapshot('idle'))).toEqual({ plan: 'start-new' });
  });
});

describe('decideAfterDiscard', () => {
  it('allows a start only for idle without a registration', () => {
    expect(decideAfterDiscard(snapshot('idle'))).toEqual({
      plan: 'start-new',
    });
  });

  it('rejects recording, busy, or another leftover registration', () => {
    for (const snap of [
      snapshot('recording', { session: session(5), activeId: 5 }),
      snapshot('busy', { activeId: 5 }),
      snapshot('idle', { session: session(5) }),
    ]) {
      const plan = decideAfterDiscard(snap);
      expect(plan).toMatchObject({ plan: 'error' });
      if (plan.plan === 'error') {
        expect(plan.error.code).toBe('STATE_CHANGED');
      }
    }
  });
});

describe('decideStopEntry', () => {
  it('rejects a foreign recording without force', () => {
    const plan = decideStopEntry(snapshot('busy', { activeId: 42 }), false);
    expect(plan).toMatchObject({ plan: 'error' });
    if (plan.plan === 'error') {
      expect(plan.error.code).toBe('EXTERNAL_RECORDING');
    }
  });

  it('force-stops a foreign recording with its active ID', () => {
    expect(decideStopEntry(snapshot('busy', { activeId: 42 }), true)).toEqual({
      plan: 'force-stop-external',
      activeId: 42,
    });
  });

  it('rejects an idle stop without a registration', () => {
    for (const force of [false, true]) {
      const plan = decideStopEntry(snapshot('idle'), force);
      expect(plan).toMatchObject({ plan: 'error' });
      if (plan.plan === 'error') {
        expect(plan.error.code).toBe('NO_CLI_SESSION');
      }
    }
  });

  it('finalizes the registered session, live or interrupted', () => {
    const live = session(27);
    expect(
      decideStopEntry(
        snapshot('recording', { session: live, activeId: 27 }),
        false
      )
    ).toEqual({ plan: 'finalize-session', session: live });
    expect(decideStopEntry(snapshot('idle', { session: live }), false)).toEqual(
      {
        plan: 'finalize-session',
        session: live,
      }
    );
  });
});

describe('decideSessionIdentity', () => {
  it('proceeds while the stored session is the expected one', () => {
    const expected = session(27);
    expect(
      decideSessionIdentity(expected, expected, 'stop-or-recover')
    ).toEqual({ plan: 'proceed' });
  });

  it('silences the interactive foreground when the session changed', () => {
    expect(
      decideSessionIdentity(undefined, session(27), 'interactive')
    ).toEqual({ plan: 'completed-elsewhere' });
    expect(
      decideSessionIdentity(session(99), session(27), 'interactive')
    ).toEqual({ plan: 'completed-elsewhere' });
  });

  it('rejects standalone mode when the session changed', () => {
    const plan = decideSessionIdentity(
      session(99),
      session(27),
      'stop-or-recover'
    );
    expect(plan).toMatchObject({
      plan: 'error',
      error: { code: 'SESSION_CHANGED' },
    });
  });
});

describe('decideFinalizeAction', () => {
  it('rejects a foreign recording', () => {
    const plan = decideFinalizeAction(snapshot('busy', { activeId: 8 }));
    expect(plan).toMatchObject({
      plan: 'error',
      error: { code: 'EXTERNAL_RECORDING' },
    });
  });

  it('stops a live session', () => {
    expect(
      decideFinalizeAction(
        snapshot('recording', {
          session: session(27),
          activeId: 27,
        })
      )
    ).toEqual({ plan: 'stop-recording' });
  });

  it('retrieves without toggling when idle', () => {
    expect(decideFinalizeAction(snapshot('idle'))).toEqual({
      plan: 'retrieve',
    });
  });
});

describe('decideStopObservation', () => {
  it('reports gone with no records', () => {
    expect(decideStopObservation([], 27)).toEqual({ outcome: 'gone' });
  });

  it('keeps waiting while the expected ID is the unique record', () => {
    expect(decideStopObservation([record(27)], 27)).toEqual({
      outcome: 'still-recording',
      activeId: 27,
    });
  });

  it('rejects a replaced ID or multiple records', () => {
    const replaced = decideStopObservation([record(31)], 27);
    expect(replaced).toMatchObject({ outcome: 'error' });
    if (replaced.outcome === 'error') {
      expect(replaced.error.code).toBe('STATE_CHANGED');
      expect(replaced.error.message).toContain('31');
    }
    const multiple = decideStopObservation([record(27), record(31)], 27);
    expect(multiple).toMatchObject({ outcome: 'error' });
    if (multiple.outcome === 'error') {
      expect(multiple.error.code).toBe('STATE_CHANGED');
    }
  });
});

describe('decideStartObservation', () => {
  it('is pending with no records', () => {
    expect(decideStartObservation([])).toEqual({ outcome: 'pending' });
  });

  it('confirms the unique record', () => {
    expect(decideStartObservation([record(27)])).toEqual({
      outcome: 'confirmed',
      record: record(27),
    });
  });

  it('rejects multiple records as ambiguous', () => {
    const observation = decideStartObservation([record(27), record(31)]);
    expect(observation).toMatchObject({ outcome: 'error' });
    if (observation.outcome === 'error') {
      expect(observation.error.code).toBe('AMBIGUOUS_DEVICE_STATE');
    }
  });
});

describe('decideExternalStop', () => {
  it('treats no records as already stopped', () => {
    expect(decideExternalStop([], 42)).toEqual({ plan: 'already-stopped' });
  });

  it('stops the current recording, passing the uptime start time', () => {
    expect(decideExternalStop([record(42, 12345)], 42)).toEqual({
      plan: 'stop',
      currentId: 42,
      startedAtMs: 12345,
    });
    expect(decideExternalStop([record(42, 12345)], undefined)).toEqual({
      plan: 'stop',
      currentId: 42,
      startedAtMs: 12345,
    });
  });

  it('rejects a replaced ID or multiple records', () => {
    const replaced = decideExternalStop([record(43)], 42);
    expect(replaced).toMatchObject({ plan: 'error' });
    if (replaced.plan === 'error') {
      expect(replaced.error.code).toBe('STATE_CHANGED');
    }
    const multiple = decideExternalStop([record(42), record(43)], 42);
    expect(multiple).toMatchObject({ plan: 'error' });
    if (multiple.plan === 'error') {
      expect(multiple.error.code).toBe('AMBIGUOUS_DEVICE_STATE');
    }
  });
});

describe('decideStatusSnapshot', () => {
  it('maps recording and busy directly', () => {
    expect(
      decideStatusSnapshot(
        snapshot('recording', { session: session(27), activeId: 27 })
      )
    ).toEqual({ status: 'recording' });
    expect(decideStatusSnapshot(snapshot('busy', { activeId: 9 }))).toEqual({
      status: 'busy',
    });
  });

  it('maps idle with and without an interrupted registration', () => {
    expect(decideStatusSnapshot(snapshot('idle'))).toEqual({ status: 'idle' });
    expect(
      decideStatusSnapshot(snapshot('idle', { session: session(27) }))
    ).toEqual({
      status: 'idle',
      note: 'interrupted session found; retrievable via ui screenrecord stop',
    });
  });
});

describe('shouldForegroundFinalize', () => {
  it('keeps waiting while the started session is still recording', () => {
    const started = session(27);
    expect(
      shouldForegroundFinalize(
        snapshot('recording', { session: started, activeId: 27 }),
        started
      )
    ).toBe(false);
  });

  it('finalizes when the session changed or the recording ended', () => {
    const started = session(27);
    expect(
      shouldForegroundFinalize(snapshot('idle', { session: started }), started)
    ).toBe(true);
    expect(
      shouldForegroundFinalize(
        snapshot('recording', { session: session(99), activeId: 99 }),
        started
      )
    ).toBe(true);
    expect(shouldForegroundFinalize(snapshot('idle'), started)).toBe(true);
  });
});

describe('settle deadlines', () => {
  it('derives the own-session settle deadline from the registered start time', () => {
    expect(sessionSettleUntil(session(27), 3_000)).toBe(1789700003000);
  });

  it('derives the foreign settle deadline from the device-side age', () => {
    // 新鲜录屏等待全部预算;已就绪的录屏不等待;负年龄(时钟偏差)多等待。
    expect(foreignSettleUntil(0, 3_000, 100_000)).toBe(103_000);
    expect(foreignSettleUntil(3_000, 3_000, 100_000)).toBe(100_000);
    expect(foreignSettleUntil(9_000, 3_000, 100_000)).toBe(100_000);
    expect(foreignSettleUntil(-500, 3_000, 100_000)).toBe(103_500);
  });
});
