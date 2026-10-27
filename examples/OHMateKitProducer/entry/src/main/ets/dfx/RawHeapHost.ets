/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { hidebug } from '@kit.PerformanceAnalysisKit';
import { bundleManager } from '@kit.AbilityKit';
import { BusinessError, deviceInfo, systemDateTime } from '@kit.BasicServicesKit';
import { process } from '@kit.ArkTS';

// Application code must supply an exclusive output owner on its worker VM.
// prepare owns partial/unreported native outputs too; adoption is not proof of
// file ownership. Processing and cleanup must stay local and off the UI thread.
export interface RawHeapFiles {
  prepare(revision: number): Promise<void>;
  adopt(revision: number, paths: Array<string>): void;
  process(revision: number): Promise<void>;
  cleanup(revision: number): Promise<boolean>;
}

export interface RawHeapReview {
  revision: number;
  scope: string;
  expiresAt: number;
  waitBudgetMs: number;
  writesRawFiles: boolean;
  needGC: boolean;
  needClean: boolean;
}

export interface RawHeapStatus {
  phase: string;
  owned: boolean;
  pending: boolean;
  clockValid: boolean;
  attempts: number;
  outcome: string;
  rawFiles: string;
  errorCode: number | undefined;
  capture: string;
}

// Instantiate in an application-owned non-main Worker, not a transient TaskPool
// task. The owner and failed cleanup must survive until explicit resolution.
// There is no Core/Bridge registration or main-Ability startup integration.
export class RawHeapHost {
  private static owner: RawHeapHost | undefined = undefined;
  private static attempts: number = 0;
  private static reviews: number = 0;
  private permitted: boolean = false;
  private configuredFiles: RawHeapFiles | undefined = undefined;
  private files: RawHeapFiles | undefined = undefined;
  private phase: string = 'closed';
  private outcome: string = 'none';
  private rawFiles: string = 'not-requested';
  private errorCode: number | undefined = undefined;
  private revision: number = 0;
  private reviewDeadline: number = 0;
  private deadline: number = 0;
  private generation: number = 0;
  private clockValid: boolean = true;
  private lastTime: number = -1;
  private pid: number = 0;
  private tid: number = 0;
  private owned: boolean = false;
  private pending: boolean = false;
  private timer: number = -1;
  private waiter: ((error: Error | undefined) => void) | undefined = undefined;

  configure(exclusive: boolean, files: RawHeapFiles | undefined): void {
    if (this.permitted !== (exclusive === true) || this.configuredFiles !== files) { this.stop(); }
    this.permitted = exclusive === true;
    this.configuredFiles = files;
  }

  get status(): RawHeapStatus {
    this.observe();
    return { phase: this.phase, owned: this.owned, pending: this.pending,
      clockValid: this.clockValid, attempts: RawHeapHost.attempts, outcome: this.outcome,
      rawFiles: this.rawFiles, errorCode: this.errorCode, capture: 'unverified' };
  }

  review(scope: string): RawHeapReview {
    const now = this.observe();
    if (this.owned || RawHeapHost.owner !== undefined) { throw new Error('RAWHEAP_BUSY'); }
    if (!this.permitted || this.configuredFiles === undefined || !this.clockValid ||
      !this.available() || now > Number.MAX_SAFE_INTEGER - 30000) { throw new Error('RAWHEAP_UNAVAILABLE'); }
    if (scope !== 'process') { throw new Error('RAWHEAP_SCOPE_INVALID'); }
    if (RawHeapHost.attempts >= 1) { throw new Error('RAWHEAP_ATTEMPT_LIMIT'); }
    if (RawHeapHost.reviews >= 256) { throw new Error('RAWHEAP_REVIEW_LIMIT'); }
    this.revision = ++RawHeapHost.reviews;
    this.pid = process.pid;
    this.tid = process.tid;
    this.reviewDeadline = now + 30000;
    this.phase = 'review';
    return { revision: this.revision, scope: 'process', expiresAt: this.reviewDeadline,
      waitBudgetMs: 30000, writesRawFiles: true, needGC: false, needClean: false };
  }

