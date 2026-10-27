/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolProvider } from '../../toolchain/index.js';
import { getCliDataDir } from '../../utils/cli-data-dir.js';
import { resolveDeviceSerial } from '../../utils/device-selector.js';
import { debugLog } from '../../utils/logger.js';
import { DeviceManager } from '../../service/device-manager.js';
import { classifyRecording } from './ability-records.js';
import {
  decideAfterDiscard,
  decideExternalStop,
  decideFinalizeAction,
  decideSessionIdentity,
  decideStart,
  decideStartObservation,
  decideStatusSnapshot,
  decideStopEntry,
  decideStopObservation,
  foreignSettleUntil,
  type FinalizeMode,
  sessionSettleUntil,
  shouldForegroundFinalize,
} from './decisions.js';
import { FileLock, type LockLease } from './file-lock.js';
import { RecorderDevice } from './recorder-device.js';
import {
  assertDestinationAvailable,
  createReceiveDir,
  publishWithoutOverwrite,
  removeReceiveDir,
  resolveDestination,
  validateReceived,
} from './recording-files.js';
import { makeDeviceFileName, makeStagingPath } from './recording-paths.js';
import { RecordingStore } from './recording-store.js';
import { sameSession } from './session-identity.js';
import {
  ScreenRecordError,
  type FinalizeResult,
  type InteractiveHooks,
  type RecordingSession,
  type RecordingSnapshot,
  type RecordingStatus,
  type StartedRecording,
} from './types.js';

export interface ScreenRecordTiming {
  /** Total budget to confirm a start toggle (spec: 10 s). */
  startConfirmMs: number;
  /** Total budget for one stop: settle wait + toggle + disappearance. */
  stopConfirmMs: number;
  /**
   * Recording age required before a stop toggle is deliverable. Real devices
   * drop stop toggles sent within ~1.8 s of the start toggle (measured on a
   * Mate XT: the recorder service finishes its start-delay processing there);
   * an early toggle is lost silently and must never be re-sent.
   */
  stopReadyMs: number;
  /** Observation interval inside confirm loops. */
  observeIntervalMs: number;
  /** Foreground polling interval while waiting. */
  foregroundPollMs: number;
  /** Budget for the media library to expose the finished file. */
  mediaReadyMs: number;
  /** Backoff before the 4 s cap while waiting for the media entry. */
  mediaBackoffMs: number[];
  /** Export+recv attempts when the received MP4 is incomplete. */
  mediaRecvAttempts: number;
  /** Lock wait for one-shot commands. */
  lockWaitMs: number;
  /** Lock wait for the foreground finalizer (may queue behind a download). */
  interactiveLockWaitMs: number;
  /** Consecutive poll failures tolerated in the foreground loop. */
  foregroundFailureBudget: number;
}

const DEFAULT_TIMING: ScreenRecordTiming = {
  startConfirmMs: 10_000,
  // Real devices took 2-8 s to reflect a stop toggle; keep margin (the 10 s
  // spec budget applies to start confirmation only).
  stopConfirmMs: 15_000,
  stopReadyMs: 3_000,
  observeIntervalMs: 250,
  foregroundPollMs: 1_000,
  mediaReadyMs: 30_000,
  mediaBackoffMs: [250, 500, 1_000, 2_000],
  mediaRecvAttempts: 3,
  lockWaitMs: 60_000,
  interactiveLockWaitMs: 10 * 60_000,
  foregroundFailureBudget: 3,
};

const BACKOFF_CAP_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand4(): string {
  return randomBytes(2).toString('hex');
}

export interface ScreenRecordTarget {
  serial: string;
  name: string;
}

interface ResolvedDependencies {
  store: RecordingStore;
  lock: FileLock;
  device: RecorderDevice;
  timing: ScreenRecordTiming;
}

export interface ScreenRecordAdapterDeps {
  store?: RecordingStore;
  lock?: FileLock;
  device?: RecorderDevice;
  timing?: Partial<ScreenRecordTiming>;
}

