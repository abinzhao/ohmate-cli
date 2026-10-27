/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ToolProvider } from '../toolchain/index.js';
import { SUPPORTED_DEVICE_TYPES } from '../utils/template-provider.js';

interface PrivateExports {
  ValidationError: new (code: string, message: string) => Error;
  validateAppName: (name: string) => void;
  validateDeviceTypes: (deviceTypes?: string[]) => string[];
  normalizeProjectPath: (projectPath: string) => string;
  validateProjectPath: (projectPath: string) => void;
  deriveBundleName: (appName: string) => string;
  resolveApiLevel: (
    options: { apiLevel?: string },
    toolProvider?: ToolProvider
  ) => number;
}

// The command module keeps its validation helpers module-private, so expose
// them for tests through a throwaway sibling module that re-exports them.
async function loadPrivateExports(): Promise<PrivateExports> {
  const sourcePath = fileURLToPath(new URL('./create.ts', import.meta.url));
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const reexports = [
    'export {',
    '  ValidationError,',
    '  validateAppName,',
    '  validateDeviceTypes,',
    '  normalizeProjectPath,',
    '  validateProjectPath,',
    '  deriveBundleName,',
    '  resolveApiLevel,',
    '};',
    '',
  ].join('\n');
  const helperPath = path.join(
    path.dirname(sourcePath),
    `.create-private-exports-${process.pid}.ts`
  );
  fs.writeFileSync(helperPath, source + reexports);
  try {
    const helperUrl = `${pathToFileURL(helperPath).href}?v=${Date.now()}`;
    return (await import(helperUrl)) as unknown as PrivateExports;
  } finally {
    fs.rmSync(helperPath, { force: true });
  }
}

const {
  ValidationError,
  validateAppName,
  validateDeviceTypes,
  normalizeProjectPath,
  validateProjectPath,
  deriveBundleName,
  resolveApiLevel,
} = await loadPrivateExports();

function fakeToolProvider(maxApiLevel?: number): ToolProvider {
  return { getMaxApiLevel: () => maxApiLevel } as unknown as ToolProvider;
}

beforeEach(() => {
  vi.spyOn(os, 'platform').mockReturnValue('win32');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateAppName', () => {
  it('accepts letter-first names built from letters, digits and underscores', () => {
    expect(() => validateAppName('MyApp')).not.toThrow();
    expect(() => validateAppName('a')).not.toThrow();
    expect(() => validateAppName('app_2_v2')).not.toThrow();
    expect(() => validateAppName('A'.repeat(200))).not.toThrow();
  });

  it('rejects names that are empty or longer than 200 characters', () => {
    expect(() => validateAppName('')).toThrow(ValidationError);
    expect(() => validateAppName('')).toThrowError(/1-200 characters/);
    expect(() => validateAppName('A'.repeat(201))).toThrow(ValidationError);
    expect(() => validateAppName('A'.repeat(201))).toThrowError(
      /1-200 characters/
    );
  });

  it('rejects names not starting with a letter', () => {
    expect(() => validateAppName('1app')).toThrow(ValidationError);
    expect(() => validateAppName('_app')).toThrow(ValidationError);
  });

  it('rejects names with characters outside the whitelist', () => {
    expect(() => validateAppName('my-app')).toThrow(ValidationError);
    expect(() => validateAppName('my app')).toThrow(ValidationError);
    expect(() => validateAppName('应用')).toThrow(ValidationError);
  });
});

describe('validateDeviceTypes', () => {
  it('defaults to phone when omitted or empty', () => {
    expect(validateDeviceTypes()).toEqual(['phone']);
    expect(validateDeviceTypes([])).toEqual(['phone']);
  });

  it('accepts every DevEco Studio device type (case-insensitive)', () => {
    expect(validateDeviceTypes(['phone'])).toEqual(['phone']);
    expect(validateDeviceTypes(['Tablet'])).toEqual(['tablet']);
    expect(validateDeviceTypes(['2in1'])).toEqual(['2in1']);
    expect(validateDeviceTypes(['Car'])).toEqual(['car']);
    expect(validateDeviceTypes(['WEARABLE'])).toEqual(['wearable']);
    expect(validateDeviceTypes(['Tv'])).toEqual(['tv']);
    expect(validateDeviceTypes(['PHONE', 'Tablet'])).toEqual([
      'phone',
      'tablet',
    ]);
    expect(validateDeviceTypes([...SUPPORTED_DEVICE_TYPES])).toEqual([
      ...SUPPORTED_DEVICE_TYPES,
    ]);
  });

  it('keeps the requested order and drops duplicates (case-insensitive)', () => {
    expect(validateDeviceTypes(['tablet', 'phone'])).toEqual([
      'tablet',
      'phone',
    ]);
    expect(validateDeviceTypes(['tv', 'TV'])).toEqual(['tv']);
    expect(validateDeviceTypes(['Phone', 'phone'])).toEqual(['phone']);
  });

  it('rejects unsupported types and lists the supported ones', () => {
    expect(() => validateDeviceTypes(['watch'])).toThrow(ValidationError);
    expect(() => validateDeviceTypes(['watch'])).toThrowError(
      /Unsupported device type\(s\): "watch"/
    );
    expect(() => validateDeviceTypes(['watch'])).toThrowError(
      /Supported types: phone, tablet, 2in1, car, wearable, tv/
    );
    expect(() => validateDeviceTypes(['phone', 'pc', 'TV'])).toThrowError(
      /"pc"/
    );
  });
});

