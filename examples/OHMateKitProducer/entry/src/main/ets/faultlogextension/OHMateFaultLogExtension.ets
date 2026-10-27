/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { FaultLogExtensionAbility, hiAppEvent } from '@kit.PerformanceAnalysisKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { FaultLogSummary, FaultLogObservation, faultLogFilter, FAULTLOG_DELAYED_NAME } from './FaultLogSummary';

export interface FaultLogExtensionReport {
  phase: string;
  pendingCleanup: number;
  recent: FaultLogObservation[];
  dropped: number;
  buildIdentity: string;
  delayedSystemLaunch: string;
}

export default class OHMateFaultLogExtension extends FaultLogExtensionAbility {
  private started: boolean = false;
  private ready: boolean = false;
  private accepting: boolean = false;
  private phase: string = 'inactive';
  private lastUptime: number = 0;
  private deadline: number = 0;
  private timer: number | undefined = undefined;
  private watcher: hiAppEvent.Watcher | undefined = undefined;
  private summary: FaultLogSummary = new FaultLogSummary();

  onConnect(): void {
    if (this.started) { return; }
    this.started = true;
    try {
      if (this.context?.applicationInfo?.debug !== true ||
        !canIUse('SystemCapability.HiviewDFX.Hiview.FaultLogger') ||
        !canIUse('SystemCapability.HiviewDFX.HiAppEvent')) { this.phase = 'unavailable'; return; }
      const now: number = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 9000)) {
        this.phase = 'clock-invalid'; return;
      }
      this.lastUptime = now; this.deadline = now + 9000; this.phase = 'connected';
      this.timer = setTimeout((): void => { this.invalidate('expired'); }, 9000);
    } catch { this.invalidate('unavailable'); }
  }
  onFaultReportReady(): void {
    if (this.ready || !this.running()) { return; }
    this.ready = true;
    const watcher: hiAppEvent.Watcher = {
      name: FAULTLOG_DELAYED_NAME, appEventFilters: [faultLogFilter()],
      onReceive: (domain: string, groups: hiAppEvent.AppEventGroup[]): void => {
        if (!this.accepting || this.watcher !== watcher || !this.running()) { return; }
        try { this.summary.observe(domain, groups, this.lastUptime); }
        catch { this.invalidate('failed'); }
      }
    };
    this.watcher = watcher;
    try {
      const holder = hiAppEvent.addWatcher(watcher);
      if (holder === null || holder === undefined) { throw new Error('FAULTLOG_REGISTRATION_FAILED'); }
      if (!this.running()) { return; }
      this.accepting = true; this.phase = 'watching';
    } catch {
      this.invalidate('failed');
      this.revoke();
    }
  }
  onDisconnect(): void {
    this.started = true;
    // removeWatcher deletes the persisted B filter. Normal shutdown must
    // preserve application opt-in; native process exit releases its listener.
    this.invalidate(this.phase === 'cleanup-failed' ? 'cleanup-failed' : 'disconnected');
  }
  private invalidate(phase: string): void {
    this.accepting = false; this.phase = phase; this.summary.clear();
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
  }
  private running(): boolean {
    if (this.phase !== 'connected' && this.phase !== 'watching') { return false; }
    try {
      const now: number = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
      if (!Number.isSafeInteger(now) || now < this.lastUptime) { this.invalidate('clock-invalid'); return false; }
      this.lastUptime = now;
      if (now >= this.deadline) { this.invalidate('expired'); return false; }
      return true;
    } catch { this.invalidate('clock-invalid'); return false; }
  }
  // Explicit deletion only; status/ready/disconnect never retry native cleanup.
  revoke(): boolean {
    this.started = true;
    this.invalidate('failed');
    if (this.watcher !== undefined) {
      try { hiAppEvent.removeWatcher(this.watcher); this.watcher = undefined; }
      catch { this.phase = 'cleanup-failed'; return false; }
    }
    return true;
  }
  report(): FaultLogExtensionReport {
    this.running();
    const report: FaultLogExtensionReport = { phase: this.phase,
      pendingCleanup: this.phase === 'cleanup-failed' && this.watcher !== undefined ? 1 : 0,
      recent: this.summary.copy(), dropped: this.summary.dropped(),
      buildIdentity: 'unverified', delayedSystemLaunch: 'not-verified' };
    return report;
  }
}
