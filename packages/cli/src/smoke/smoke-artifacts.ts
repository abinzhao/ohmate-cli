/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
const SCREENSHOT_RE = /^smoke-screenshot-\d+\.png$/;
const CRASH_LOG_RE = /^smoke-crash-\d+\.log$/;
const RUN_DIR_RE = /^run-\d+-\d+-[0-9a-f]{4}$/;

/** Files from the pre-isolation layout, written directly under `.hvigor/`. */
export function smokeScreenshotName(tsMs: number): string {
  return `smoke-screenshot-${tsMs}.png`;
}

export function smokeCrashLogName(tsMs: number): string {
  return `smoke-crash-${tsMs}.log`;
}

/** Whether the name is a smoke evidence artifact: matches only the two name shapes this module generates, never other .hvigor files. */
export function isSmokeArtifact(name: string): boolean {
  return SCREENSHOT_RE.test(name) || CRASH_LOG_RE.test(name);
}

/** Marker file inside a run dir while its run is still in flight. */
export const RUNNING_MARKER_FILE = 'RUNNING';

/** Marker file written when the run's verdict is final (starts the evidence retention window). */
export const ENDED_MARKER_FILE = 'ENDED';

/**
 * How long a finished failed run's evidence (crash log / screenshot) is
 * guaranteed to survive after the run ended: agents may read the printed
 * evidence paths any time inside this window; the first run AFTER the window
 * reclaims the dir (lazy — there is no background GC).
 */
export const EVIDENCE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A RUNNING run dir older than this is reclaimed even if its marker claims a
 * live owner (stuck process or recycled pid). Generously above any legitimate
 * smoke duration (including a suspended machine).
 */
export const RUN_STALE_MS = 24 * 60 * 60 * 1000;

/** Run dir name: `run-<tsMs>-<pid>-<nonce>` under `<base>/smoke/`. */
export function smokeRunDirName(
  tsMs: number,
  pid: number,
  nonce: string
): string {
  return `run-${tsMs}-${pid}-${nonce}`;
}

export function isSmokeRunDir(name: string): boolean {
  return RUN_DIR_RE.test(name);
}

export interface RunMarker {
  pid: number;
  startedAt: number;
  endedAt?: number;
}

export type RunMarkerKind = 'running' | 'ended';

/** Parse a RUNNING/ENDED marker; null when unreadable or malformed. */
export function parseRunMarker(raw: string): RunMarker | null {
  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      startedAt?: unknown;
      endedAt?: unknown;
    };
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      !Number.isFinite(parsed.pid) ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return null;
    }
    const marker: RunMarker = { pid: parsed.pid, startedAt: parsed.startedAt };
    if (typeof parsed.endedAt === 'number' && Number.isFinite(parsed.endedAt)) {
      marker.endedAt = parsed.endedAt;
    }
    return marker;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Whether a run dir may be reclaimed by a later run:
 * - in-flight (RUNNING, live owner, fresh) → never (issue #453 prune race);
 * - finished failed evidence (ENDED) → only past EVIDENCE_RETENTION_MS;
 * - no marker (legacy/corrupt dir) or crashed/stuck owner → yes.
 */
export function isRunReclaimable(
  kind: RunMarkerKind | null,
  marker: RunMarker | null,
  opts: { now: number; isPidAlive: (pid: number) => boolean }
): boolean {
  if (kind === null) {
    return true; // no marker: legacy or corrupt dir
  }
  if (kind === 'ended') {
    if (marker?.endedAt === undefined) {
      return true; // corrupt ENDED marker — no trustworthy endedAt
    }
    return opts.now - marker.endedAt >= EVIDENCE_RETENTION_MS;
  }
  if (!marker) {
    return true; // corrupt RUNNING marker
  }
  if (!Number.isInteger(marker.pid) || marker.pid <= 0) {
    return true;
  }
  if (opts.now - marker.startedAt >= RUN_STALE_MS) {
    return true; // stale: stuck run or recycled pid
  }
  return !opts.isPidAlive(marker.pid); // owner process gone (crashed run)
}
