/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { hiAppEvent } from '@kit.PerformanceAnalysisKit';

export const FAULTLOG_NORMAL_NAME: string = 'OHMateFaultNormal';
export const FAULTLOG_DELAYED_NAME: string = 'OHMateFaultDelayed';

export interface FaultLogObservation {
  eventName: string;
  observedUptimeMs: number;
}

export function faultLogFilter(): hiAppEvent.AppEventFilter {
  const filter: hiAppEvent.AppEventFilter = {
    domain: hiAppEvent.domain.OS,
    names: [hiAppEvent.event.APP_CRASH, hiAppEvent.event.APP_FREEZE]
  };
  return filter;
}

export class FaultLogSummary {
  private recent: FaultLogObservation[] = [];
  private discarded: number = 0;

  clear(): void { this.recent = []; this.discarded = 0; }
  dropped(): number { return this.discarded; }
  copy(): FaultLogObservation[] {
    return this.recent.map((item: FaultLogObservation): FaultLogObservation => {
      const copy: FaultLogObservation = { eventName: item.eventName, observedUptimeMs: item.observedUptimeMs };
      return copy;
    });
  }
  observe(domain: string, groups: hiAppEvent.AppEventGroup[], uptimeMs: number): void {
    if (domain !== hiAppEvent.domain.OS || !Array.isArray(groups)) { this.drop(1); return; }
    let inspected: number = 0;
    this.drop(Math.max(0, groups.length - 32));
    for (let groupIndex: number = 0; groupIndex < Math.min(groups.length, 32); groupIndex++) {
      try {
        const group: hiAppEvent.AppEventGroup = groups[groupIndex];
        const infos: hiAppEvent.AppEventInfo[] = group.appEventInfos;
        if (!Array.isArray(infos)) { this.drop(1); continue; }
        const limit: number = Math.min(infos.length, 32 - inspected);
        this.drop(infos.length - limit);
        for (let index: number = 0; index < limit; index++) {
          inspected++;
          try {
            const info: hiAppEvent.AppEventInfo = infos[index];
            if ((group.name !== hiAppEvent.event.APP_CRASH && group.name !== hiAppEvent.event.APP_FREEZE) ||
              info.domain !== domain || info.name !== group.name ||
              ![hiAppEvent.EventType.FAULT, hiAppEvent.EventType.STATISTIC,
                hiAppEvent.EventType.SECURITY, hiAppEvent.EventType.BEHAVIOR].includes(info.eventType)) {
              this.drop(1); continue;
            }
            const observation: FaultLogObservation = { eventName: info.name, observedUptimeMs: uptimeMs };
            if (this.recent.length === 32) { this.recent.shift(); this.drop(1); }
            this.recent.push(observation);
          } catch { this.drop(1); }
        }
      } catch { this.drop(1); }
    }
  }
  private drop(count: number): void {
    this.discarded = Math.min(Number.MAX_SAFE_INTEGER, this.discarded + count);
  }
}
