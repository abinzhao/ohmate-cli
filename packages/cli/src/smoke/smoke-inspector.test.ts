/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SmokeInspector } from './smoke-inspector.js';
import type { HdcAdapter } from '../utils/hdc-adapter.js';

function stubHdc(pidofBundle: () => Promise<boolean>): HdcAdapter {
  return { pidofBundle } as unknown as HdcAdapter;
}

function runsRoot(root: string): string {
  return path.join(root, '.hvigor', 'smoke');
}

function runDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(runsRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(runsRoot(root), e.name));
  } catch {
    return [];
  }
}

describe('SmokeInspector.collect', () => {
  const prevWait = process.env.DEVECO_CLI_SMOKE_WAIT_MS;

  beforeEach(() => {
    process.env.DEVECO_CLI_SMOKE_WAIT_MS = '0';
  });

  afterEach(() => {
    if (prevWait === undefined) {
      delete process.env.DEVECO_CLI_SMOKE_WAIT_MS;
    } else {
      process.env.DEVECO_CLI_SMOKE_WAIT_MS = prevWait;
    }
  });

  it('process-check transport failure skips smoke conservatively (PASS path)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-insp-'));
    try {
      const hdc = stubHdc(async () => {
        throw new Error(
          "pidof query failed for 'com.example.app': device offline"
        );
      });
      const inspector = new SmokeInspector({} as never, hdc, root);
      const evidence = await inspector.collect({
        targetDeviceId: '127.0.0.1:5555',
        bundleName: 'com.example.app',
      });
      expect(evidence.processCheckSkipped).toBe(true);
      expect(evidence.processAlive).toBe(true);
      expect(evidence.phashBlank).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a concurrent run on the same project never deletes an in-flight run's evidence (issue #453 prune race)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-race-'));
    try {
      // Run A: opens its run dir, then blocks inside pidof (evidence already
      // on disk — the await window where the old prune could delete it).
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const inspectorA = new SmokeInspector(
        {} as never,
        stubHdc(async () => {
          await gateA;
          return true;
        }),
        root
      );
      const collectA = inspectorA.collect({
        targetDeviceId: '127.0.0.1:5555',
        bundleName: 'com.example.app',
      });
      await new Promise((r) => setTimeout(r, 20)); // let A reach the pidof gate

      expect(runDirs(root)).toHaveLength(1);
      const dirA = runDirs(root)[0];
      const screenshotA = path.join(dirA, 'smoke-screenshot-1.png');
      fs.writeFileSync(screenshotA, 'x'.repeat(64), 'utf8'); // A's in-flight evidence

      // Run B (e.g. same project deploying to a second device): prunes while
      // A is still in flight — must keep A's dir and its evidence.
      const inspectorB = new SmokeInspector(
        {} as never,
        stubHdc(async () => {
          throw new Error('pidof query failed: device offline');
        }),
        root
      );
      await inspectorB.collect({
        targetDeviceId: '127.0.0.1:5556',
        bundleName: 'com.example.app',
      });

      expect(fs.existsSync(screenshotA)).toBe(true);
      expect(fs.existsSync(dirA)).toBe(true);

      releaseA();
      await collectA; // A resumes undisturbed — no unhandled rejection
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('failed evidence survives the 24h retention window and is reclaimed only after it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-race-'));
    try {
      // A completes with a FAIL-shaped outcome → finalizeRun records ENDED.
      const inspectorA = new SmokeInspector(
        {} as never,
        stubHdc(async () => {
          throw new Error('offline');
        }),
        root
      );
      await inspectorA.collect({
        targetDeviceId: '127.0.0.1:5555',
        bundleName: 'com.example.app',
      });
      inspectorA.finalizeRun();
      const dirA = runDirs(root)[0];
      expect(fs.existsSync(dirA)).toBe(true); // evidence kept for the FAIL

      // Next run inside the window: evidence stays readable.
      const inspectorB = new SmokeInspector(
        {} as never,
        stubHdc(async () => {
          throw new Error('offline');
        }),
        root
      );
      await inspectorB.collect({
        targetDeviceId: '127.0.0.1:5556',
        bundleName: 'com.example.app',
      });
      expect(fs.existsSync(dirA)).toBe(true);

      // Backdate A's ENDED marker past the retention window → reclaimed.
      const endedPath = path.join(dirA, 'ENDED');
      const marker = JSON.parse(fs.readFileSync(endedPath, 'utf8')) as {
        pid: number;
        startedAt: number;
        endedAt: number;
      };
      marker.endedAt = Date.now() - 25 * 60 * 60 * 1000;
      fs.writeFileSync(endedPath, JSON.stringify(marker), 'utf8');
      const inspectorC = new SmokeInspector(
        {} as never,
        stubHdc(async () => {
          throw new Error('offline');
        }),
        root
      );
      await inspectorC.collect({
        targetDeviceId: '127.0.0.1:5557',
        bundleName: 'com.example.app',
      });
      expect(fs.existsSync(dirA)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discardEvidence removes the whole run dir on PASS', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-pass-'));
    try {
      const inspector = new SmokeInspector(
        {} as never,
        stubHdc(async () => {
          throw new Error('offline');
        }),
        root
      );
      const evidence = await inspector.collect({
        targetDeviceId: '127.0.0.1:5555',
        bundleName: 'com.example.app',
      });
      expect(runDirs(root)).toHaveLength(1);
      inspector.discardEvidence(evidence);
      expect(runDirs(root)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
