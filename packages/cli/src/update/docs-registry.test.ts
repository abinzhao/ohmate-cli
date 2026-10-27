/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const getPublishTagMock = vi.hoisted(() => vi.fn());
vi.mock('./constants.js', () => ({
  DOCS_PKG_NAME: '@deveco-test/deveco-cli-knowledgebase',
  getPublishTag: getPublishTagMock,
}));

vi.mock('../utils/logger.js', () => ({
  debugLog: () => {},
}));

import { resolveDocsVersions } from './docs-registry.js';

function mockNpmView(result: unknown): void {
  execaMock.mockResolvedValue({
    stdout: typeof result === 'string' ? result : JSON.stringify(result),
  });
}

const DIST = { tarball: 'https://example.com/pkg.tgz', integrity: 'sha512-abc==' };

describe('resolveDocsVersions', () => {
  beforeEach(() => {
    execaMock.mockReset();
    getPublishTagMock.mockReset();
    getPublishTagMock.mockReturnValue('daily');
  });

  it('returns compatible version when apiVersion <= supportedApi', async () => {
    mockNpmView({ version: '1.3.6-Test.1', apiVersion: 1, dist: DIST });
    const { latest, compatible } = await resolveDocsVersions(1);
    expect(latest.version).toBe('1.3.6-Test.1');
    expect(latest.apiVersion).toBe(1);
    expect(latest.dist).toStrictEqual(DIST);
    expect(compatible).toBe(latest);
  });

  it('returns compatible null when apiVersion > supportedApi', async () => {
    mockNpmView({ version: '2.0.0', apiVersion: 2, dist: DIST });
    const { latest, compatible } = await resolveDocsVersions(1);
    expect(latest.version).toBe('2.0.0');
    expect(compatible).toBeNull();
  });

  it('falls back to dist-tags when version is missing (npm 12 packument)', async () => {
    mockNpmView({
      'dist-tags': { daily: '1.3.6-Test.1', latest: '1.3.5-Test.1' },
      versions: {
        '1.3.6-Test.1': { version: '1.3.6-Test.1', apiVersion: 1, dist: DIST },
      },
    });
    const { latest, compatible } = await resolveDocsVersions(1);
    expect(latest.version).toBe('1.3.6-Test.1');
    expect(latest.dist).toStrictEqual(DIST);
    expect(compatible).toBe(latest);
  });

  it('falls back to versions[ver] for dist when top-level dist is missing', async () => {
    mockNpmView({
      version: '1.3.6-Test.1',
      apiVersion: 1,
      versions: {
        '1.3.6-Test.1': { dist: DIST },
      },
    });
    const { latest, compatible } = await resolveDocsVersions(1);
    expect(latest.dist).toStrictEqual(DIST);
    expect(compatible).toBe(latest);
  });

  it('defaults apiVersion to 0 when missing', async () => {
    mockNpmView({ version: '1.0.0', dist: DIST });
    const { latest } = await resolveDocsVersions(1);
    expect(latest.apiVersion).toBe(0);
  });

  it('throws when version cannot be resolved', async () => {
    mockNpmView({ 'dist-tags': {}, versions: {} });
    await expect(resolveDocsVersions(1)).rejects.toThrow(
      'Could not resolve version'
    );
  });

  it('throws when dist cannot be resolved', async () => {
    mockNpmView({
      'dist-tags': { daily: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0' } },
    });
    await expect(resolveDocsVersions(1)).rejects.toThrow(
      'Could not resolve dist'
    );
  });

  it('queries npm with the publish tag', async () => {
    getPublishTagMock.mockReturnValue('latest');
    mockNpmView({ version: '1.0.0', apiVersion: 1, dist: DIST });
    await resolveDocsVersions(1);
    expect(execaMock).toHaveBeenCalledWith('npm', [
      'view',
      '@deveco-test/deveco-cli-knowledgebase@latest',
      '--json',
    ]);
  });
});
