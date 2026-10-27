/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { debugLog } from '../utils/logger.js';
import {
  ENDED_MARKER_FILE,
  RUNNING_MARKER_FILE,
  isRunReclaimable,
  isSmokeArtifact,
  isSmokeRunDir,
  parseRunMarker,
  smokeRunDirName,
  type RunMarker,
  type RunMarkerKind,
} from './smoke-artifacts.js';

/** Directory holding the isolated per-run evidence dirs. */
const RUNS_DIR_NAME = 'smoke';

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: process exists but belongs to another user — treat as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Per-run evidence isolation for the post-launch smoke check.
 *
 * Each run owns a private dir `<base>/smoke/run-<ts>-<pid>-<nonce>/` holding
 * its screenshot / crash log plus a marker file: `RUNNING` while in flight,
 * `ENDED` (with endedAt) once its verdict is final. Smoke runs outside the
 * build lock (`--skip-build` reaches it directly), so two devices deploying
 * the same project can check concurrently; a run may only reclaim dirs whose
 * owner has ENDED **and** whose evidence retention window (EVIDENCE_RETENTION_MS)
 * has passed — an in-flight run's evidence is never touched (issue #453 race),
 * and failed evidence stays readable for the retention window.
 */
export class SmokeRunStore {
  private readonly runsRoot: string;

  constructor(
    private readonly baseDir: string,
    private readonly isPidAlive: (pid: number) => boolean = defaultIsPidAlive
  ) {
    this.runsRoot = path.join(baseDir, RUNS_DIR_NAME);
  }

  /** Evidence base dir: explicit override or the project's `.hvigor/`. */
  public static resolveBaseDir(
    projectRoot: string,
    screenshotDir?: string
  ): string {
    return screenshotDir ?? path.join(projectRoot, '.hvigor');
  }

  /** Create this run's isolated dir with a RUNNING ownership marker. */
  public createRun(): string {
    const runDir = path.join(
      this.runsRoot,
      smokeRunDirName(Date.now(), process.pid, randomUUID().slice(0, 4))
    );
    fs.mkdirSync(runDir, { recursive: true });
    const marker: RunMarker = { pid: process.pid, startedAt: Date.now() };
    fs.writeFileSync(
      path.join(runDir, RUNNING_MARKER_FILE),
      JSON.stringify(marker),
      'utf8'
    );
    return runDir;
  }

  /**
   * Reclaim reclaimable dirs:
   * - legacy flat artifacts directly under baseDir (pre-isolation layout);
   * - other run dirs whose owner crashed/stuck (RUNNING, dead pid or past
   *   RUN_STALE_MS) or whose ENDED evidence retention window has passed.
   * Never touches `ownRunDir` or another in-flight run's evidence.
   */
  public prune(ownRunDir: string, now: number = Date.now()): void {
    this.pruneLegacyFlatArtifacts();
    this.pruneEndedRuns(ownRunDir, now);
  }

  /**
   * Run ended with its verdict final: record ENDED (starting the evidence
   * retention window), then drop RUNNING. ENDED takes precedence while both
   * exist, so there is no marker-less intermediate state.
   */
  public finalize(runDir: string): void {
    try {
      const running = this.readMarker(runDir, RUNNING_MARKER_FILE);
      const marker: RunMarker = {
        pid: running?.pid ?? process.pid,
        startedAt: running?.startedAt ?? Date.now(),
        endedAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(runDir, ENDED_MARKER_FILE),
        JSON.stringify(marker),
        'utf8'
      );
      fs.rmSync(path.join(runDir, RUNNING_MARKER_FILE), { force: true });
    } catch (error) {
      debugLog(
        `Smoke: finalize run failed (${runDir}): ${(error as Error).message}`
      );
    }
  }

  /** Run ended in PASS: evidence contract says keep nothing. */
  public discard(runDir: string): void {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch (error) {
      debugLog(
        `Smoke: discard run failed (${runDir}): ${(error as Error).message}`
      );
    }
  }

  private pruneLegacyFlatArtifacts(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return; // base dir missing → no legacy evidence
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isSmokeArtifact(entry.name)) {
        continue;
      }
      this.removeQuietly(path.join(this.baseDir, entry.name));
    }
  }

  private pruneEndedRuns(ownRunDir: string, now: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.runsRoot, { withFileTypes: true });
    } catch {
      return; // runs root missing → nothing to reclaim
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSmokeRunDir(entry.name)) {
        continue;
      }
      const dir = path.join(this.runsRoot, entry.name);
      if (path.resolve(dir) === path.resolve(ownRunDir)) {
        continue; // never my own in-flight dir
      }
      const state = this.readMarkerState(dir);
      if (
        !isRunReclaimable(state.kind, state.marker, {
          now,
          isPidAlive: this.isPidAlive,
        })
      ) {
        continue; // in-flight run, or evidence inside its retention window
      }
      this.removeQuietly(dir);
    }
  }

  /** ENDED wins over RUNNING (finalize writes ENDED before removing RUNNING). */
  private readMarkerState(runDir: string): {
    kind: RunMarkerKind | null;
    marker: RunMarker | null;
  } {
    const ended = this.readMarker(runDir, ENDED_MARKER_FILE);
    if (ended !== undefined) {
      return { kind: 'ended', marker: ended };
    }
    const running = this.readMarker(runDir, RUNNING_MARKER_FILE);
    if (running !== undefined) {
      return { kind: 'running', marker: running };
    }
    return { kind: null, marker: null }; // legacy or corrupt dir
  }

  /** Read one marker file; undefined when the file is absent. */
  private readMarker(
    runDir: string,
    file: string
  ): RunMarker | null | undefined {
    try {
      return parseRunMarker(fs.readFileSync(path.join(runDir, file), 'utf8'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined; // file absent
      }
      return null; // unreadable → corrupt marker
    }
  }

  private removeQuietly(target: string): void {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      debugLog(
        `Smoke: prune artifact failed (${target}): ${(error as Error).message}`
      );
    }
  }
}
