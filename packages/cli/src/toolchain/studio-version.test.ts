/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  platform: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('os', () => ({ platform: mocks.platform }));
vi.mock('fs', () => ({
  default: {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
  },
}));
vi.mock('../utils/logger.js', () => ({ debugLog: mocks.debugLog }));

import { compareStudioVersions, readStudioVersion } from './studio-version.js';
import { compareNumericVersions } from '../utils/semver.js';

/** Stub the two plist readers, keyed by the requested plist key. */
function stubPlist(
  values: Record<string, string>,
  failingCommands: string[] = []
): void {
  mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (failingCommands.includes(command)) {
      throw new Error(`command failed: ${command}`);
    }
    const spec = args[1] as string;
    const key = spec.startsWith('Print :')
      ? spec.slice('Print :'.length)
      : spec;
    const value = values[key];
    if (value === undefined) {
      throw new Error(`key not found: ${key}`);
    }
    return value;
  });
}

describe('readStudioVersion on Windows/Linux (product-info.json)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.mockReturnValue('win32');
    mocks.existsSync.mockReturnValue(true);
  });

  it('returns the trimmed version from product-info.json', () => {
    mocks.readFileSync.mockReturnValue('{"version": "  5.0.7.300  "}');

    expect(readStudioVersion('C:\\DevEco Studio')).toBe('5.0.7.300');
    expect(mocks.readFileSync).toHaveBeenCalledWith(
      path.join('C:\\DevEco Studio', 'product-info.json'),
      'utf8'
    );
  });

  it('reads product-info.json on linux as well', () => {
    mocks.platform.mockReturnValue('linux');
    mocks.readFileSync.mockReturnValue('{"version": "6.1.0"}');

    expect(readStudioVersion('/opt/deveco-studio')).toBe('6.1.0');
    expect(mocks.readFileSync).toHaveBeenCalledWith(
      path.join('/opt/deveco-studio', 'product-info.json'),
      'utf8'
    );
  });

  it('returns undefined when the version is not a string', () => {
    mocks.readFileSync.mockReturnValue('{"version": 500}');

    expect(readStudioVersion('root')).toBeUndefined();
  });

  it('returns undefined when the version is blank', () => {
    mocks.readFileSync.mockReturnValue('{"version": "   "}');

    expect(readStudioVersion('root')).toBeUndefined();
  });

  it('returns undefined when product-info.json is missing', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(readStudioVersion('root')).toBeUndefined();
  });

  it('returns undefined when product-info.json is corrupt JSON', () => {
    mocks.readFileSync.mockReturnValue('not-json');

    expect(readStudioVersion('root')).toBeUndefined();
  });
});

describe('readStudioVersion on macOS (Info.plist)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.mockReturnValue('darwin');
    mocks.existsSync.mockReturnValue(true);
  });

  it('combines the short version with the numeric build suffix', () => {
    stubPlist({
      CFBundleShortVersionString: '5.0.1',
      CFBundleVersion: '5.0.1.501356',
    });

    expect(readStudioVersion('/Applications/DevEco Studio.app')).toBe(
      '5.0.1.356'
    );
  });

  it('falls back to the raw CFBundleVersion when the short version is missing', () => {
    stubPlist({ CFBundleVersion: '5.0.2.400' });

    expect(readStudioVersion('/Applications/DevEco Studio.app')).toBe(
      '5.0.2.400'
    );
  });

  it('extracts the build suffix from the get-info DS marker when CFBundleVersion lacks one', () => {
    stubPlist({
      CFBundleShortVersionString: '5.0.3',
      CFBundleGetInfoString: 'DevEco-Studio 5.0.3, Copyright DS-5.0.3.310',
    });

    expect(readStudioVersion('/Applications/DevEco Studio.app')).toBe(
      '5.0.3.310'
    );
  });

  it('returns the short version when no numeric build suffix exists', () => {
    stubPlist({
      CFBundleShortVersionString: '5.0.4',
      CFBundleVersion: 'unknown',
      CFBundleGetInfoString: 'DevEco-Studio 5.0.4',
    });

    expect(readStudioVersion('/Applications/DevEco Studio.app')).toBe('5.0.4');
  });

  it('returns undefined when Info.plist is missing', () => {
    mocks.existsSync.mockReturnValue(false);

    expect(
      readStudioVersion('/Applications/DevEco Studio.app')
    ).toBeUndefined();
  });

  it('returns undefined when the plist readers report a missing key', () => {
    stubPlist({});

    expect(
      readStudioVersion('/Applications/DevEco Studio.app')
    ).toBeUndefined();
  });

  it('falls back to plutil when PlistBuddy is unavailable', () => {
    stubPlist(
      { CFBundleShortVersionString: '5.0.5', CFBundleVersion: '5.0.5.320' },
      ['/usr/libexec/PlistBuddy']
    );

    expect(readStudioVersion('/Applications/DevEco Studio.app')).toBe(
      '5.0.5.320'
    );
    const commands = mocks.execFileSync.mock.calls.map(
      (call: unknown[]) => call[0]
    );
    expect(commands).toContain('plutil');
  });

  it('treats "Does Not Exist" values as missing and keeps looking', () => {
    stubPlist({
      CFBundleShortVersionString: 'Does Not Exist',
      CFBundleVersion: '5.0.6.330',
    });

    expect(readStudioVersion('/Applications/DevEco Studio.app')).toBe(
      '5.0.6.330'
    );
  });
});

describe('compareStudioVersions re-export', () => {
  it('re-exports compareNumericVersions', () => {
    expect(compareStudioVersions).toBe(compareNumericVersions);
  });

  it('orders build versions numerically', () => {
    expect(compareStudioVersions('5.0.1.356', '5.0.2.300')).toBeLessThan(0);
    expect(compareStudioVersions('5.10.0', '5.9.0')).toBeGreaterThan(0);
    expect(compareStudioVersions('6.1.0', '6.1.0')).toBe(0);
  });
});