interface StopRequest {
  requested: boolean;
  wake: () => void;
}

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Record a stop intent from catchable signals. Listeners are installed before
 * the device is touched so a signal during start-up is not lost; a normal
 * request only interrupts the wait, never an in-progress save.
 */
function bindStopSignals(
  stopRequest: StopRequest,
  onFirstRequest?: () => void
): () => void {
  const onSignal = (): void => {
    if (!stopRequest.requested) {
      stopRequest.requested = true;
      onFirstRequest?.();
      stopRequest.wake();
    }
  };
  for (const signal of STOP_SIGNALS) {
    process.on(signal, onSignal);
  }
  return () => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, onSignal);
    }
  };
}

/**
 * Orchestrates screen recording: shared start, foreground wait, shared
 * finalize, and read-only status. The device toggle is sent at most once per
 * decision and is always followed by observation. Registration remains until
 * the file is saved or a later start discards the interrupted registration.
 */
export class ScreenRecordAdapter {
  private readonly deps: ResolvedDependencies;

  constructor(
    private readonly toolProvider: ToolProvider,
    deps: ScreenRecordAdapterDeps = {}
  ) {
    const recordDir = path.join(getCliDataDir(), 'record');
    this.deps = {
      store: deps.store ?? new RecordingStore(recordDir),
      lock: deps.lock ?? new FileLock(recordDir),
      device: deps.device ?? new RecorderDevice(toolProvider.hdcPath),
      timing: { ...DEFAULT_TIMING, ...deps.timing },
    };
  }

  /** Start and register a recording, discarding any interrupted registration. */
  public async startDetached(
    deviceArg: string | undefined,
    pathArg: string | undefined
  ): Promise<StartedRecording> {
    const target = await this.resolveTarget(deviceArg);
    const destination = await resolveDestination(
      pathArg,
      target.name,
      new Date(),
      rand4()
    );
    return this.startSession(target, destination);
  }

  /** Foreground mode: shared start, wait without the lock, shared finalize. */
  public async recordInteractively(
    deviceArg: string | undefined,
    pathArg: string | undefined,
    hooks: InteractiveHooks
  ): Promise<FinalizeResult> {
    const wakeListeners = new Set<() => void>();
    const stopRequest: StopRequest = {
      requested: false,
      wake: () => {
        for (const listener of wakeListeners) {
          listener();
        }
      },
    };
    const releaseSignals = bindStopSignals(stopRequest, hooks.onStopRequested);
    try {
      const target = await this.resolveTarget(deviceArg);
      const destination = await resolveDestination(
        pathArg,
        target.name,
        new Date(),
        rand4()
      );
      const started = await this.startSession(target, destination);
      hooks.onStarted();
      return await this.waitForInteractiveCompletion(
        started,
        stopRequest,
        wakeListeners
      );
    } finally {
      releaseSignals();
    }
  }

