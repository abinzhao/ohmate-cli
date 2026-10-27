/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
  buildSnapshotArgs,
  formatHdcOutput,
  formatSnapshotDisplayOutput,
  isInvalidDisplayOutput,
  parseRemoteFileSize,
} from './hdc-snapshot.js';
import type { ScreenshotContext } from './types.js';

const ctx: ScreenshotContext = {
  hdcPath: '/hdc',
  serial: '127.0.0.1:5555',
  localPath: '/tmp/out.png',
  remotePath: '/data/local/tmp/devecocli-x.png',
};

describe('buildSnapshotArgs', () => {
  it('builds the base snapshot_display invocation', () => {
    expect(buildSnapshotArgs(ctx)).toEqual([
      '-t',
      '127.0.0.1:5555',
      'shell',
      'snapshot_display',
      '-f',
      '/data/local/tmp/devecocli-x.png',
    ]);
  });

  it('inserts -i before -f when a display is set and appends -t png on retry', () => {
    const withDisplay: ScreenshotContext = { ...ctx, display: '2' };
    expect(buildSnapshotArgs(withDisplay)).toEqual([
      '-t',
      '127.0.0.1:5555',
      'shell',
      'snapshot_display',
      '-i',
      '2',
      '-f',
      '/data/local/tmp/devecocli-x.png',
    ]);
    expect(buildSnapshotArgs(withDisplay, 'png')).toEqual([
      '-t',
      '127.0.0.1:5555',
      'shell',
      'snapshot_display',
      '-i',
      '2',
      '-f',
      '/data/local/tmp/devecocli-x.png',
      '-t',
      'png',
    ]);
  });
});

describe('parseRemoteFileSize', () => {
  it('parses the size field of an ls -l line', () => {
    const line =
      '-rw-r--r-- 1 root root 1048576 2026-09-10 10:00 /data/local/tmp/x.png';
    expect(parseRemoteFileSize(line)).toBe(1048576);
  });

  it('returns undefined for missing files and non-numeric output', () => {
    expect(parseRemoteFileSize('No such file or directory')).toBeUndefined();
    expect(parseRemoteFileSize('')).toBeUndefined();
    expect(parseRemoteFileSize('total 0')).toBeUndefined();
  });
});

describe('formatSnapshotDisplayOutput', () => {
  it('normalizes the supported displayIds tips block', () => {
    const raw = 'invalid display id\nTips: supported displayIds:\n0 1\n2, 3\n4';
    expect(formatSnapshotDisplayOutput(raw)).toBe(
      'invalid display id\nTips: supported displayIds: 0, 1, 2, 3, 4'
    );
  });

  it('leaves output without a tips block untouched', () => {
    expect(formatSnapshotDisplayOutput('ok')).toBe('ok');
  });
});

describe('isInvalidDisplayOutput', () => {
  it('detects display-related failure wording in either order', () => {
    expect(isInvalidDisplayOutput('display id 5 is invalid')).toBe(true);
    expect(isInvalidDisplayOutput('invalid display id')).toBe(true);
    expect(isInvalidDisplayOutput('display 5 does not exist')).toBe(true);
  });

  it('does not flag unrelated output', () => {
    expect(isInvalidDisplayOutput('capture ok')).toBe(false);
    expect(isInvalidDisplayOutput('')).toBe(false);
  });
});

describe('formatHdcOutput', () => {
  it('joins stdout and stderr, trimming empties', () => {
    expect(formatHdcOutput('out', '')).toBe('out');
    expect(formatHdcOutput('out', 'err')).toBe('out\nerr');
    expect(formatHdcOutput('  out  ', '')).toBe('out');
  });
});