describe('normalizeProjectPath (win32)', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeProjectPath('a\\b\\c')).toBe('a/b/c');
    expect(normalizeProjectPath('C:\\Projects\\MyApp')).toBe(
      'C:/Projects/MyApp'
    );
  });

  it('collapses repeated separators', () => {
    expect(normalizeProjectPath('a\\\\b')).toBe('a/b');
    expect(normalizeProjectPath('a///b')).toBe('a/b');
    expect(normalizeProjectPath('a\\/\\/b')).toBe('a/b');
  });
});

describe('normalizeProjectPath (posix)', () => {
  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
  });

  it('collapses repeated forward slashes but keeps backslashes literal', () => {
    expect(normalizeProjectPath('a//b')).toBe('a/b');
    expect(normalizeProjectPath('a\\b')).toBe('a\\b');
  });
});

describe('validateProjectPath (win32)', () => {
  it('accepts plain relative and drive-absolute paths', () => {
    expect(() => validateProjectPath('my-project_1.2')).not.toThrow();
    expect(() => validateProjectPath('C:\\Projects\\MyApp')).not.toThrow();
    expect(() => validateProjectPath('C:/Projects/MyApp')).not.toThrow();
    expect(() => validateProjectPath('a'.repeat(120))).not.toThrow();
  });

  it('rejects empty or oversized paths', () => {
    expect(() => validateProjectPath('')).toThrow(ValidationError);
    expect(() => validateProjectPath('')).toThrowError(/cannot be empty/);
    expect(() => validateProjectPath('a'.repeat(121))).toThrowError(
      /cannot exceed 120 characters/
    );
  });

  it('rejects characters outside the platform whitelist', () => {
    expect(() => validateProjectPath('my project')).toThrowError(
      /can only contain/
    );
    expect(() => validateProjectPath('项目')).toThrowError(/can only contain/);
  });

  it('rejects paths ending with a dot', () => {
    expect(() => validateProjectPath('project.')).toThrowError(
      /end with a dot/
    );
    expect(() => validateProjectPath('C:\\App\\.')).toThrowError(
      /end with a dot/
    );
  });
});

describe('validateProjectPath (posix)', () => {
  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
  });

  it('accepts plain posix paths', () => {
    expect(() => validateProjectPath('projects/my-app_1.2')).not.toThrow();
  });

  it('rejects colons and backslashes on posix', () => {
    expect(() => validateProjectPath('C:\\Projects')).toThrowError(
      /can only contain/
    );
    expect(() => validateProjectPath('a:b')).toThrowError(/can only contain/);
  });
});

describe('deriveBundleName', () => {
  it('prefixes and lowercases the app name', () => {
    expect(deriveBundleName('MyApp')).toBe('com.example.myapp');
    expect(deriveBundleName('App_2')).toBe('com.example.app_2');
  });
});

describe('resolveApiLevel', () => {
  it('returns an explicit level within the SDK range', () => {
    expect(resolveApiLevel({ apiLevel: '18' }, fakeToolProvider(20))).toBe(18);
    expect(resolveApiLevel({ apiLevel: '17' }, fakeToolProvider(20))).toBe(17);
  });

  it('accepts numeric forms that parse to an integer', () => {
    expect(resolveApiLevel({ apiLevel: '17.0' }, fakeToolProvider(20))).toBe(
      17
    );
  });

  it('defaults to the SDK maximum when no level is requested', () => {
    expect(resolveApiLevel({}, fakeToolProvider(20))).toBe(20);
  });

  it('falls back to 23 without a tool provider or SDK maximum', () => {
    expect(resolveApiLevel({})).toBe(23);
    expect(resolveApiLevel({}, fakeToolProvider(undefined))).toBe(23);
  });

  it('treats an empty level as omitted', () => {
    expect(resolveApiLevel({ apiLevel: '' }, fakeToolProvider(20))).toBe(20);
  });

  it('rejects levels below 17 or non-integer values', () => {
    expect(() => resolveApiLevel({ apiLevel: '16' })).toThrowError(
      /17 or higher/
    );
    expect(() => resolveApiLevel({ apiLevel: '-17' })).toThrowError(
      /17 or higher/
    );
    expect(() => resolveApiLevel({ apiLevel: '17.5' })).toThrow(
      ValidationError
    );
    expect(() => resolveApiLevel({ apiLevel: 'abc' })).toThrow(ValidationError);
  });

  it('rejects levels above the SDK maximum', () => {
    expect(() =>
      resolveApiLevel({ apiLevel: '21' }, fakeToolProvider(20))
    ).toThrowError(/Your SDK supports API version 17-20/);
    expect(() =>
      resolveApiLevel({ apiLevel: '23' }, fakeToolProvider(20))
    ).toThrowError(/Your SDK supports API version 17-20/);
  });

  it('caps the range at 23 without a local IDE installation', () => {
    expect(resolveApiLevel({ apiLevel: '23' })).toBe(23);
    expect(() => resolveApiLevel({ apiLevel: '24' })).toThrowError(
      /^Invalid API version 24\. Without .+ supported range is API version 17-23$/
    );
  });
});
