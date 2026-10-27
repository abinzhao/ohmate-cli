/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreEvent, CoreHost, CoreLoss, CoreOptions } from '../api/CoreTypes';

function rank(event: CoreEvent): number {
  if (event.priority === 'critical') { return 3; }
  if (event.priority === 'high') { return 2; }
  return event.priority === 'normal' ? 1 : 0;
}
export class EventRing {
  private slots: (CoreEvent | undefined)[] = [];
  private sizes: number[] = [];
  private options: CoreOptions;
  private host: CoreHost;
  records: number = 0;
  bytes: number = 0;
  loss: CoreLoss = new CoreLoss();
  constructor(options: CoreOptions, host: CoreHost) {
    this.options = options; this.host = host;
    for (let i = 0; i < options.maxRecords; i++) { this.slots.push(undefined); this.sizes.push(0); }
  }
  push(event: CoreEvent, pendingRecords: number, pendingBytes: number): boolean {
    const size: number = this.host.byteLength(JSON.stringify(event));
    const critical: boolean = event.priority === 'critical';
    const limitRecords: number = this.options.maxRecords - (critical ? 0 : this.options.criticalReserveRecords);
    const limitBytes: number = this.options.maxBufferBytes - (critical ? 0 : this.options.criticalReserveBytes);
    while (this.records + pendingRecords + 1 > limitRecords || this.bytes + pendingBytes + size > limitBytes) {
      const victim: number = this.victim(event);
      if (victim < 0) { this.drop(event); return false; }
      const previous: CoreEvent | undefined = this.slots[victim];
      if (previous !== undefined) { this.drop(previous); this.remove(victim); }
    }
    const slot: number = this.slots.findIndex((item: CoreEvent | undefined): boolean => item === undefined);
    if (slot < 0) { this.drop(event); return false; }
    this.slots[slot] = event; this.sizes[slot] = size; this.records++; this.bytes += size;
    return true;
  }
  private victim(incoming: CoreEvent): number {
    let selected: number = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const candidate: CoreEvent | undefined = this.slots[i];
      if (candidate === undefined || rank(candidate) > rank(incoming)) { continue; }
      const old: CoreEvent | undefined = selected < 0 ? undefined : this.slots[selected];
      if (old === undefined || rank(candidate) < rank(old) ||
        (rank(candidate) === rank(old) && candidate.sequence < old.sequence)) { selected = i; }
    }
    return selected;
  }
  private remove(slot: number): void {
    this.bytes -= this.sizes[slot]; this.records--; this.sizes[slot] = 0; this.slots[slot] = undefined;
  }
  drop(event: CoreEvent): void {
    this.loss.dropped++;
    if (event.priority === 'critical') { this.loss.criticalDropped++; }
    if (this.loss.firstSequence === 0 || event.sequence < this.loss.firstSequence) { this.loss.firstSequence = event.sequence; }
    this.loss.lastSequence = Math.max(this.loss.lastSequence, event.sequence);
  }
  snapshot(): CoreEvent[] {
    const events: CoreEvent[] = [];
    for (const item of this.slots) { if (item !== undefined) { events.push(item); } }
    return events.sort((a: CoreEvent, b: CoreEvent): number => a.sequence - b.sequence);
  }
  drain(): CoreEvent[] {
    const events: CoreEvent[] = this.snapshot();
    for (let i = 0; i < this.slots.length; i++) { this.slots[i] = undefined; this.sizes[i] = 0; }
    this.records = 0; this.bytes = 0;
    return events;
  }
}
