/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SmokeRunStore } from './smoke-run-store.js';
import {
  ENDED_MARKER_FILE,
  EVIDENCE_RETENTION_MS,
  RUNNING_MARKER_FILE,
  RUN_STALE_MS,
  smokeCrashLogName,
  smokeRunDirName,
  smokeScreenshotName,
} from './smoke-artifacts.js';

const NOW = 1_000_000_000_000;
let foreignSeq = 0;

describe('SmokeRunStore', () => {
  let baseDir: string;
  let runsRoot: string;
  let store: SmokeRunStore;
  let ownDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-store-'));
    runsRoot = path.join(baseDir, 'smoke');
    store = new SmokeRunStore(baseDir);
    ownDir = store.createRun();
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /** Foreign run dir; a string marker value is written raw (garbage), a marker object JSON-stringified. */
  function makeForeignRun(
    markers: {
      running?: { pid: number; startedAt: number } | string;
      ended?: { pid: number; startedAt: number; endedAt: number } | string;
    } = {}
  ): string {
    const nonce = (foreignSeq++).toString(16).padStart(4, '0');
    const dir = path.join(runsRoot, smokeRunDirName(NOW, 9999, nonce));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, smokeScreenshotName(NOW)), 'png', 'utf8');
    for (const [file, value] of [
      [RUNNING_MARKER_FILE, markers.running],
      [ENDED_MARKER_FILE, markers.ended],
    ] as const) {
      if (value === undefined) {
        continue;
      }
      fs.writeFileSync(
        path.join(dir, file),
        typeof value === 'string' ? value : JSON.stringify(value),
        'utf8'
      );
    }
    return dir;
  }

  it('createRun makes an isolated dir with a RUNNING ownership marker', () => {
    expect(fs.statSync(ownDir).isDirectory()).toBe(true);
    const marker = JSON.parse(
      fs.readFileSync(path.join(ownDir, RUNNING_MARKER_FILE), 'utf8')
    ) as { pid: number; startedAt: number };
    expect(marker.pid).toBe(process.pid);
    expect(marker.startedAt).toBeGreaterThan(0);
  });

  it('prune never touches another in-flight run (live owner, fresh marker)', () => {
    const foreign = makeForeignRun({ running: { pid: 4321, startedAt: NOW } });
    // injected probe: ownership decided deterministically, not by real pids
    const liveProbeStore = new SmokeRunStore(baseDir, () => true);
    liveProbeStore.prune(ownDir, NOW + 1000);
    expect(fs.existsSync(path.join(foreign, smokeScreenshotName(NOW)))).toBe(
      true
    );
  });

  it('prune never touches its own run dir even with a dead owner probe', () => {
    const deadProbeStore = new SmokeRunStore(baseDir, () => false);
    deadProbeStore.prune(ownDir, NOW);
    expect(fs.existsSync(ownDir)).toBe(true);
  });

  it('prune reclaims a marker-less dir (legacy or corrupt)', () => {
    const foreign = makeForeignRun();
    store.prune(ownDir, NOW);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('prune reclaims a crashed run (RUNNING marker, owner pid dead)', () => {
    const foreign = makeForeignRun({ running: { pid: 4321, startedAt: NOW } });
    const deadProbeStore = new SmokeRunStore(baseDir, () => false);
    deadProbeStore.prune(ownDir, NOW + 1000);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('prune reclaims a stale run (RUNNING marker past the stale threshold)', () => {
    const foreign = makeForeignRun({ running: { pid: 4321, startedAt: NOW } });
    store.prune(ownDir, NOW + RUN_STALE_MS + 1);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('prune reclaims a run whose RUNNING marker is unreadable garbage', () => {
    const foreign = makeForeignRun({ running: 'not json' });
    store.prune(ownDir, NOW + 1000);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it("prune keeps an ended run's evidence inside the 24h retention window (agent read guarantee)", () => {
    const foreign = makeForeignRun({
      ended: { pid: 4321, startedAt: NOW, endedAt: NOW + 1_000 },
    });
    store.prune(ownDir, NOW + 1_000 + 60_000); // 1 minute after the run ended
    expect(fs.existsSync(path.join(foreign, smokeScreenshotName(NOW)))).toBe(
      true
    );
    // dead owner probe changes nothing: the window belongs to the evidence
    const deadProbeStore = new SmokeRunStore(baseDir, () => false);
    deadProbeStore.prune(ownDir, NOW + 1_000 + 60_000);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("prune reclaims an ended run's evidence once the retention window has passed", () => {
    const foreign = makeForeignRun({
      ended: { pid: 4321, startedAt: NOW, endedAt: NOW + 1_000 },
    });
    store.prune(ownDir, NOW + 1_000 + EVIDENCE_RETENTION_MS);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('ENDED takes precedence over RUNNING when both markers exist', () => {
    const foreign = makeForeignRun({
      running: { pid: 4321, startedAt: NOW },
      ended: { pid: 4321, startedAt: NOW, endedAt: NOW + 1_000 },
    });
    // RUNNING alone (live, fresh) would keep the dir; expired ENDED wins → reclaimed
    const liveProbeStore = new SmokeRunStore(baseDir, () => true);
    liveProbeStore.prune(ownDir, NOW + 1_000 + EVIDENCE_RETENTION_MS);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('prune reclaims an ended run whose ENDED marker is corrupt', () => {
    const foreign = makeForeignRun({ ended: 'not json' });
    store.prune(ownDir, NOW + 1000);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('prune removes legacy flat artifacts but leaves other .hvigor files alone', () => {
    const legacyShot = path.join(baseDir, smokeScreenshotName(1));
    const legacyCrash = path.join(baseDir, smokeCrashLogName(1));
    const changes = path.join(baseDir, 'changes.txt');
    fs.writeFileSync(legacyShot, 'png', 'utf8');
    fs.writeFileSync(legacyCrash, 'log', 'utf8');
    fs.writeFileSync(changes, 'entry/src/main/ets/pages/Index.ets', 'utf8');
    store.prune(ownDir, NOW);
    expect(fs.existsSync(legacyShot)).toBe(false);
    expect(fs.existsSync(legacyCrash)).toBe(false);
    expect(fs.existsSync(changes)).toBe(true);
  });

  it('prune ignores non-run entries under the runs root', () => {
    const strayFile = path.join(runsRoot, 'notes.txt');
    const strayDir = path.join(runsRoot, 'not-a-run-dir');
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(strayFile, 'x', 'utf8');
    store.prune(ownDir, NOW);
    expect(fs.existsSync(strayFile)).toBe(true);
    expect(fs.existsSync(strayDir)).toBe(true);
  });

  it('finalize records ENDED (starting the retention window), drops RUNNING, keeps evidence', () => {
    const evidence = path.join(ownDir, smokeScreenshotName(NOW));
    fs.writeFileSync(evidence, 'png', 'utf8');
    store.finalize(ownDir);
    expect(fs.existsSync(path.join(ownDir, RUNNING_MARKER_FILE))).toBe(false);
    const marker = JSON.parse(
      fs.readFileSync(path.join(ownDir, ENDED_MARKER_FILE), 'utf8')
    ) as { pid: number; startedAt: number; endedAt: number };
    expect(marker.pid).toBe(process.pid);
    expect(marker.endedAt).toBeGreaterThanOrEqual(marker.startedAt);
    expect(fs.existsSync(evidence)).toBe(true);
  });

  it('discard removes the whole run dir (PASS keeps nothing)', () => {
    fs.writeFileSync(
      path.join(ownDir, smokeScreenshotName(NOW)),
      'png',
      'utf8'
    );
    store.discard(ownDir);
    expect(fs.existsSync(ownDir)).toBe(false);
  });

  it('finalize/discard tolerate a missing run dir', () => {
    const ghost = path.join(runsRoot, 'run-1-2-abcd');
    expect(() => store.finalize(ghost)).not.toThrow();
    expect(() => store.discard(ghost)).not.toThrow();
  });

  it('resolveBaseDir prefers the explicit screenshotDir override', () => {
    expect(SmokeRunStore.resolveBaseDir('/proj', '/tmp/shots')).toBe(
      '/tmp/shots'
    );
    expect(SmokeRunStore.resolveBaseDir('/proj')).toBe(
      path.join('/proj', '.hvigor')
    );
  });
});