  confirm(revision: number, allowRawFiles: boolean, developerOptionsAcknowledged: boolean): void {
    this.observe();
    if (this.phase !== 'review' || revision !== this.revision) { throw new Error('RAWHEAP_CONSENT_REQUIRED'); }
    if (allowRawFiles !== true) { throw new Error('RAWHEAP_RAW_FILE_CONSENT_REQUIRED'); }
    if (developerOptionsAcknowledged !== true) { throw new Error('RAWHEAP_DEVELOPER_OPTIONS_REQUIRED'); }
    // This acknowledgment cannot query, enable or authenticate Developer options.
    this.phase = 'confirmed';
  }

  async collect(revision: number): Promise<void> {
    const now = this.observe();
    if (this.phase !== 'confirmed' || revision !== this.revision) { throw new Error('RAWHEAP_CONSENT_REQUIRED'); }
    if (RawHeapHost.owner !== undefined) { throw new Error('RAWHEAP_BUSY'); }
    const files = this.configuredFiles;
    if (files === undefined || RawHeapHost.attempts >= 1) { throw new Error('RAWHEAP_ATTEMPT_LIMIT'); }
    RawHeapHost.attempts++;
    this.files = files;
    this.owned = true;
    this.pending = true;
    RawHeapHost.owner = this;
    this.deadline = now + 30000;
    this.phase = 'preparing';
    this.outcome = 'none';
    this.errorCode = undefined;
    const generation = ++this.generation;
    const waiting = this.wait();
    void this.run(revision, generation, files);
    return waiting;
  }

  stop(): void {
    this.generation++;
    if (this.pending && this.outcome !== 'timeout') { this.outcome = 'canceled'; }
    if (this.phase !== 'cleanup-failed') { this.phase = this.owned ? 'canceling' : 'closed'; }
    this.finishWaiter(new Error('RAWHEAP_CANCELED'));
    this.clearTimer();
    // The outstanding prepare/dump/process/cleanup keeps the exact owner.
    // Stop/status/configure never retry a previously failed cleanup.
  }

  async retryCleanup(): Promise<void> {
    const now = this.observe();
    if (!this.owned || this.pending || this.phase !== 'cleanup-failed' || this.files === undefined) {
      throw new Error('RAWHEAP_CLEANUP_REQUIRED');
    }
    const files = this.files;
    this.pending = true;
    // This new wait budget authorizes cleanup only, never another dump.
    this.deadline = this.clockValid && now <= Number.MAX_SAFE_INTEGER - 30000 ? now + 30000 : 0;
    const waiting = this.wait();
    void this.retryRun(files);
    this.observe();
    return waiting;
  }

