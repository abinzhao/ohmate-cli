/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { jsLeakWatcher } from '@kit.PerformanceAnalysisKit';
import { bundleManager } from '@kit.AbilityKit';
import { deviceInfo, systemDateTime } from '@kit.BasicServicesKit';
import { process } from '@kit.ArkTS';

export interface LeakReview {
  revision: number;
  mode: string;
  expiresAt: number;
  writesRawFiles: boolean;
}

export interface LeakStatus {
  phase: string;
  mode: string;
  owned: boolean;
  clockValid: boolean;
  deadline: number;
  watched: number;
  watchAttempts: number;
  checks: number;
  checkStatus: string;
  callbacks: number;
  dropped: number;
  filePairReported: boolean;
  rawFiles: string;
}

// This owner stays on the application main VM. Passing objects to TaskPool
// would inspect a different object/VM and must not stand in for host monitoring.
export class LeakWatcherHost {
  private static owner: LeakWatcherHost | undefined = undefined;
  private permitted: boolean = false;
  private phase: string = 'closed';
  private mode: string = '';
  private revision: number = 0;
  private reviewDeadline: number = 0;
  private deadline: number = 0;
  private clockValid: boolean = true;
  private lastTime: number = -1;
  private tid: number = 0;
  private owned: boolean = false;
  private acquiring: boolean = false;
  private clearing: boolean = false;
  private generation: number = 0;
  private timer: number = -1;
  private watched: number = 0;
  private watchAttempts: number = 0;
  private checks: number = 0;
  private lastCheck: number = -1;
  private checkStatus: string = 'not-run';
  private callbacks: number = 0;
  private dropped: number = 0;
  private filePairReported: boolean = false;
  private rawFiles: string = 'none-requested';

  // Host code grants exclusive use of this VM's jsLeakWatcher APIs. This does
  // not discover, take over or certify a preexisting application watcher.
  configure(exclusive: boolean): void {
    this.permitted = exclusive === true;
    if (!this.permitted && this.phase !== 'cleanup-failed') { this.stop(); }
  }

  get status(): LeakStatus {
    this.observe();
    return { phase: this.phase, mode: this.mode, owned: this.owned, clockValid: this.clockValid,
      deadline: this.deadline, watched: this.watched, watchAttempts: this.watchAttempts,
      checks: this.checks, checkStatus: this.checkStatus, callbacks: this.callbacks,
      dropped: this.dropped, filePairReported: this.filePairReported, rawFiles: this.rawFiles };
  }

  review(mode: string): LeakReview {
    const now = this.observe();
    if (this.owned || LeakWatcherHost.owner !== undefined) { throw new Error('LEAK_BUSY'); }
    if (!this.permitted || !this.clockValid || !this.available() ||
      now > Number.MAX_SAFE_INTEGER - 600000) { throw new Error('LEAK_UNAVAILABLE'); }
    if (mode !== 'objects' && mode !== 'components') { throw new Error('LEAK_MODE_INVALID'); }
    if (this.revision >= 256) { throw new Error('LEAK_REVIEW_LIMIT'); }
    this.revision++;
    this.mode = mode;
    this.reviewDeadline = now + 30000;
    this.phase = 'review';
    return { revision: this.revision, mode: this.mode, expiresAt: this.reviewDeadline,
      writesRawFiles: mode === 'components' };
  }

  confirm(revision: number, allowRawFiles: boolean): void {
    this.observe();
    if (this.phase !== 'review' || revision !== this.revision) { throw new Error('LEAK_CONSENT_REQUIRED'); }
    if (this.mode === 'components' && allowRawFiles !== true) { throw new Error('LEAK_RAW_FILE_CONSENT_REQUIRED'); }
    this.phase = 'confirmed';
  }

  start(revision: number): void {
    const now = this.observe();
    if (this.phase !== 'confirmed' || revision !== this.revision) { throw new Error('LEAK_CONSENT_REQUIRED'); }
    if (LeakWatcherHost.owner !== undefined) { throw new Error('LEAK_BUSY'); }
    this.tid = process.tid;
    this.deadline = now + 600000;
    this.owned = true;
    this.acquiring = true;
    LeakWatcherHost.owner = this;
    this.phase = 'starting';
    const generation = ++this.generation;
    let failed = false;
    try {
      if (this.mode === 'objects') {
        jsLeakWatcher.enable(true);
      } else {
        this.rawFiles = 'may-exist';
        jsLeakWatcher.enableLeakWatcher(true, this.componentConfig(), (paths: Array<string>): void => {
          this.receive(generation, paths);
        });
      }
    } catch (_) {
      failed = true;
    }
    this.acquiring = false;
    if (failed || generation !== this.generation || this.phase !== 'starting') {
      this.stop();
      if (failed) { throw new Error('LEAK_START_FAILED'); }
      return;
    }
    this.phase = 'active';
    this.observe();
    if (this.phase === 'active') {
      this.timer = setInterval((): void => { this.observe(); }, 1000);
    }
  }

