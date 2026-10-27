/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { hiAppEvent } from '@kit.PerformanceAnalysisKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { requireWire, match } from './Wire';

export interface DfxObservation {
  eventName: string;
  monotonicNs: string;
  wallTimeUtc: string;
}

export class PlatformDfx {
  private watcher: hiAppEvent.Watcher | undefined = undefined;
  private accepting: boolean = false;
  private pending: DfxObservation[] = [];
  private discarded: number = 0;

  busy(): boolean { return this.watcher !== undefined; }
  count(): number { return this.pending.length; }
  dropped(): number { return this.discarded; }
  take(): DfxObservation | undefined { return this.pending.shift(); }
  replaced(): void { this.discarded++; }
  start(name: string, active: () => boolean): void {
    requireWire(!this.busy(), 'DFX_CAPTURE_BUSY');
    requireWire(match(name, '^[A-Za-z][A-Za-z0-9_]{0,30}[A-Za-z0-9]$'), 'DFX_NAME_INVALID');
    requireWire(canIUse('SystemCapability.HiviewDFX.HiAppEvent') && active(), 'DFX_NOT_AVAILABLE');
    this.pending = []; this.discarded = 0; this.accepting = false;
    const filter: hiAppEvent.AppEventFilter = {
      domain: hiAppEvent.domain.OS, names: [hiAppEvent.event.APP_CRASH, hiAppEvent.event.APP_FREEZE]
    };
    const watcher: hiAppEvent.Watcher = {
      name: name, appEventFilters: [filter],
      onReceive: (domain: string, groups: hiAppEvent.AppEventGroup[]): void => {
        // A synchronous add callback has not acquired an owner yet. Never
        // inspect params, send frames or remove the watcher from this callback.
        if (!this.accepting || this.watcher !== watcher || !active()) { return; }
        try { this.observe(domain, groups); } catch { this.discarded++; }
      }
    };
    this.watcher = watcher;
    try {
      // The SDK declaration omits nullable although its documentation allows it.
      const holder = hiAppEvent.addWatcher(watcher);
      requireWire(holder !== null && holder !== undefined && active(), 'DFX_START_FAILED');
      this.accepting = true;
    } catch {
      // Even a failed registration may have installed a native owner.
      this.close();
      throw new Error('DFX_START_FAILED');
    }
  }
  private observe(domain: string, groups: hiAppEvent.AppEventGroup[]): void {
    if (domain !== hiAppEvent.domain.OS || !Array.isArray(groups)) { this.discarded++; return; }
    const milliseconds = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
    requireWire(Number.isSafeInteger(milliseconds) && milliseconds >= 0, 'CLOCK_SAMPLE_INVALID');
    const monotonicNs = (BigInt(milliseconds) * BigInt(1000000)).toString();
    const wallTimeUtc = new Date().toISOString();
    let inspected = 0;
    if (groups.length > 32) { this.discarded += groups.length - 32; }
    for (let groupIndex = 0; groupIndex < Math.min(groups.length, 32); groupIndex++) {
      const group = groups[groupIndex];
      const infos = group?.appEventInfos;
      if (!Array.isArray(infos)) { this.discarded++; continue; }
      const available = Math.min(infos.length, 32 - inspected);
      this.discarded += infos.length - available;
      for (let index = 0; index < available; index++) {
        inspected++;
        try {
          const info = infos[index];
          requireWire((group.name === hiAppEvent.event.APP_CRASH || group.name === hiAppEvent.event.APP_FREEZE) &&
            info.domain === hiAppEvent.domain.OS && info.name === group.name &&
            [hiAppEvent.EventType.FAULT, hiAppEvent.EventType.STATISTIC,
              hiAppEvent.EventType.SECURITY, hiAppEvent.EventType.BEHAVIOR].includes(info.eventType), 'DFX_EVENT_INVALID');
          const observation: DfxObservation = { eventName: info.name, monotonicNs: monotonicNs, wallTimeUtc: wallTimeUtc };
          if (this.pending.length === 32) { this.pending.shift(); this.discarded++; }
          this.pending.push(observation);
        } catch { this.discarded++; }
      }
    }
  }
  invalidate(): void { this.accepting = false; this.pending = []; }
  close(): void {
    this.invalidate();
    const watcher = this.watcher;
    if (watcher !== undefined) {
      hiAppEvent.removeWatcher(watcher);
      this.watcher = undefined;
    }
  }
}
