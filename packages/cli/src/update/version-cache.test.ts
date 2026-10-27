/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VersionCache } from './version-cache.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vc-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const docsFields = {
  latestDocsVersion: '2.0.0',
  latestDocsApiVersion: 2,
  latestCompatibleDocsVersion: '1.5.0',
  checkedAgainstDocsApi: 1,
};

describe('VersionCache docs fields', () => {
  it('round-trips docs fields supplied to writeSuccess', async () => {
    const cache = new VersionCache(dir);
    await cache.writeSuccess('1.2.3', ['1.0.0-bad'], '1.0.0', 'latest', docsFields);
    expect(cache.getLatestDocsVersion()).toBe('2.0.0');
    expect(cache.getLatestDocsApiVersion()).toBe(2);
    expect(cache.getLatestCompatibleDocsVersion()).toBe('1.5.0');
    expect(cache.getCheckedAgainstDocsApi()).toBe(1);
  });

  it('defaults docs fields to null on a fresh cache', () => {
    const cache = new VersionCache(dir);
    expect(cache.getLatestDocsVersion()).toBeNull();
    expect(cache.getLatestDocsApiVersion()).toBeNull();
    expect(cache.getLatestCompatibleDocsVersion()).toBeNull();
    expect(cache.getCheckedAgainstDocsApi()).toBeNull();
  });

  it('preserves prior docs fields when writeSuccess omits docs', async () => {
    // A CLI-only refresh (docs query failed/skipped) must not wipe a previously
    // known compatible version.
    const cache = new VersionCache(dir);
    await cache.writeSuccess('1.2.3', [], '1.0.0', 'latest', docsFields);
    await cache.writeSuccess('1.2.3', [], '1.0.0', 'latest');
    expect(cache.getLatestDocsVersion()).toBe('2.0.0');
    expect(cache.getLatestCompatibleDocsVersion()).toBe('1.5.0');
    expect(cache.getCheckedAgainstDocsApi()).toBe(1);
  });

  it('overwrites docs fields (incl. nulls) when explicitly supplied', async () => {
    const cache = new VersionCache(dir);
    await cache.writeSuccess('1.2.3', [], '1.0.0', 'latest', docsFields);
    await cache.writeSuccess('1.2.3', [], '1.0.0', 'latest', {
      latestDocsVersion: null,
      latestDocsApiVersion: null,
      latestCompatibleDocsVersion: null,
      checkedAgainstDocsApi: 2,
    });
    expect(cache.getLatestDocsVersion()).toBeNull();
    expect(cache.getLatestDocsApiVersion()).toBeNull();
    expect(cache.getLatestCompatibleDocsVersion()).toBeNull();
    expect(cache.getCheckedAgainstDocsApi()).toBe(2);
  });

  it('persists docs fields to disk', async () => {
    const cache = new VersionCache(dir);
    await cache.writeSuccess('1.2.3', [], '1.0.0', 'latest', docsFields);
    const raw = JSON.parse(
      await fs.promises.readFile(path.join(dir, 'cache.json'), 'utf-8')
    );
    expect(raw.latestDocsVersion).toBe('2.0.0');
    expect(raw.latestDocsApiVersion).toBe(2);
    expect(raw.latestCompatibleDocsVersion).toBe('1.5.0');
    expect(raw.checkedAgainstDocsApi).toBe(1);
  });
});
