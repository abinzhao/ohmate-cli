/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Device-side screen recorder service identity (system app). */
export const RECORDER_BUNDLE = 'com.huawei.hmos.screenrecorder';
export const RECORDER_ABILITY =
  'com.huawei.hmos.screenrecorder.ServiceExtAbility';

/** Device-side staging directory for exported media before `hdc file recv`. */
export const DEVICE_STAGING_DIR = '/data/local/tmp';

/** Domain error: `code` is a stable telemetry-safe identifier. */
export class ScreenRecordError extends Error {
  constructor(
    public readonly code: string,
    message: string = code,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ScreenRecordError';
  }
}

/** Persisted CLI recording session (`record/<serialHex>.json`). */
export interface RecordingSession {
  /** Device-unique media display name, e.g. devecocli-<ts>-<rand4>.mp4. */
  fileName: string;
  /** AbilityRecord ID from `aa dump -e`; the session identity on device. */
  abilityRecordId: number;
  /** Start wall-clock time in ms. */
  startTime: number;
  /** Absolute local destination resolved at start. */
  localPath: string;
}

/** One recorder ability record observed in `aa dump -e`. */
export interface RecorderRecord {
  abilityRecordId: number;
  bundleName: string;
  abilityName: string;
  /** Device uptime (ms) when the record was created; absent in some dump formats. */
  startedAtMs?: number;
}

/** Classification of device state against the local registration. */
export interface RecordingSnapshot {
  status: 'recording' | 'busy' | 'idle';
  activeId?: number;
  session?: RecordingSession;
}

/** Public status result; `note` is only present for idle + interrupted. */
export type RecordingStatus =
  | { status: 'recording' }
  | { status: 'busy' }
  | { status: 'idle'; note?: string };

export interface StartedRecording {
  serial: string;
  session: RecordingSession;
}

export interface SavedRecording {
  kind: 'saved';
  localPath: string;
  warnings?: string[];
}

export type FinalizeResult =
  | SavedRecording
  | { kind: 'external-stopped' }
  | { kind: 'completed-elsewhere' };

export interface InteractiveHooks {
  onStarted(): void;
  /** Fires once when the user first requests a stop (Ctrl+C / terminating signal). */
  onStopRequested?(): void;
}