  private async waitForInteractiveCompletion(
    started: StartedRecording,
    stopRequest: StopRequest,
    wakeListeners: Set<() => void>
  ): Promise<FinalizeResult> {
    let finalizePromise: Promise<FinalizeResult> | undefined;
    const finalizeOnce = (): Promise<FinalizeResult> => {
      finalizePromise ??= this.deps.lock.withDeviceLock(
        started.serial,
        (lease) =>
          this.finalizeLocked(
            started.serial,
            started.session,
            'interactive',
            lease
          ),
        this.deps.timing.interactiveLockWaitMs
      );
      return finalizePromise;
    };

    let failures = 0;
    for (;;) {
      if (stopRequest.requested) {
        return await finalizeOnce();
      }
      let snapshot: RecordingSnapshot;
      try {
        snapshot = await this.readSnapshot(started.serial);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= this.deps.timing.foregroundFailureBudget) {
          throw error;
        }
        await this.waitPoll(stopRequest, wakeListeners);
        continue;
      }
      // Another process owns the session lifecycle, or the device-side ID
      // disappeared: either way the shared finalize decides the outcome.
      if (shouldForegroundFinalize(snapshot, started.session)) {
        return await finalizeOnce();
      }
      await this.waitPoll(stopRequest, wakeListeners);
    }
  }

  /** Standalone stop: classify under the lock, then finalize or force-stop. */
  public async stopRecording(
    deviceArg: string | undefined,
    force: boolean
  ): Promise<FinalizeResult> {
    const target = await this.resolveTarget(deviceArg);
    return this.deps.lock.withDeviceLock(
      target.serial,
      async (lease) => {
        const snapshot = await this.readSnapshot(target.serial);
        const plan = decideStopEntry(snapshot, force);
        if (plan.plan === 'force-stop-external') {
          await this.stopExternal(target.serial, plan.activeId, lease);
          // A pre-existing registration is preserved for a later stop.
          return { kind: 'external-stopped' };
        }
        if (plan.plan === 'error') {
          throw plan.error;
        }
        return this.finalizeLocked(
          target.serial,
          plan.session,
          'stop-or-recover',
          lease
        );
      },
      this.deps.timing.lockWaitMs
    );
  }

  /** Lock-free read-only status; never repairs or deletes anything. */
  public async getRecordingStatus(
    deviceArg: string | undefined
  ): Promise<RecordingStatus> {
    const target = await this.resolveTarget(deviceArg);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.deps.store.read(target.serial);
      const records = await this.deps.device.observeOnce(target.serial);
      const after = await this.deps.store.read(target.serial);
      if (!sameSession(before, after)) {
        continue; // Registration moved mid-read; retry for a stable view.
      }
      const snapshot = classifyRecording(records, after);
      return decideStatusSnapshot(snapshot);
    }
    throw new ScreenRecordError(
      'STATE_CHANGING',
      'The recording session keeps changing; try again'
    );
  }

  private async resolveTarget(
    deviceArg: string | undefined
  ): Promise<ScreenRecordTarget> {
    // 判空先于 resolveDeviceSerial：共享选择器的无设备提示建议启动模拟器，录屏仅支持真机
    const entries = await DeviceManager.from(
      this.toolProvider
    ).getConnectedEntries();
    if (entries.length === 0) {
      throw new ScreenRecordError(
        'NO_ACTIVE_DEVICES',
        'No active devices found. Connect a physical device; screen recording does not support emulators.'
      );
    }
    const serial = await resolveDeviceSerial(this.toolProvider, deviceArg);
    const entry = entries.find((item) => item.serial === serial);
    if (entry?.isEmulator) {
      throw new ScreenRecordError(
        'EMULATOR_NOT_SUPPORTED',
        'Screen recording is only supported on physical devices'
      );
    }
    return { serial, name: entry?.name ?? serial };
  }

  private async readSnapshot(serial: string): Promise<RecordingSnapshot> {
    const session = await this.deps.store.read(serial);
    const records = await this.deps.device.observeOnce(serial);
    return classifyRecording(records, session);
  }

  private async startSession(
    target: ScreenRecordTarget,
    destination: string
  ): Promise<StartedRecording> {
    return this.deps.lock.withDeviceLock(
      target.serial,
      (lease) => this.startSessionLocked(target, destination, lease),
      this.deps.timing.lockWaitMs
    );
  }

  private async startSessionLocked(
    target: ScreenRecordTarget,
    destination: string,
    lease: LockLease
  ): Promise<StartedRecording> {
    const snapshot = await this.readSnapshot(target.serial);
    const startPlan = decideStart(snapshot);
    if (startPlan.plan === 'error') {
      throw startPlan.error;
    }

    if (startPlan.plan === 'discard-first') {
      await this.deps.store.deleteIfSame(
        target.serial,
        startPlan.session,
        lease
      );
      const afterDiscard = await this.readSnapshot(target.serial);
      const retryPlan = decideAfterDiscard(afterDiscard);
      if (retryPlan.plan === 'error') {
        throw retryPlan.error;
      }
    }
    return this.toggleAndRegister(target, destination, lease);
  }

  /** Precheck passed: toggle once, confirm the ID, register the session. */
  private async toggleAndRegister(
    target: ScreenRecordTarget,
    destination: string,
    lease: LockLease
  ): Promise<StartedRecording> {
    await assertDestinationAvailable(destination);
    const fileName = makeDeviceFileName(new Date(), rand4());
    const startTime = Date.now();
    const deadline = Date.now() + this.deps.timing.startConfirmMs;
    await lease.assertOwned();
    await this.deps.device.toggleOnce(
      target.serial,
      fileName,
      lease,
      Math.max(1, deadline - Date.now())
    );
    const record = await this.waitForStarted(target.serial, deadline);
    const session: RecordingSession = {
      fileName,
      abilityRecordId: record.abilityRecordId,
      startTime,
      localPath: destination,
    };
    await this.registerSession(target.serial, session, lease);
    return { serial: target.serial, session };
  }

  /** Persist a confirmed session; on failure undo the device-side start. */
  private async registerSession(
    serial: string,
    session: RecordingSession,
    lease: LockLease
  ): Promise<void> {
    try {
      await this.deps.store.createAtomic(serial, session, lease);
    } catch (error) {
      await this.abortUnregistered(serial, session, lease);
      throw new ScreenRecordError(
        (error as ScreenRecordError).code ?? 'SESSION_PUBLISH_FAILED',
        `Recording started on device (file ${session.fileName}) but could not be registered: ${(error as Error).message}. Check the device gallery.`,
        { cause: error }
      );
    }
  }

  /**
   * Run one budgeted device query inside a confirmation loop. A query killed
   * by its own remaining budget at the deadline maps to the loop's timeout
   * error; failures before the deadline surface unchanged.
   */
  private async withinDeadline<T>(
    deadline: number,
    timedOut: ScreenRecordError,
    query: (timeoutMs: number) => Promise<T>
  ): Promise<T> {
    try {
      return await query(Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (Date.now() >= deadline) {
        throw timedOut;
      }
      throw error;
    }
  }

  private async waitForStarted(serial: string, deadline: number) {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ScreenRecordError(
          'START_CONFIRM_TIMEOUT',
          'Device screen may be locked'
        );
      }
      const records = await this.withinDeadline(
        deadline,
        new ScreenRecordError(
          'START_CONFIRM_TIMEOUT',
          'Device screen may be locked'
        ),
        (timeoutMs) => this.deps.device.observeOnce(serial, timeoutMs)
      );
      const observation = decideStartObservation(records);
      if (observation.outcome === 'error') {
        throw observation.error;
      }
      if (observation.outcome === 'confirmed') {
        if (Date.now() > deadline) {
          // 10 秒总预算覆盖确认;超时后才返回的观测不能算预算内成功。
          throw new ScreenRecordError(
            'START_CONFIRM_TIMEOUT',
            'Device screen may be locked'
          );
        }
        return observation.record;
      }
      await sleep(Math.min(this.deps.timing.observeIntervalMs, remaining));
    }
  }

  /**
   * One bounded observation inside a stop confirmation: the unique record
   * must still be the expected one. Returns undefined once it is gone.
   */
  private async observeActiveId(
    serial: string,
    expectedId: number,
    timeoutMs?: number
  ): Promise<number | undefined> {
    const records = await this.deps.device.observeOnce(serial, timeoutMs);
    const observation = decideStopObservation(records, expectedId);
    if (observation.outcome === 'error') {
      throw observation.error;
    }
    return observation.outcome === 'gone' ? undefined : observation.activeId;
  }

  private async waitForStopped(
    serial: string,
    oldId: number,
    deadline: number
  ): Promise<void> {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ScreenRecordError(
          'STOP_CONFIRM_TIMEOUT',
          'The recording did not stop in time; session kept, no re-toggle sent'
        );
      }
      const activeId = await this.withinDeadline(
        deadline,
        new ScreenRecordError(
          'STOP_CONFIRM_TIMEOUT',
          'The recording did not stop in time; session kept, no re-toggle sent'
        ),
        (timeoutMs) => this.observeActiveId(serial, oldId, timeoutMs)
      );
      if (activeId === undefined) {
        return;
      }
      await sleep(Math.min(this.deps.timing.observeIntervalMs, remaining));
    }
  }

  /**
   * Wait until the recording is old enough for a stop toggle to be
   * deliverable. Real devices silently drop stop toggles sent during their
   * start-delay window; waiting costs nothing and keeps the single-toggle
   * protocol intact. Re-observes so a recording that ends on its own during
   * the wait skips the toggle, and a replaced recording surfaces as an error.
   */
  private async awaitStopReady(
    serial: string,
    expectedId: number,
    settleUntil: number,
    deadline: number
  ): Promise<'ready' | 'vanished'> {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ScreenRecordError(
          'STOP_CONFIRM_TIMEOUT',
          'The recording did not stop in time; session kept, no re-toggle sent'
        );
      }
      const activeId = await this.withinDeadline(
        deadline,
        new ScreenRecordError(
          'STOP_CONFIRM_TIMEOUT',
          'The recording did not stop in time; session kept, no re-toggle sent'
        ),
        (timeoutMs) => this.observeActiveId(serial, expectedId, timeoutMs)
      );
      if (activeId === undefined) {
        return 'vanished';
      }
      if (Date.now() >= settleUntil) {
        if (Date.now() > deadline) {
          throw new ScreenRecordError(
            'STOP_CONFIRM_TIMEOUT',
            'The recording did not stop in time; session kept, no re-toggle sent'
          );
        }
        return 'ready';
      }
      await sleep(
        Math.min(
          this.deps.timing.observeIntervalMs,
          settleUntil - Date.now(),
          remaining
        )
      );
    }
  }

  /** Best-effort stop for a confirmed-but-unregistered start failure. */
  private async abortUnregistered(
    serial: string,
    session: RecordingSession,
    lease: LockLease
  ): Promise<void> {
    try {
      const stopDeadline = Date.now() + this.deps.timing.stopConfirmMs;
      const settleUntil = sessionSettleUntil(
        session,
        this.deps.timing.stopReadyMs
      );
      const ready = await this.awaitStopReady(
        serial,
        session.abilityRecordId,
        settleUntil,
        stopDeadline
      );
      if (ready === 'ready') {
        await this.deps.device.toggleOnce(
          serial,
          undefined,
          lease,
          Math.max(1, stopDeadline - Date.now())
        );
      }
    } catch (error) {
      debugLog(
        `abortUnregistered: best-effort stop failed: ${(error as Error).message}`
      );
    }
  }

  /** Shared finalize; must run inside the device lock. */
  private async finalizeLocked(
    serial: string,
    expected: RecordingSession,
    mode: FinalizeMode,
    lease: LockLease
  ): Promise<FinalizeResult> {
    const current = await this.deps.store.read(serial);
    const identity = decideSessionIdentity(current, expected, mode);
    if (identity.plan === 'completed-elsewhere') {
      return { kind: 'completed-elsewhere' };
    }
    if (identity.plan === 'error') {
      throw identity.error;
    }

    const snapshot = await this.readSnapshot(serial);
    const action = decideFinalizeAction(snapshot);
    if (action.plan === 'error') {
      throw action.error;
    }
    if (action.plan === 'stop-recording') {
      const stopDeadline = Date.now() + this.deps.timing.stopConfirmMs;
      return this.stopLiveRecording(serial, expected, lease, stopDeadline);
    }
    // Idle path never toggles: straight to the exact-name retrieval.
    return this.retrieveAndPublish(serial, expected, lease);
  }

  /** Confirmed-recording branch: settle gate, one toggle, disappearance. */
  private async stopLiveRecording(
    serial: string,
    expected: RecordingSession,
    lease: LockLease,
    stopDeadline: number
  ): Promise<FinalizeResult> {
    const settleUntil = sessionSettleUntil(
      expected,
      this.deps.timing.stopReadyMs
    );
    const ready = await this.awaitStopReady(
      serial,
      expected.abilityRecordId,
      settleUntil,
      stopDeadline
    );
    if (ready === 'vanished') {
      // The recording already ended on the device during the settle wait;
      // skip the toggle and go straight to retrieval.
      return this.retrieveAndPublish(serial, expected, lease);
    }
    await lease.assertOwned();
    await this.deps.device.toggleOnce(
      serial,
      undefined,
      lease,
      Math.max(1, stopDeadline - Date.now())
    );
    await this.waitForStopped(serial, expected.abilityRecordId, stopDeadline);
    return this.retrieveAndPublish(serial, expected, lease);
  }

  private async stopExternal(
    serial: string,
    activeId: number | undefined,
    lease: LockLease
  ): Promise<void> {
    // Re-confirm immediately before the toggle: state may have changed.
    const records = await this.deps.device.observeOnce(serial);
    const plan = decideExternalStop(records, activeId);
    if (plan.plan === 'already-stopped') {
      return; // Already stopped elsewhere; nothing to do.
    }
    if (plan.plan === 'error') {
      throw plan.error;
    }
    const stopDeadline = Date.now() + this.deps.timing.stopConfirmMs;
    // Without a start time in the dump format there is no age to gate on;
    // toggle as before.
    if (
      plan.startedAtMs !== undefined &&
      !(await this.awaitForeignStopReady(
        serial,
        plan.currentId,
        plan.startedAtMs,
        stopDeadline
      ))
    ) {
      return; // It ended on its own during the settle wait.
    }
    await lease.assertOwned();
    await this.deps.device.toggleOnce(
      serial,
      undefined,
      lease,
      Math.max(1, stopDeadline - Date.now())
    );
    await this.waitForStopped(serial, plan.currentId, stopDeadline);
  }

  /**
   * Settle gate for a foreign recording: its age is only knowable device-side
   * (uptime minus the record's own start time). Returns false when the
   * recording ends on its own during the wait.
   */
  private async awaitForeignStopReady(
    serial: string,
    currentId: number,
    startedAtMs: number,
    stopDeadline: number
  ): Promise<boolean> {
    const uptimeMs = await this.withinDeadline(
      stopDeadline,
      new ScreenRecordError(
        'STOP_CONFIRM_TIMEOUT',
        'The recording did not stop in time; session kept, no re-toggle sent'
      ),
      (timeoutMs) => this.deps.device.readUptimeMs(serial, timeoutMs)
    );
    const settleUntil = foreignSettleUntil(
      uptimeMs - startedAtMs,
      this.deps.timing.stopReadyMs,
      Date.now()
    );
    const ready = await this.awaitStopReady(
      serial,
      currentId,
      settleUntil,
      stopDeadline
    );
    return ready === 'ready';
  }

  private async retrieveAndPublish(
    serial: string,
    expected: RecordingSession,
    lease: LockLease
  ): Promise<FinalizeResult> {
    const warnings: string[] = [];
    const mediaUri = await this.waitForMediaUri(serial, expected.fileName);
    const receiveDir = await createReceiveDir(expected.localPath);
    try {
      const receivedPath = await this.receiveUntilValid(
        serial,
        mediaUri,
        expected,
        receiveDir,
        lease,
        warnings
      );
      await lease.assertOwned();
      const localPath = await publishWithoutOverwrite(
        receivedPath,
        expected.localPath
      );
      await this.deleteSessionAfterSave(serial, expected, lease, localPath);
      return { kind: 'saved', localPath, warnings };
    } finally {
      await removeReceiveDir(receiveDir, expected.localPath);
    }
  }

  /** Bounded backoff while the media library finishes writing the file. */
  private async waitForMediaUri(
    serial: string,
    fileName: string
  ): Promise<string> {
    const mediaDeadline = Date.now() + this.deps.timing.mediaReadyMs;
    let backoffIndex = 0;
    for (;;) {
      const remaining = mediaDeadline - Date.now();
      if (remaining <= 0) {
        throw new ScreenRecordError(
          'MEDIA_NOT_READY',
          `Timed out waiting for ${fileName} in the media library; session kept for a later stop`
        );
      }
      const mediaUri = await this.withinDeadline(
        mediaDeadline,
        new ScreenRecordError(
          'MEDIA_NOT_READY',
          `Timed out waiting for ${fileName} in the media library; session kept for a later stop`
        ),
        (timeoutMs) =>
          this.deps.device.queryMediaUri(serial, fileName, timeoutMs)
      );
      if (mediaUri && Date.now() <= mediaDeadline) {
        return mediaUri;
      }
      const backoff = Math.min(
        this.deps.timing.mediaBackoffMs[
          Math.min(backoffIndex, this.deps.timing.mediaBackoffMs.length - 1)
        ] ?? BACKOFF_CAP_MS,
        BACKOFF_CAP_MS,
        remaining
      );
      backoffIndex += 1;
      await sleep(backoff);
    }
  }

  /** Export + pull + validate; incomplete MP4s get bounded re-exports. */
  private async receiveUntilValid(
    serial: string,
    mediaUri: string,
    expected: RecordingSession,
    receiveDir: string,
    lease: LockLease,
    warnings: string[]
  ): Promise<string> {
    for (
      let attempt = 0;
      attempt < this.deps.timing.mediaRecvAttempts;
      attempt++
    ) {
      await lease.assertOwned();
      const stagingPath = makeStagingPath(expected.fileName, rand4());
      const localTemp = await this.receiveOnce(
        serial,
        mediaUri,
        stagingPath,
        receiveDir,
        expected.fileName,
        lease,
        warnings
      );
      try {
        await validateReceived(localTemp);
        return localTemp;
      } catch (error) {
        if ((error as ScreenRecordError).code !== 'MEDIA_NOT_READY') {
          throw error;
        }
        debugLog(
          `Received file incomplete (attempt ${attempt + 1}); retrying export`
        );
        await sleep(this.deps.timing.mediaBackoffMs[0] ?? 250);
      }
    }
    throw new ScreenRecordError(
      'MEDIA_NOT_READY',
      `Received file for ${expected.fileName} is incomplete after ${this.deps.timing.mediaRecvAttempts} attempts; session kept`
    );
  }

  /** One export → recv cycle; staging cleanup runs for every failure stage. */
  private async receiveOnce(
    serial: string,
    mediaUri: string,
    stagingPath: string,
    receiveDir: string,
    fileName: string,
    lease: LockLease,
    warnings: string[]
  ): Promise<string> {
    const localTemp = path.join(receiveDir, fileName);
    try {
      await this.deps.device.exportToStaging(serial, mediaUri, stagingPath);
      await this.deps.device.receiveFile(
        serial,
        stagingPath,
        localTemp,
        lease.signal
      );
    } finally {
      const removed = await this.deps.device.removeStaging(serial, stagingPath);
      if (!removed) {
        warnings.push(`Failed to remove device staging file: ${stagingPath}`);
      }
    }
    return localTemp;
  }

  /** A delete failure after a successful save reports the saved path. */
  private async deleteSessionAfterSave(
    serial: string,
    expected: RecordingSession,
    lease: LockLease,
    localPath: string
  ): Promise<void> {
    try {
      await this.deps.store.deleteIfSame(serial, expected, lease);
    } catch (error) {
      throw new ScreenRecordError(
        (error as ScreenRecordError).code ?? 'SESSION_DELETE_FAILED',
        `Recording saved to ${localPath}, but the session record could not be removed: ${(error as Error).message}. A later stop may create a recovered copy.`,
        { cause: error }
      );
    }
  }

  private async waitPoll(
    stopRequest: StopRequest,
    wakeListeners: Set<() => void>
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeListeners.delete(wake);
        resolve();
      }, this.deps.timing.foregroundPollMs);
      const wake = (): void => {
        wakeListeners.delete(wake);
        clearTimeout(timer);
        resolve();
      };
      wakeListeners.add(wake);
    });
  }
}
