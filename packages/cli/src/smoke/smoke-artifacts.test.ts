/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_RETENTION_MS,
  RUN_STALE_MS,
  isRunReclaimable,
  isSmokeArtifact,
  isSmokeRunDir,
  parseRunMarker,
  smokeCrashLogName,
  smokeRunDirName,
  smokeScreenshotName,
} from './smoke-artifacts.js';

describe('smoke-artifacts', () => {
  it('generates screenshot and crash log names', () => {
    expect(smokeScreenshotName(1725555555555)).toBe(
      'smoke-screenshot-1725555555555.png'
    );
    expect(smokeCrashLogName(1725555555555)).toBe(
      'smoke-crash-1725555555555.log'
    );
  });

  it('recognizes generated names as smoke artifacts', () => {
    expect(isSmokeArtifact(smokeScreenshotName(1))).toBe(true);
    expect(isSmokeArtifact(smokeCrashLogName(1))).toBe(true);
  });

  it('rejects non-smoke files (retention must never touch them)', () => {
    const names = [
      'changes.txt',
      'hotreload-watch.log',
      'buildConfig.json',
      'smoke-screenshot-1.log',
      'smoke-crash-1.png',
      'foo-smoke-screenshot-1.png',
      'smoke-screenshot-1.png.bak',
      'Smoke-Screenshot-1.png',
      'smoke-screenshot-no-digit.png',
    ];
    for (const name of names) {
      expect(isSmokeArtifact(name)).toBe(false);
    }
  });

  it('generates and recognizes run dir names', () => {
    const name = smokeRunDirName(1725555555555, 4321, 'a1b2');
    expect(name).toBe('run-1725555555555-4321-a1b2');
    expect(isSmokeRunDir(name)).toBe(true);
  });

  it('rejects non-run entries as run dirs', () => {
    for (const name of [
      'smoke',
      'run-1725555555555-4321', // no nonce
      'run-1725555555555-4321-ZZZZ', // non-hex nonce
      'run-1725555555555-4321-a1b2-c3', // extra segment
      'xrun-1725555555555-4321-a1b2',
      'run--4321-a1b2',
    ]) {
      expect(isSmokeRunDir(name)).toBe(false);
    }
  });

  it('parses RUNNING and ENDED markers; malformed content yields null', () => {
    expect(parseRunMarker('{"pid":4321,"startedAt":1725555555555}')).toEqual({
      pid: 4321,
      startedAt: 1725555555555,
    });
    expect(
      parseRunMarker(
        '{"pid":4321,"startedAt":1725555555555,"endedAt":1725555559999}'
      )
    ).toEqual({
      pid: 4321,
      startedAt: 1725555555555,
      endedAt: 1725555559999,
    });
    // non-number endedAt is dropped (marker stays RUNNING-shaped)
    expect(parseRunMarker('{"pid":4321,"startedAt":1,"endedAt":"x"}')).toEqual({
      pid: 4321,
      startedAt: 1,
    });
    for (const raw of [
      '',
      'not json',
      '{"pid":"x","startedAt":1}',
      '{}',
      'null',
    ]) {
      expect(parseRunMarker(raw)).toBeNull();
    }
  });
});

describe('isRunReclaimable (in-flight runs and fresh evidence are protected)', () => {
  const now = 1_000_000_000_000;

  it('no marker → reclaimable (legacy or corrupt dir)', () => {
    expect(isRunReclaimable(null, null, { now, isPidAlive: () => true })).toBe(
      true
    );
  });

  it('running + live owner → NOT reclaimable (in-flight run)', () => {
    expect(
      isRunReclaimable(
        'running',
        { pid: 4321, startedAt: now - 5_000 },
        { now, isPidAlive: () => true }
      )
    ).toBe(false);
  });

  it('running + dead owner pid → reclaimable (crashed run)', () => {
    expect(
      isRunReclaimable(
        'running',
        { pid: 4321, startedAt: now - 5_000 },
        { now, isPidAlive: () => false }
      )
    ).toBe(true);
  });

  it('running + marker past the stale threshold → reclaimable (stuck run / recycled pid)', () => {
    expect(
      isRunReclaimable(
        'running',
        { pid: 4321, startedAt: now - RUN_STALE_MS },
        { now, isPidAlive: () => true }
      )
    ).toBe(true);
  });

  it('running + corrupt marker → reclaimable', () => {
    expect(
      isRunReclaimable('running', null, { now, isPidAlive: () => true })
    ).toBe(true);
    expect(
      isRunReclaimable(
        'running',
        { pid: 0, startedAt: now },
        { now, isPidAlive: () => true }
      )
    ).toBe(true);
  });

  it('ended within the retention window → NOT reclaimable (agent read guarantee)', () => {
    expect(
      isRunReclaimable(
        'ended',
        { pid: 4321, startedAt: now - 6_000, endedAt: now - 5_000 },
        { now, isPidAlive: () => false } // dead owner: evidence still has its window
      )
    ).toBe(false);
    expect(
      isRunReclaimable(
        'ended',
        {
          pid: 4321,
          startedAt: now - EVIDENCE_RETENTION_MS,
          endedAt: now - EVIDENCE_RETENTION_MS + 1,
        },
        { now, isPidAlive: () => true }
      )
    ).toBe(false); // 1ms inside the window
  });

  it('ended past the retention window → reclaimable (first run after 24h)', () => {
    expect(
      isRunReclaimable(
        'ended',
        {
          pid: 4321,
          startedAt: now - EVIDENCE_RETENTION_MS,
          endedAt: now - EVIDENCE_RETENTION_MS,
        },
        { now, isPidAlive: () => true }
      )
    ).toBe(true); // exactly at the boundary
    expect(
      isRunReclaimable(
        'ended',
        { pid: 4321, startedAt: 0, endedAt: now - EVIDENCE_RETENTION_MS - 1 },
        { now, isPidAlive: () => true }
      )
    ).toBe(true);
  });

  it('ended with corrupt marker (no endedAt) → reclaimable', () => {
    expect(
      isRunReclaimable(
        'ended',
        { pid: 4321, startedAt: now },
        { now, isPidAlive: () => true }
      )
    ).toBe(true);
    expect(
      isRunReclaimable('ended', null, { now, isPidAlive: () => true })
    ).toBe(true);
  });
});