  watch(object: object): void {
    this.requireObjects();
    if (object === null || typeof object !== 'object') { throw new Error('LEAK_OBJECT_INVALID'); }
    if (this.watchAttempts >= 32) { throw new Error('LEAK_WATCH_LIMIT'); }
    this.watchAttempts++;
    try {
      jsLeakWatcher.watch(object, 'OHMateObject');
    } catch (_) {
      throw new Error('LEAK_WATCH_FAILED');
    }
    this.watched++;
    this.observe();
  }

  check(): void {
    const now = this.requireObjects();
    if (this.checks >= 3) { throw new Error('LEAK_CHECK_LIMIT'); }
    if (this.lastCheck >= 0 && now - this.lastCheck < 90000) { throw new Error('LEAK_CHECK_RATE'); }
    this.checks++;
    this.lastCheck = now;
    this.checkStatus = 'empty-or-failed';
    let result: string;
    try { result = jsLeakWatcher.check(); } catch (_) { throw new Error('LEAK_CHECK_FAILED'); }
    if (typeof result !== 'string' || result.length > 16384) { throw new Error('LEAK_CHECK_INVALID'); }
    this.observe();
    if (this.phase === 'active' && result.length > 0) { this.checkStatus = 'returned-nonempty'; }
    // Do not parse names, IDs or paths, or retain the raw list. Nonempty is
    // only an API return observation and never a confirmed leak diagnosis.
  }

  stop(): void {
    this.generation++;
    this.phase = 'closed';
    this.callbacks = 0;
    this.dropped = 0;
    this.filePairReported = false;
    this.checkStatus = 'not-run';
    this.clearTimer();
    if (!this.owned || this.acquiring || this.clearing) { return; }
    // Calling a VM API on a different thread cannot release the original VM.
    if (process.tid !== this.tid) { this.phase = 'cleanup-failed'; return; }
    this.clearing = true;
    try {
      if (this.mode === 'objects') { jsLeakWatcher.enable(false); }
      else { jsLeakWatcher.enableLeakWatcher(false, this.componentConfig(), (_paths: Array<string>): void => {}); }
    } catch (_) {
      this.phase = 'cleanup-failed';
      return;
    } finally {
      this.clearing = false;
    }
    this.owned = false;
    if (LeakWatcherHost.owner === this) { LeakWatcherHost.owner = undefined; }
  }

  private componentConfig(): jsLeakWatcher.LeakWatcherConfig {
    return { monitorObjectTypes: jsLeakWatcher.MonitorObjectType.CUSTOM_COMPONENT,
      checkInterval: 90000, fgLeakCountThreshold: 5, bgLeakCountThreshold: 1,
      maxStoredHeapDumps: 1, dumpHeapWaitTimeMs: 5000 };
  }

  private receive(generation: number, paths: Array<string>): void {
    this.observe();
    if (this.acquiring || !this.owned || this.phase !== 'active' || generation !== this.generation) { return; }
    if (this.callbacks >= 32 || !Array.isArray(paths) || paths.length !== 2) {
      this.dropped = Math.min(1000000, this.dropped + 1);
      return;
    }
    this.callbacks++;
    this.filePairReported = true;
  }

  private requireObjects(): number {
    const now = this.observe();
    if (this.phase !== 'active') { throw new Error('LEAK_CONSENT_REQUIRED'); }
    if (this.mode !== 'objects') { throw new Error('LEAK_MODE_INVALID'); }
    return now;
  }

  private available(): boolean {
    try {
      if (!canIUse('SystemCapability.HiviewDFX.HiChecker') ||
        !canIUse('SystemCapability.Utils.Lang') || !canIUse('SystemCapability.MiscServices.Time') ||
        !canIUse('SystemCapability.Startup.SystemInfo')) { return false; }
      return deviceInfo.sdkApiVersion >= 26 && Number.isSafeInteger(deviceInfo.sdkApiVersion) &&
        deviceInfo.deviceType === 'phone' && Number.isSafeInteger(process.pid) && process.pid > 0 &&
        Number.isSafeInteger(process.tid) && process.tid === process.pid &&
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION).appInfo.debug === true;
    } catch (_) { return false; }
  }

  private observe(): number {
    let now: number = NaN;
    try { now = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false); } catch (_) {}
    if (!Number.isSafeInteger(now) || now < 0 || now < this.lastTime) {
      this.clockValid = false;
    } else { this.lastTime = now; }
    const pending = this.phase === 'review' || this.phase === 'confirmed';
    const collecting = this.phase === 'starting' || this.phase === 'active';
    if ((pending || collecting) && (!this.clockValid || !this.permitted || !this.available() ||
      (pending && now >= this.reviewDeadline) || (collecting && now >= this.deadline))) { this.stop(); }
    return now;
  }

  private clearTimer(): void {
    if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; }
  }
}

export const leakWatcherHost: LeakWatcherHost = new LeakWatcherHost();
