/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { hiAppEvent } from '@kit.PerformanceAnalysisKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { FaultLogSummary, FaultLogObservation, faultLogFilter,
  FAULTLOG_NORMAL_NAME, FAULTLOG_DELAYED_NAME } from './FaultLogSummary';

export interface FaultLogHostStatus {
  phase: string;
  pendingCleanup: number;
  recent: FaultLogObservation[];
  dropped: number;
}

// Application opt-in owns the persisted filters independently of the bridge.
// Configure is inert. Neither Want parameters nor Core.start grant consent.
export class FaultLogHost {
  private debug: boolean = false;
  private accepting: boolean = false;
  private phase: string = 'unconfirmed';
  private watchers: hiAppEvent.Watcher[] = [];
  private summary: FaultLogSummary = new FaultLogSummary();
  private generation: number = 0;
  private registering: boolean = false;
  private lastUptime: number = 0;

  configure(debug: boolean): void { this.detach(); this.debug = debug === true; }
  detach(): void {
    this.generation++; this.accepting = false; this.debug = false; this.summary.clear();
    if (this.phase !== 'cleanup-failed') { this.phase = this.watchers.length ? 'detached' : 'unconfirmed'; }
  }
  confirm(consent: boolean): boolean {
    try {
      if (consent !== true || !this.debug ||
        !canIUse('SystemCapability.HiviewDFX.Hiview.FaultLogger') ||
        !canIUse('SystemCapability.HiviewDFX.HiAppEvent')) { return false; }
    } catch { return false; }
    if (this.accepting) { return true; }
    if (this.watchers.length || this.registering) { return false; }
    this.summary.clear(); this.lastUptime = 0;
    const generation: number = this.generation;
    const normal: hiAppEvent.Watcher = {
      name: FAULTLOG_NORMAL_NAME, appEventFilters: [faultLogFilter()],
      onReceive: (domain: string, groups: hiAppEvent.AppEventGroup[]): void => {
        if (!this.accepting || this.watchers[0] !== normal) { return; }
        try {
          const now: number = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
          if (!Number.isSafeInteger(now) || now < this.lastUptime) { this.detach(); return; }
          this.lastUptime = now;
          this.summary.observe(domain, groups, now);
        } catch { this.detach(); }
      }
    };
    const delayed: hiAppEvent.Watcher = {
      name: FAULTLOG_DELAYED_NAME, appEventFilters: [faultLogFilter()],
      // This deliberately remains empty: only the Extension processes B.
      onReceive: (_domain: string, _groups: hiAppEvent.AppEventGroup[]): void => {}
    };
    this.registering = true;
    try {
      for (const watcher of [normal, delayed]) {
        this.watchers.push(watcher);
        const holder = hiAppEvent.addWatcher(watcher);
        if (holder === null || holder === undefined || !this.debug || this.generation !== generation) {
          throw new Error('FAULTLOG_REGISTRATION_FAILED');
        }
      }
      this.registering = false;
      this.accepting = true; this.phase = 'registered'; return true;
    } catch {
      this.registering = false;
      if (this.revoke()) { this.phase = 'failed'; }
      return false;
    }
  }
  revoke(): boolean {
    this.generation++; this.accepting = false; this.summary.clear();
    // A synchronous callback cannot remove a registration still inside add.
    // The acquisition owner performs cleanup after the native call returns.
    if (this.registering) { this.phase = 'cleanup-pending'; return false; }
    const retained: hiAppEvent.Watcher[] = [];
    for (const watcher of this.watchers) {
      try { hiAppEvent.removeWatcher(watcher); } catch { retained.push(watcher); }
    }
    this.watchers = retained;
    this.phase = retained.length ? 'cleanup-failed' : 'unconfirmed';
    return retained.length === 0;
  }
  status(): FaultLogHostStatus {
    const status: FaultLogHostStatus = { phase: this.phase,
      pendingCleanup: this.phase === 'cleanup-failed' || this.phase === 'cleanup-pending' ? this.watchers.length : 0,
      recent: this.summary.copy(), dropped: this.summary.dropped() };
    return status;
  }
}

export const faultLogHost: FaultLogHost = new FaultLogHost();
