/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  combinedEmulatorOutputText,
  EmulatorLicenseBlockedError,
  emulatorDataDirNameFromMajorMinor,
  ensureEmulatorLicenseAccepted,
  ensureEmulatorServiceAgreementConfig,
  ensureEmulatorSdkAgreementForImageDownload,
  invalidateEmulatorLicenseCache,
  isEmulatorLicenseBlockedOutput,
  markEmulatorLicenseAcceptedForProcess,
  parseEmulatorMajorMinorFromVersionText,
  rethrowIfLicenseBlockedExecaError,
  resolveEmuConfigPathFromMajorMinor,
  runEmulatorLicenseAcceptDirectly,
  runEmulatorLicenseView,
  throwIfLicenseBlockedInToolOutput,
} from './emulator-license.js';
import * as emulatorLicenseModule from './emulator-license.js';
import { EMULATOR_PRIVACY_BUNDLED } from '../data/emulator-privacy-bundled.js';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const VERSION_TEXT = 'Emulator :6.1.1.100';

/**
 * The agreement-key constants carry vendor naming in their identifiers and
 * values; resolve them by their stable, vendor-free suffixes so this file
 * stays brand-neutral while still testing the real exported values.
 */
function stringExportWithSuffix(suffix: string): string {
  const matches = Object.values(
    emulatorLicenseModule as unknown as Record<string, unknown>
  ).filter((v): v is string => typeof v === 'string' && v.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one string export ending with '${suffix}'`
    );
  }
  return matches[0];
}

const SOFTWARE_SERVICE_AGREEMENT_KEY = stringExportWithSuffix(
  'Software_Service_Agreement'
);
const SDK_AGREEMENT_KEY = stringExportWithSuffix('SDK_Agreement');

/** Resolve `-version` probes; any other argv falls back to a clean result. */
function stubExeca(handlers: {
  version?: { stdout?: string; stderr?: string; exitCode?: number };
  probe?: { stdout?: string; stderr?: string; exitCode?: number };
}): void {
  execaMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] ?? []) as string[];
    if (argv.includes('-version')) {
      const r = handlers.version ?? { stdout: VERSION_TEXT, exitCode: 0 };
      return Promise.resolve({ stderr: '', ...r });
    }
    const r = handlers.probe ?? { stdout: '', exitCode: 0 };
    return Promise.resolve({ stderr: '', ...r });
  });
}

describe('pure helpers', () => {
  it('parseEmulatorMajorMinorFromVersionText extracts major.minor', () => {
    expect(parseEmulatorMajorMinorFromVersionText(VERSION_TEXT)).toBe('6.1');
    expect(parseEmulatorMajorMinorFromVersionText('Version: 5.0.0')).toBe(
      '5.0'
    );
  });

  it('parseEmulatorMajorMinorFromVersionText falls back to two segments', () => {
    expect(parseEmulatorMajorMinorFromVersionText('Emulator 6.2')).toBe('6.2');
  });

  it('parseEmulatorMajorMinorFromVersionText normalizes full-width digits (NFKC)', () => {
    expect(parseEmulatorMajorMinorFromVersionText('６.１.２')).toBe('6.1');
  });

  it('parseEmulatorMajorMinorFromVersionText returns null without a version', () => {
    expect(parseEmulatorMajorMinorFromVersionText('')).toBe(null);
    expect(parseEmulatorMajorMinorFromVersionText('no version')).toBe(null);
    expect(parseEmulatorMajorMinorFromVersionText('6')).toBe(null);
  });

  it('emulatorDataDirNameFromMajorMinor builds and trims the data dir name', () => {
    expect(emulatorDataDirNameFromMajorMinor('6.1')).toBe('Emulator6.1');
    expect(emulatorDataDirNameFromMajorMinor(' 6.1 ')).toBe('Emulator6.1');
  });

  it('combinedEmulatorOutputText joins stdout and stderr with a newline', () => {
    expect(combinedEmulatorOutputText('a', 'b')).toBe('a\nb');
    expect(combinedEmulatorOutputText('a', undefined)).toBe('a\n');
    expect(combinedEmulatorOutputText(undefined, 'b')).toBe('\nb');
    expect(combinedEmulatorOutputText(undefined, undefined)).toBe('\n');
  });

  it('exports the documented .emu_config agreement keys', () => {
    expect(SOFTWARE_SERVICE_AGREEMENT_KEY).not.toBe(SDK_AGREEMENT_KEY);
  });
});

describe('EmulatorLicenseBlockedError', () => {
  it('carries its name and the user-facing hint by default', () => {
    const err = new EmulatorLicenseBlockedError();
    expect(err.name).toBe('EmulatorLicenseBlockedError');
    expect(err.message).toContain('emulator license');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts a custom message', () => {
    expect(new EmulatorLicenseBlockedError('custom').message).toBe('custom');
  });
});

describe('isEmulatorLicenseBlockedOutput', () => {
  it('recognizes every blocked-output pattern, case-insensitively', () => {
    expect(
      isEmulatorLicenseBlockedOutput(
        'License agreements that need to be reviewed'
      )
    ).toBe(true);
    expect(
      isEmulatorLicenseBlockedOutput('some need to be reviewed text')
    ).toBe(true);
    expect(isEmulatorLicenseBlockedOutput('License check aborted')).toBe(true);
    expect(
      isEmulatorLicenseBlockedOutput('agreements that need to be reviewed')
    ).toBe(true);
  });

  it('does not flag normal output', () => {
    expect(isEmulatorLicenseBlockedOutput('Emulator started fine')).toBe(false);
    expect(isEmulatorLicenseBlockedOutput('')).toBe(false);
  });
});

describe('throwIfLicenseBlockedInToolOutput', () => {
  const blocked = 'license agreements that need to be reviewed';

  it('ignores blocked wording when the tool exited zero', () => {
    expect(() =>
      throwIfLicenseBlockedInToolOutput(blocked, '', 0)
    ).not.toThrow();
  });

  it('throws on non-zero exit with blocked wording in stdout or stderr', () => {
    expect(() => throwIfLicenseBlockedInToolOutput(blocked, '', 1)).toThrow(
      EmulatorLicenseBlockedError
    );
    expect(() => throwIfLicenseBlockedInToolOutput('', blocked, 2)).toThrow(
      EmulatorLicenseBlockedError
    );
  });

  it('does not throw for non-zero exits without blocked wording', () => {
    expect(() =>
      throwIfLicenseBlockedInToolOutput('oom', 'crash', 1)
    ).not.toThrow();
  });

  it('treats a null exit code as failure', () => {
    expect(() => throwIfLicenseBlockedInToolOutput('', blocked, null)).toThrow(
      EmulatorLicenseBlockedError
    );
  });
});

describe('rethrowIfLicenseBlockedExecaError', () => {
  const blocked = 'need to be reviewed';

  it('ignores non-error values and zero/undefined exit codes', () => {
    expect(() => rethrowIfLicenseBlockedExecaError(null)).not.toThrow();
    expect(() => rethrowIfLicenseBlockedExecaError(undefined)).not.toThrow();
    expect(() =>
      rethrowIfLicenseBlockedExecaError({ exitCode: 0, stdout: blocked })
    ).not.toThrow();
    expect(() =>
      rethrowIfLicenseBlockedExecaError({
        exitCode: undefined,
        stdout: blocked,
      })
    ).not.toThrow();
  });

  it('rethrows blocked failures from stdout or stderr', () => {
    expect(() =>
      rethrowIfLicenseBlockedExecaError({ exitCode: 1, stdout: blocked })
    ).toThrow(EmulatorLicenseBlockedError);
    expect(() =>
      rethrowIfLicenseBlockedExecaError({ exitCode: 1, stderr: blocked })
    ).toThrow(EmulatorLicenseBlockedError);
  });

  it('handles non-string stdout fields without matching', () => {
    expect(() =>
      rethrowIfLicenseBlockedExecaError({
        exitCode: 1,
        stdout: { note: blocked },
      })
    ).not.toThrow();
  });
});

/**
 * Asserts `p` sits inside `root` as `<root>/<vendor>/<EmulatorX.Y>/.emu_config`
 * without hard-coding the vendor directory name.
 */
function expectEmuConfigShape(root: string, p: string): void {
  const rel = path.relative(root, p).split(path.sep);
  expect(rel).toHaveLength(3);
  expect(rel[0].length).toBeGreaterThan(0);
  expect(rel[1]).toBe('Emulator6.1');
  expect(rel[2]).toBe('.emu_config');
}

describe('resolveEmuConfigPathFromMajorMinor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(process.platform === 'win32')(
    'builds the Windows path under LOCALAPPDATA',
    () => {
      vi.stubEnv('LOCALAPPDATA', 'C:\\FakeLocal');
      const p = resolveEmuConfigPathFromMajorMinor('6.1');
      expectEmuConfigShape('C:\\FakeLocal', p);
      // Different versions share the same vendor directory.
      const p62 = resolveEmuConfigPathFromMajorMinor('6.2');
      expect(path.dirname(path.dirname(p62))).toBe(
        path.dirname(path.dirname(p))
      );
    }
  );

  it.runIf(process.platform === 'win32')(
    'throws when LOCALAPPDATA is not set',
    () => {
      vi.stubEnv('LOCALAPPDATA', '');
      expect(() => resolveEmuConfigPathFromMajorMinor('6.1')).toThrow(
        'LOCALAPPDATA is not set'
      );
    }
  );

  it.runIf(process.platform === 'linux')(
    'honors XDG_CACHE_HOME on Linux',
    () => {
      vi.stubEnv('XDG_CACHE_HOME', '/tmp/fake-cache');
      const p = resolveEmuConfigPathFromMajorMinor('6.1');
      expectEmuConfigShape('/tmp/fake-cache', p);
    }
  );
});

/** Platforms where the .emu_config location can be redirected via env vars. */
const ENV_REDIRECTABLE =
  process.platform === 'win32' || process.platform === 'linux';

describe.runIf(ENV_REDIRECTABLE)('ensure* config flows', () => {
  let root: string;
  let configDir: string;
  let configPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-license-'));
    const envRoot = path.join(root, 'env-root');
    await fs.mkdir(envRoot);
    if (process.platform === 'win32') {
      vi.stubEnv('LOCALAPPDATA', envRoot);
    } else {
      vi.stubEnv('XDG_CACHE_HOME', envRoot);
    }
    // Derive the config location from the module itself (brand-neutral).
    configPath = resolveEmuConfigPathFromMajorMinor('6.1');
    configDir = path.dirname(configPath);
    invalidateEmulatorLicenseCache();
    execaMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, content, 'utf8');
  }

  it('passes when the service agreement key is agree (colon format)', async () => {
    stubExeca({});
    await writeConfig(`${SOFTWARE_SERVICE_AGREEMENT_KEY}:agree\n`);
    await expect(
      ensureEmulatorServiceAgreementConfig('/emu', '/sdk')
    ).resolves.toBeUndefined();
  });

  it('passes for JSON configs and case/whitespace-tolerant values', async () => {
    stubExeca({});
    await writeConfig(
      JSON.stringify({ [SOFTWARE_SERVICE_AGREEMENT_KEY]: ' Agree ' })
    );
    await expect(
      ensureEmulatorServiceAgreementConfig('/emu', '/sdk')
    ).resolves.toBeUndefined();
  });

  it('blocks when the value is not agree', async () => {
    stubExeca({});
    await writeConfig(`${SOFTWARE_SERVICE_AGREEMENT_KEY}:disagree\n`);
    await expect(
      ensureEmulatorServiceAgreementConfig('/emu', '/sdk')
    ).rejects.toThrow(EmulatorLicenseBlockedError);
  });

  it('blocks when the -version probe fails', async () => {
    stubExeca({ version: { stdout: '', stderr: 'boom', exitCode: 1 } });
    await expect(
      ensureEmulatorServiceAgreementConfig('/emu', '/sdk')
    ).rejects.toThrow(EmulatorLicenseBlockedError);
  });

  it('blocks when the version text has no parseable major.minor', async () => {
    stubExeca({ version: { stdout: 'garbage output', exitCode: 0 } });
    await expect(
      ensureEmulatorServiceAgreementConfig('/emu', '/sdk')
    ).rejects.toThrow(EmulatorLicenseBlockedError);
  });

  it('requires the SDK agreement key for image download', async () => {
    stubExeca({});
    await writeConfig(`${SDK_AGREEMENT_KEY}:agree\n`);
    await expect(
      ensureEmulatorSdkAgreementForImageDownload('/emu', '/sdk')
    ).resolves.toBeUndefined();
    // The service key is absent, so the service flow must still block.
    await expect(
      ensureEmulatorServiceAgreementConfig('/emu', '/sdk')
    ).rejects.toThrow(EmulatorLicenseBlockedError);
  });

  it('blocks image download when the SDK key is missing', async () => {
    stubExeca({});
    await writeConfig(`${SOFTWARE_SERVICE_AGREEMENT_KEY}:agree\n`);
    await expect(
      ensureEmulatorSdkAgreementForImageDownload('/emu', '/sdk')
    ).rejects.toThrow(EmulatorLicenseBlockedError);
  });
});

describe.runIf(ENV_REDIRECTABLE)('ensureEmulatorLicenseAccepted probe', () => {
  beforeEach(() => {
    invalidateEmulatorLicenseCache();
    execaMock.mockReset();
  });

  it('throws when the probe reports blocked license wording', async () => {
    stubExeca({
      probe: {
        stdout: 'license agreements that need to be reviewed',
        exitCode: 1,
      },
    });
    await expect(ensureEmulatorLicenseAccepted('/emu', '/sdk')).rejects.toThrow(
      EmulatorLicenseBlockedError
    );
    // A blocked probe must not populate the accepted cache.
    await expect(ensureEmulatorLicenseAccepted('/emu', '/sdk')).rejects.toThrow(
      EmulatorLicenseBlockedError
    );
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('caches acceptance after a clean probe and re-probes after invalidation', async () => {
    stubExeca({ probe: { stdout: '[]', exitCode: 0 } });
    await ensureEmulatorLicenseAccepted('/emu', '/sdk');
    await ensureEmulatorLicenseAccepted('/emu', '/sdk');
    expect(execaMock).toHaveBeenCalledTimes(1);

    invalidateEmulatorLicenseCache();
    await ensureEmulatorLicenseAccepted('/emu', '/sdk');
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed-but-unblocked probes', async () => {
    stubExeca({ probe: { stdout: 'some unrelated failure', exitCode: 1 } });
    await ensureEmulatorLicenseAccepted('/emu', '/sdk');
    await ensureEmulatorLicenseAccepted('/emu', '/sdk');
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('markEmulatorLicenseAcceptedForProcess skips the probe entirely', async () => {
    stubExeca({});
    markEmulatorLicenseAcceptedForProcess('/emu', '/sdk');
    await ensureEmulatorLicenseAccepted('/emu', '/sdk');
    expect(execaMock).not.toHaveBeenCalled();
  });
});

describe.runIf(ENV_REDIRECTABLE)('runEmulatorLicenseAcceptDirectly', () => {
  let root: string;
  let configDir: string;
  let configPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-license-'));
    const envRoot = path.join(root, 'env-root');
    await fs.mkdir(envRoot);
    if (process.platform === 'win32') {
      vi.stubEnv('LOCALAPPDATA', envRoot);
    } else {
      vi.stubEnv('XDG_CACHE_HOME', envRoot);
    }
    // Derive the config location from the module itself (brand-neutral).
    configPath = resolveEmuConfigPathFromMajorMinor('6.1');
    configDir = path.dirname(configPath);
    invalidateEmulatorLicenseCache();
    execaMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes both agreement keys as agree for a fresh machine', async () => {
    stubExeca({});
    await expect(
      runEmulatorLicenseAcceptDirectly('/emu', '/sdk')
    ).resolves.toBe(0);

    const written = await fs.readFile(configPath, 'utf8');
    expect(written).toContain(`${SOFTWARE_SERVICE_AGREEMENT_KEY}:agree`);
    expect(written).toContain(`${SDK_AGREEMENT_KEY}:agree`);
  });

  it('preserves JSON configs and upserts both keys into the object', async () => {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ Other: 'keep' }), 'utf8');
    stubExeca({});
    await expect(
      runEmulatorLicenseAcceptDirectly('/emu', '/sdk')
    ).resolves.toBe(0);

    const written: Record<string, string> = JSON.parse(
      await fs.readFile(configPath, 'utf8')
    );
    expect(written[SOFTWARE_SERVICE_AGREEMENT_KEY]).toBe('agree');
    expect(written[SDK_AGREEMENT_KEY]).toBe('agree');
    expect(written.Other).toBe('keep');
  });

  it('replaces disagreeing lines in place and keeps unrelated lines', async () => {
    await fs.mkdir(configDir, { recursive: true });
    const original = [
      '# comment stays',
      `${SOFTWARE_SERVICE_AGREEMENT_KEY}:disagree`,
      'Other:1',
      '',
    ].join('\n');
    await fs.writeFile(configPath, original, 'utf8');

    stubExeca({});
    await expect(
      runEmulatorLicenseAcceptDirectly('/emu', '/sdk')
    ).resolves.toBe(0);

    const written = await fs.readFile(configPath, 'utf8');
    expect(written).toContain('# comment stays');
    expect(written).toContain('Other:1');
    expect(written).toContain(`${SOFTWARE_SERVICE_AGREEMENT_KEY}:agree`);
    expect(written).not.toContain('disagree');
  });

  it('returns 0 without writing when both keys are already accepted', async () => {
    await fs.mkdir(configDir, { recursive: true });
    const original =
      `${SOFTWARE_SERVICE_AGREEMENT_KEY}:agree\n` +
      `${SDK_AGREEMENT_KEY}:agree\n`;
    await fs.writeFile(configPath, original, 'utf8');

    stubExeca({});
    await expect(
      runEmulatorLicenseAcceptDirectly('/emu', '/sdk')
    ).resolves.toBe(0);
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(console.log).toHaveBeenCalledWith(
      'Emulator license agreements are already accepted.'
    );
  });

  it('returns 1 with an error message when the version probe fails', async () => {
    stubExeca({ version: { stdout: '', stderr: 'boom', exitCode: 1 } });
    await expect(
      runEmulatorLicenseAcceptDirectly('/emu', '/sdk')
    ).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Emulator -version failed')
    );
  });
});

describe('runEmulatorLicenseView', () => {
  it('prints the bundled privacy statement and returns 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(runEmulatorLicenseView('/emu', '/sdk')).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(EMULATOR_PRIVACY_BUNDLED);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
