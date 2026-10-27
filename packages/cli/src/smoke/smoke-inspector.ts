/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { yellow } from 'colorette';
import type { ToolProvider } from '../toolchain/index.js';
import type { HdcAdapter } from '../utils/hdc-adapter.js';
import { HilogAdapter } from '../utils/hilog-adapter.js';
import { ScreenshotCapturer } from '../ui/index.js';
import { debugLog } from '../utils/logger.js';
import { ScreenPhash } from './screen-phash.js';
import { SmokeRunStore } from './smoke-run-store.js';
import { smokeCrashLogName, smokeScreenshotName } from './smoke-artifacts.js';
import type { SmokeEvidence, SmokeExecuteContext } from './types.js';

const DEFAULT_WAIT_MS = 3000;

function resolveWaitMs(): number {
  const raw = process.env.DEVECO_CLI_SMOKE_WAIT_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_WAIT_MS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_WAIT_MS;
}

export class SmokeInspector {
  private readonly phash = new ScreenPhash();
  private readonly hilog: HilogAdapter;
  private readonly screenshots: ScreenshotCapturer;

  /** Current run's isolated evidence dir (owned exclusively by this run). */
  private runDir?: string;
  private runStore?: SmokeRunStore;

  constructor(
    toolProvider: ToolProvider,
    private readonly hdc: HdcAdapter,
    private readonly projectRoot: string
  ) {
    this.hilog = new HilogAdapter(toolProvider);
    this.screenshots = new ScreenshotCapturer(toolProvider);
  }

  public async collect(ctx: SmokeExecuteContext): Promise<SmokeEvidence> {
    this.openRun(ctx);
    const waitMs = resolveWaitMs();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    let alive: boolean;
    try {
      alive = await this.hdc.pidofBundle(ctx.targetDeviceId, ctx.bundleName);
    } catch (error) {
      // Transport failure is NOT process death: same conservative principle as screenshot failure (issue #453 §3) — warn + PASS, skip.
      console.warn(
        yellow(
          `Smoke: process check failed (${(error as Error).message}); smoke skipped.`
        )
      );
      return {
        processAlive: true,
        phashBlank: null,
        processCheckSkipped: true,
      };
    }
    if (!alive) {
      return {
        processAlive: false,
        phashBlank: null,
        crashLogPath: await this.writeCrashLogFile(ctx),
      };
    }

    return this.collectScreenshotEvidence(ctx);
  }

  /** Isolate this run's evidence in its own dir, then reclaim ended runs' leftovers. */
  private openRun(ctx: SmokeExecuteContext): void {
    const store = new SmokeRunStore(
      SmokeRunStore.resolveBaseDir(this.projectRoot, ctx.screenshotDir)
    );
    const runDir = store.createRun();
    store.prune(runDir);
    this.runStore = store;
    this.runDir = runDir;
  }

  private artifactPath(filename: string): string {
    return path.join(this.runDir ?? '', filename);
  }

  /**
   * PASS keeps no evidence (contract: evidence is for failures only); the run
   * dir itself is removed so nothing of this run remains.
   */
  public discardEvidence(evidence: SmokeEvidence): void {
    for (const artifactPath of [
      evidence.screenshotPath,
      evidence.crashLogPath,
    ]) {
      if (!artifactPath) {
        continue;
      }
      try {
        fs.rmSync(artifactPath, { force: true });
      } catch (error) {
        debugLog(
          `Smoke: discard artifact failed (${artifactPath}): ${(error as Error).message}`
        );
      }
    }
    if (this.runStore && this.runDir) {
      this.runStore.discard(this.runDir);
    }
  }

  /**
   * Mark this run as ended once its verdict is final: the marker goes away so
   * later runs may reclaim this dir (its evidence stays for FAIL retention).
   */
  public finalizeRun(): void {
    if (this.runStore && this.runDir) {
      this.runStore.finalize(this.runDir);
    }
  }

  private async collectScreenshotEvidence(
    ctx: SmokeExecuteContext
  ): Promise<SmokeEvidence> {
    const screenshotPath = this.artifactPath(smokeScreenshotName(Date.now()));

    try {
      await this.screenshots.captureToPath(ctx.targetDeviceId, screenshotPath);
    } catch (error) {
      return this.skipBlank(`screenshot failed (${(error as Error).message})`);
    }

    if (
      !fs.existsSync(screenshotPath) ||
      fs.statSync(screenshotPath).size <= 32
    ) {
      return this.skipBlank('screenshot file missing or empty');
    }

    const result = this.phash.analyzeFile(screenshotPath);
    if (!result) {
      return this.skipBlank('failed to analyze screenshot', screenshotPath);
    }

    return {
      processAlive: true,
      phashBlank: result.isBlank,
      phash: result.phash,
      phashHamming: result.hamming,
      screenshotPath,
    };
  }

  private skipBlank(reason: string, screenshotPath?: string): SmokeEvidence {
    console.warn(yellow(`Smoke: ${reason}; blank check skipped.`));
    return {
      processAlive: true,
      phashBlank: null,
      screenshotPath,
      screenshotSkipped: true,
    };
  }

  /** Persist confirmed crash content only; a missing crash file or query failure emits a standalone diagnostic warn instead of posing as crash_log evidence. */
  private async writeCrashLogFile(
    ctx: SmokeExecuteContext
  ): Promise<string | undefined> {
    let content: string | undefined;
    try {
      content = await this.hilog.getLatestCrashLog(
        ctx.targetDeviceId,
        ctx.bundleName
      );
    } catch (error) {
      console.warn(
        yellow(`Smoke: crash log query failed (${(error as Error).message}).`)
      );
      return undefined;
    }
    if (!content?.trim()) {
      console.warn(yellow('Smoke: no crash log found on device.'));
      return undefined;
    }

    try {
      const crashLogPath = this.artifactPath(smokeCrashLogName(Date.now()));
      fs.writeFileSync(crashLogPath, content, 'utf8');
      return crashLogPath;
    } catch (error) {
      console.warn(
        yellow(`Smoke: failed to save crash log (${(error as Error).message}).`)
      );
      return undefined;
    }
  }
}
