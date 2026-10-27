/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkSyncRequired } from './project-check.js';

const tempRoots: string[] = [];

const BASE_TIME = new Date('2026-01-15T12:00:00Z').getTime();

interface SyncFixture {
  root: string;
  baseline: string;
  buildProfile: string;
  rootOhPackage: string;
  moduleOhPackage: string;
  moduleBuildProfile: string;
  hvigorConfig: string;
  lockFile: string;
}

function makeSyncFixture(): SyncFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-check-ut-'));
  tempRoots.push(root);

  const baseline = path.join(root, '.hvigor', 'outputs', 'sync', 'output.json');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.writeFileSync(baseline, '{}');

  const buildProfile = path.join(root, 'build-profile.json5');
  fs.writeFileSync(
    buildProfile,
    JSON.stringify({ modules: [{ name: 'entry', srcPath: './entry' }] })
  );

  const rootOhPackage = path.join(root, 'oh-package.json5');
  fs.writeFileSync(rootOhPackage, '{}');

  fs.mkdirSync(path.join(root, 'entry'), { recursive: true });
  const moduleOhPackage = path.join(root, 'entry', 'oh-package.json5');
  fs.writeFileSync(moduleOhPackage, '{}');
  const moduleBuildProfile = path.join(root, 'entry', 'build-profile.json5');
  fs.writeFileSync(moduleBuildProfile, '{}');

  // hvigor-config.json5（位于 hvigor/ 子目录）
  const hvigorConfig = path.join(root, 'hvigor', 'hvigor-config.json5');
  fs.mkdirSync(path.dirname(hvigorConfig), { recursive: true });
  fs.writeFileSync(hvigorConfig, '{}');

  // oh_modules lock file
  const lockFile = path.join(root, 'oh_modules', '.ohpm', 'lock.json5');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, '{}');

  const fixture: SyncFixture = {
    root,
    baseline,
    buildProfile,
    rootOhPackage,
    moduleOhPackage,
    moduleBuildProfile,
    hvigorConfig,
    lockFile,
  };
  resetMtimes(fixture);
  return fixture;
}

/** Pin every fixture file to BASE_TIME so individual tests can shift one mtime. */
function resetMtimes(fixture: SyncFixture): void {
  const files = [
    fixture.baseline,
    fixture.buildProfile,
    fixture.rootOhPackage,
    fixture.moduleOhPackage,
    fixture.moduleBuildProfile,
    fixture.hvigorConfig,
    fixture.lockFile,
  ];
  for (const file of files) {
    const time = new Date(BASE_TIME);
    fs.utimesSync(file, time, time);
  }
}

function setMtime(file: string, offsetMs: number): void {
  const time = new Date(BASE_TIME + offsetMs);
  fs.utimesSync(file, time, time);
}

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('checkSyncRequired', () => {
  it('requires sync when the baseline file does not exist', () => {
    const fixture = makeSyncFixture();
    fs.rmSync(fixture.baseline);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('sync baseline file not found');
  });

  it('requires sync when build-profile.json5 cannot be parsed', () => {
    const fixture = makeSyncFixture();
    fs.writeFileSync(fixture.buildProfile, '   ');
    setMtime(fixture.buildProfile, 0);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toBe('failed to parse build-profile.json5');
  });

  it('skips sync when every source file is at or older than the baseline', () => {
    const fixture = makeSyncFixture();
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(false);
    expect(result.reason).toContain('up-to-date');
  });

  it('requires sync when the root oh-package.json5 is newer than the baseline', () => {
    const fixture = makeSyncFixture();
    setMtime(fixture.rootOhPackage, 2000);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('root:');
  });

  it('requires sync when the project build-profile.json5 is newer', () => {
    const fixture = makeSyncFixture();
    setMtime(fixture.buildProfile, 2000);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('build-profile');
  });

  it('requires sync when a module oh-package.json5 is newer', () => {
    const fixture = makeSyncFixture();
    setMtime(fixture.moduleOhPackage, 2000);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('entry');
  });

  it('requires sync when a module build-profile.json5 is newer', () => {
    const fixture = makeSyncFixture();
    setMtime(fixture.moduleBuildProfile, 2000);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('entry');
  });

  it('treats mtime deltas within the 1s tolerance as up-to-date', () => {
    const fixture = makeSyncFixture();
    setMtime(fixture.rootOhPackage, 500);
    setMtime(fixture.moduleOhPackage, 500);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(false);
  });

  it('skips missing source files instead of requiring sync', () => {
    const fixture = makeSyncFixture();
    fs.rmSync(fixture.moduleOhPackage);
    fs.rmSync(fixture.moduleBuildProfile);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(false);
  });

  it('requires sync when the project hvigor-config.json5 is newer', () => {
    const fixture = makeSyncFixture();
    setMtime(fixture.hvigorConfig, 2000);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('hvigor-config');
  });

  it('requires sync when oh_modules lock file is missing', () => {
    const fixture = makeSyncFixture();
    fs.rmSync(fixture.lockFile);
    const result = checkSyncRequired(fixture.root);
    expect(result.required).toBe(true);
    expect(result.reason).toContain('lock not found');
  });
});
