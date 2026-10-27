/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAILED_MAX_AGE_MS,
  PENDING_STALE_MS,
  RETRY_INTERVAL_MS,
  UPLOAD_INTERVAL_MS,
  hasPendingUploadWork,
  isOrphanPendingName,
  isStalePending,
  isUploadDue,
  orphanTargetName,
  writeUploadState,
} from './upload-state.js';

const NOW = Date.parse('2026-09-21T12:00:00');

/** 写一个 mtime 为 NOW - ageMs 的打点文件。 */
function writeWithAge(dir: string, name: string, ageMs: number): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x\n', 'utf8');
  const mtime = new Date(NOW - ageMs);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

/** NOW - offsetMs 对应的 `YYYY-MM-DD`（本地时区，与 parseFailedFileDate 一致）。 */
function dateString(offsetMs: number): string {
  const d = new Date(NOW - offsetMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

describe('orphan pending naming', () => {
  it('resolves the target for in-flight and reclaim-leftover names', () => {
    expect(orphanTargetName('telemetry-2026-09-21.txt.pending')).toBe(
      'telemetry-2026-09-21.txt'
    );
    expect(
      orphanTargetName('telemetry-2026-09-21.txt.pending.reclaim-4242-170000')
    ).toBe('telemetry-2026-09-21.txt');
    expect(
      isOrphanPendingName('telemetry-2026-09-21.txt.pending.reclaim-1-2')
    ).toBe(true);
  });

  it('rejects names that are not orphans', () => {
    expect(orphanTargetName('telemetry-2026-09-21.txt')).toBeNull();
    expect(orphanTargetName('telemetry-2026-09-21.pending')).toBeNull();
    expect(orphanTargetName('telemetry-2026-09-21.txt.reclaim-1-2')).toBeNull();
    expect(orphanTargetName('other.txt.pending')).toBeNull();
    expect(orphanTargetName('upload-state.json')).toBeNull();
    expect(isOrphanPendingName('telemetry-2026-09-21.txt')).toBe(false);
  });
});

describe('hasPendingUploadWork', () => {
  let storageDir: string;
  let failedDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-state-'));
    failedDir = path.join(storageDir, 'failed');
    fs.mkdirSync(failedDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('is false for clean directories', () => {
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(false);
  });

  it('counts a stale orphan in storageDir, not only in failedDir', () => {
    writeWithAge(
      storageDir,
      'telemetry-2026-09-21.txt.pending',
      PENDING_STALE_MS + 1000
    );
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(true);
  });

  it('counts a reclaim leftover in failedDir', () => {
    writeWithAge(
      failedDir,
      'telemetry-2026-09-20.txt.pending.reclaim-7-170000',
      PENDING_STALE_MS * 2
    );
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(true);
  });

  it('ignores an in-flight orphan (mtime refreshed on claim)', () => {
    const file = writeWithAge(
      storageDir,
      'telemetry-2026-09-21.txt.pending',
      1000
    );
    expect(isStalePending(file, NOW)).toBe(false);
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(false);
  });

  it('ignores a live .txt in storageDir (gated by firstEventAt instead)', () => {
    writeWithAge(storageDir, 'telemetry-2026-09-21.txt', 1000);
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(false);
  });

  it('counts a retryable failed .txt but not one past FAILED_MAX_AGE_MS', () => {
    fs.writeFileSync(path.join(failedDir, 'telemetry-2026-09-21.txt'), 'x\n');
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(true);

    fs.rmSync(path.join(failedDir, 'telemetry-2026-09-21.txt'));
    const expired = dateString(FAILED_MAX_AGE_MS + 24 * 60 * 60 * 1000);
    fs.writeFileSync(path.join(failedDir, `telemetry-${expired}.txt`), 'x\n');
    expect(hasPendingUploadWork(storageDir, NOW)).toBe(false);
  });
});

describe('isUploadDue', () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-due-'));
    fs.mkdirSync(path.join(storageDir, 'failed'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('spawns once a stale orphan exists and the retry interval has passed', () => {
    writeUploadState(storageDir, {
      firstEventAt: null,
      lastUploadAt: null,
      lastRetryAt: NOW - RETRY_INTERVAL_MS,
    });
    writeWithAge(
      storageDir,
      'telemetry-2026-09-21.txt.pending',
      PENDING_STALE_MS + 1000
    );
    expect(isUploadDue(storageDir, NOW)).toBe(true);
  });

  it('does not spawn for a stale orphan before the retry interval', () => {
    writeUploadState(storageDir, {
      firstEventAt: null,
      lastUploadAt: null,
      lastRetryAt: NOW - 1000,
    });
    writeWithAge(
      storageDir,
      'telemetry-2026-09-21.txt.pending',
      PENDING_STALE_MS + 1000
    );
    expect(isUploadDue(storageDir, NOW)).toBe(false);
  });

  it('spawns when the first event waited longer than UPLOAD_INTERVAL_MS', () => {
    writeUploadState(storageDir, {
      firstEventAt: NOW - UPLOAD_INTERVAL_MS,
      lastUploadAt: null,
      lastRetryAt: null,
    });
    expect(isUploadDue(storageDir, NOW)).toBe(true);
  });
});