  private wait(): Promise<void> {
    const waiting = new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      this.waiter = (error: Error | undefined): void => {
        if (error === undefined) { resolve(); } else { reject(error); }
      };
    });
    this.timer = setInterval((): void => { this.observe(); }, 250);
    return waiting;
  }

  private async retryRun(files: RawHeapFiles): Promise<void> {
    await this.clean(this.revision, files);
    this.finishWaiter(this.owned ? new Error('RAWHEAP_CLEANUP_REQUIRED') : undefined);
  }

  private async run(revision: number, generation: number, files: RawHeapFiles): Promise<void> {
    try {
      await files.prepare(revision);
      if (this.current(generation)) {
        this.phase = 'dumping';
        this.rawFiles = 'may-exist';
        // processDump explicitly requests all process VMs. Calling the two-arg
        // API here would capture only this worker, not the application's main VM.
        const paths = await hidebug.dumpJsRawHeapData(false, false, true);
        this.observe();
        if (!this.sameThread()) { throw new Error('RAWHEAP_THREAD_CHANGED'); }
        const bounded = this.boundedPaths(paths);
        this.observe();
        if (!this.sameThread()) { throw new Error('RAWHEAP_THREAD_CHANGED'); }
        files.adopt(revision, bounded);
        if (this.current(generation)) {
          this.phase = 'processing';
          await files.process(revision);
          if (this.current(generation)) { this.outcome = 'processed'; }
        }
      }
    } catch (error) {
      try {
        const code = (error as BusinessError).code;
        if (Number.isSafeInteger(code) && code >= 11400106 && code <= 11400113) { this.errorCode = code; }
      } catch (_) {}
      if (this.outcome !== 'canceled' && this.outcome !== 'timeout') { this.outcome = 'failed'; }
    }
    await this.clean(revision, files);
    if (this.owned) { this.finishWaiter(new Error('RAWHEAP_CLEANUP_REQUIRED')); }
    else if (this.outcome === 'processed') { this.finishWaiter(undefined); }
    else { this.finishWaiter(new Error('RAWHEAP_CAPTURE_FAILED')); }
  }

  private async clean(revision: number, files: RawHeapFiles): Promise<void> {
    let clean = false;
    this.phase = 'cleaning';
    try {
      if (this.sameThread()) { clean = await files.cleanup(revision) === true; }
    } catch (_) {}
    this.observe();
    clean = clean && this.sameThread();
    this.clearTimer();
    this.pending = false;
    if (!clean) {
      this.phase = 'cleanup-failed';
      this.rawFiles = 'unresolved';
      return;
    }
    this.files = undefined;
    this.owned = false;
    this.phase = 'closed';
    this.rawFiles = 'host-reported-clean';
    if (RawHeapHost.owner === this) { RawHeapHost.owner = undefined; }
  }

  private boundedPaths(paths: Array<string>): Array<string> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 16) { throw new Error('RAWHEAP_OUTPUT_INVALID'); }
    const bounded: Array<string> = [];
    let total = 0;
    for (let i = 0; i < paths.length; i++) {
      const item = paths[i];
      if (typeof item !== 'string' || item.length > 4096 || !item.startsWith('/') ||
        !item.endsWith('.rawheap') || new RegExp('[\\x00-\\x1f\\x7f]').test(item) ||
        item.slice(1).split('/').some((part: string): boolean => part === '' || part === '.' || part === '..') ||
        bounded.includes(item)) { throw new Error('RAWHEAP_OUTPUT_INVALID'); }
      total += item.length;
      if (total > 16384) { throw new Error('RAWHEAP_OUTPUT_INVALID'); }
      bounded.push(item);
    }
    return bounded;
  }

  private current(generation: number): boolean {
    this.observe();
    return this.owned && this.generation === generation && this.outcome !== 'canceled' && this.outcome !== 'timeout';
  }

  private sameThread(): boolean {
    try { return process.pid === this.pid && process.tid === this.tid; } catch (_) { return false; }
  }

  private available(): boolean {
    try {
      if (!canIUse('SystemCapability.HiviewDFX.HiProfiler.HiDebug') ||
        !canIUse('SystemCapability.Utils.Lang') || !canIUse('SystemCapability.MiscServices.Time') ||
        !canIUse('SystemCapability.Startup.SystemInfo')) { return false; }
      return Number.isSafeInteger(deviceInfo.sdkApiVersion) && deviceInfo.sdkApiVersion >= 26 &&
        deviceInfo.deviceType === 'phone' && Number.isSafeInteger(process.pid) && process.pid > 0 &&
        Number.isSafeInteger(process.tid) && process.tid > 0 && process.tid !== process.pid &&
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION).appInfo.debug === true;
    } catch (_) { return false; }
  }

  private observe(): number {
    let now: number = NaN;
    try { now = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false); } catch (_) {}
    if (!Number.isSafeInteger(now) || now < 0 || now < this.lastTime) { this.clockValid = false; }
    else { this.lastTime = now; }
    const reviewing = this.phase === 'review' || this.phase === 'confirmed';
    const running = this.pending && this.phase !== 'canceling' && this.phase !== 'cleanup-failed';
    if ((reviewing || running) && (!this.clockValid || !this.permitted || !this.available() || !this.sameThread())) { this.stop(); }
    else if (reviewing && now >= this.reviewDeadline) { this.stop(); }
    else if (running && now >= this.deadline) {
      this.outcome = 'timeout';
      this.finishWaiter(new Error('RAWHEAP_TIMEOUT'));
      this.stop();
    }
    return now;
  }

  private finishWaiter(error: Error | undefined): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter !== undefined) { waiter(error); }
  }

  private clearTimer(): void {
    if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; }
  }
}
