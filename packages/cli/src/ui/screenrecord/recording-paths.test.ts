/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_NAME_RE,
  MAX_PUBLISH_CANDIDATES,
  encodeSerial,
  formatTimestamp,
  makeDeviceFileName,
  makeLocalFileName,
  makeStagingPath,
  recoveryCandidates,
  sanitizeDeviceName,
} from './recording-paths.js';

describe('encodeSerial', () => {
  it('encodes to safe hex and round-trips', () => {
    const serial = '0177832457001024';
    const hex = encodeSerial(serial);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(hex, 'hex').toString('utf8')).toBe(serial);
  });

  it('keeps distinct serials distinct on case-insensitive filesystems', () => {
    expect(encodeSerial('AbC')).not.toBe(encodeSerial('abc'));
  });
});

describe('sanitizeDeviceName', () => {
  it('keeps normal names and Chinese characters', () => {
    expect(sanitizeDeviceName('HUAWEI Mate XT')).toBe('HUAWEI Mate XT');
    expect(sanitizeDeviceName('我的 手机')).toBe('我的 手机');
  });

  it('replaces Windows-illegal and shell-risky characters', () => {
    expect(sanitizeDeviceName('a<b>:"c/d\\e|f?g*h')).toBe('a-b---c-d-e-f-g-h');
  });

  it('trims trailing dots and spaces (Windows forbids them)', () => {
    expect(sanitizeDeviceName('phone. ')).toBe('phone');
    expect(sanitizeDeviceName('...')).toBe('device');
    expect(sanitizeDeviceName('   ')).toBe('device');
  });
});

describe('naming', () => {
  const date = new Date(2026, 8, 16, 11, 55, 30, 123);

  it('formats timestamps with millisecond resolution', () => {
    expect(formatTimestamp(date)).toBe('20260916-115530123');
  });

  it('makes device names matching the safe charset', () => {
    const name = makeDeviceFileName(date, 'a3f2');
    expect(name).toBe('devecocli-20260916-115530123-a3f2.mp4');
    expect(DEVICE_NAME_RE.test(name)).toBe(true);
  });

  it('rejects malformed random suffixes', () => {
    expect(() => makeDeviceFileName(date, 'XYZ!')).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECORDING_PATH' })
    );
  });

  it('makes local names with a sanitized device component', () => {
    expect(makeLocalFileName('Mate XT', date, 'b7c1')).toBe(
      'Mate XT-20260916-115530123-b7c1.mp4'
    );
    expect(makeLocalFileName('a/b', date, 'b7c1')).toBe(
      'a-b-20260916-115530123-b7c1.mp4'
    );
  });
});

describe('makeStagingPath', () => {
  it('builds a staging path under /data/local/tmp', () => {
    expect(makeStagingPath('devecocli-x-a3f2.mp4', 'b7c1')).toBe(
      '/data/local/tmp/devecocli-b7c1-devecocli-x-a3f2.mp4'
    );
  });

  it('rejects names with path separators or traversal', () => {
    for (const bad of ['../x.mp4', 'a/b.mp4', 'a b.mp4', 'a"b.mp4']) {
      expect(() => makeStagingPath(bad, 'b7c1')).toThrowError(
        expect.objectContaining({ code: 'INVALID_RECORDING_PATH' })
      );
    }
  });
});

describe('recoveryCandidates', () => {
  it('walks target, -recovered, then numbered recoveries', () => {
    const target = path.join('out', 'demo.mp4');
    const candidates = recoveryCandidates(target);
    expect(candidates[0]).toBe(target);
    expect(candidates[1]).toBe(path.join('out', 'demo-recovered.mp4'));
    expect(candidates[2]).toBe(path.join('out', 'demo-recovered-2.mp4'));
    expect(candidates).toHaveLength(MAX_PUBLISH_CANDIDATES);
  });

  it('preserves the .mp4 extension in every candidate', () => {
    for (const candidate of recoveryCandidates(path.join('out', 'demo.mp4'))) {
      expect(candidate.endsWith('.mp4')).toBe(true);
    }
  });
});
