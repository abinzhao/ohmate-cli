/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreResult } from '../api/CoreTypes';
import { coreIdentifier } from '../core/SchemaRegistry';
import { DebugWindowHost, DebugWindowStatus } from './DebugTypes';

type SurfaceAction = 'attach' | 'open' | 'close' | 'show' | 'hide' | 'detach';
class SurfaceOperation {
  action: SurfaceAction = 'attach';
  active: boolean = true;
  deadline: number = 0;
  timer: number = -1;
  finish: ((result: CoreResult) => void) | undefined = undefined;
}
class SurfaceSlot {
  id: string = '';
  host: DebugWindowHost | undefined = undefined;
  attached: boolean = false;
  revoked: boolean = false;
  cleaned: boolean = false;
  cleanupRequired: boolean = false;
  detachRequested: boolean = false;
  panel: boolean = false;
  floating: boolean = false;
  foreground: boolean = true;
  hideRequested: boolean = false;
  closeRequested: boolean = false;
  configuring: boolean = false;
  attempts: number = 0;
  operation: SurfaceOperation | undefined = undefined;
}
function waitValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 100 && value <= 3000;
}
// Host declarations/acceptance never authenticate a build or actual surface paint.
export class DebugWindows {
  private enabled: boolean;
  private disposed: boolean = false;
  private clockInvalid: boolean = false;
  private lastTime: number = 0;
  private now: () => number;
  private slots: SurfaceSlot[] = [];
  private owners: WeakSet<DebugWindowHost> = new WeakSet<DebugWindowHost>();
  constructor(profile: string, now: () => number) {
    this.enabled = profile === 'debug' || profile === 'test'; this.now = now;
    if (this.enabled) { this.observeClock(); }
  }
  attach(id: string, host: DebugWindowHost, timeoutMs: number): Promise<CoreResult> {
    const gate: string = this.admit(timeoutMs);
    if (gate !== '') { return this.result(gate); }
    if (!coreIdentifier(id)) { return this.result('WINDOW_ID_INVALID'); }
    const existing: SurfaceSlot | undefined = this.find(id);
    if (existing !== undefined && !existing.cleaned) {
      if (existing.host !== host) { return this.result('WINDOW_CONFLICT'); }
      if (existing.revoked) { return this.result('WINDOW_CLEANUP_REQUIRED'); }
      return this.result(existing.operation !== undefined ? 'WINDOW_BUSY' : 'WINDOW_ATTACHED');
    }
    if (this.slots.length >= 32) { return this.result('WINDOW_QUOTA'); }
    if (this.owners.has(host)) { return this.result('WINDOW_OWNER_CONFLICT'); }
    const slot = new SurfaceSlot(); slot.id = id; slot.host = host;
    this.slots.push(slot); this.owners.add(host);
    return this.dispatch(slot, 'attach', timeoutMs);
  }
  control(action: SurfaceAction, id: string, timeoutMs: number): Promise<CoreResult> {
    const gate: string = this.admit(timeoutMs);
    if (gate !== '') { return this.result(gate); }
    const candidates: SurfaceSlot[] = this.slots.filter((slot: SurfaceSlot): boolean => !slot.cleaned);
    if (id === '' && candidates.length > 1) { return this.result('WINDOW_AMBIGUOUS'); }
    const slot: SurfaceSlot | undefined = id === '' ? candidates[0] : this.find(id);
    if (slot === undefined || slot.cleaned) { return this.result('WINDOW_UNAVAILABLE'); }
    if (slot.revoked) { return this.result('WINDOW_CLEANUP_REQUIRED'); }
    if (slot.operation !== undefined || slot.configuring) { return this.result('WINDOW_BUSY'); }
    if (!slot.attached) { return this.result('WINDOW_UNAVAILABLE'); }
    if (!slot.foreground && (action === 'open' || action === 'show')) { return this.result('WINDOW_HIDDEN'); }
    if ((action === 'open' && slot.panel) || (action === 'close' && !slot.panel) ||
      (action === 'show' && slot.floating) || (action === 'hide' && !slot.floating)) {
      return this.result(this.successCode(action));
    }
    if (slot.attempts >= 256) { return this.result('WINDOW_ACTION_QUOTA'); }
    return this.dispatch(slot, action, timeoutMs);
  }
  updateConfiguration(id: string): CoreResult {
    const gate: string = this.admit(1000);
    if (gate !== '') { return new CoreResult(gate); }
    const slot: SurfaceSlot | undefined = id === '' ? undefined : this.find(id);
    if (slot === undefined || slot.cleaned || !slot.attached) { return new CoreResult('WINDOW_UNAVAILABLE'); }
    if (slot.revoked) { return new CoreResult('WINDOW_CLEANUP_REQUIRED'); }
    if (slot.operation !== undefined || slot.configuring) { return new CoreResult('WINDOW_BUSY'); }
    const host: DebugWindowHost | undefined = slot.host;
    if (host?.updateConfiguration === undefined) { return new CoreResult('CAPABILITY_NOT_AVAILABLE'); }
    if (slot.attempts >= 256) { return new CoreResult('WINDOW_ACTION_QUOTA'); }
    slot.attempts++; slot.configuring = true;
    let result: string = 'WINDOW_CLEANUP_REQUIRED';
    try {
      const accepted: boolean = host.updateConfiguration();
      const clockValid: boolean = this.observeClock();
      if (accepted !== true) { slot.revoked = true; slot.cleanupRequired = true; }
      else if (clockValid && !slot.revoked) { result = 'CONFIGURATION_UPDATED'; }
    } catch (_) { slot.revoked = true; slot.cleanupRequired = true; }
    finally {
      slot.configuring = false;
      if (slot.detachRequested && !slot.cleaned && !slot.cleanupRequired) {
        this.detach(slot.id, 1000).then((): void => {});
      } else { this.drainHidden(slot); }
    }
    return new CoreResult(result);
  }
  observe(id: string, host: DebugWindowHost, event: string): void {
    const slot: SurfaceSlot | undefined = this.find(id);
    if (slot === undefined || slot.host !== host || slot.cleaned || slot.revoked) { return; }
    if (event === 'destroyed') { this.detach(id, 1000).then((): void => {}); return; }
    if (event === 'shown') { slot.foreground = true; return; }
    if (event === 'floating-hidden') {
      slot.floating = false;
      const operation: SurfaceOperation | undefined = slot.operation;
      if (operation?.action === 'show') { this.finish(operation, 'WINDOW_HIDDEN'); }
      return;
    }
    if (event !== 'hidden') { return; }
    slot.foreground = false; slot.panel = false; slot.floating = false;
    slot.hideRequested = true; slot.closeRequested = true;
    const operation: SurfaceOperation | undefined = slot.operation;
    if (operation !== undefined && operation.action !== 'attach' && operation.action !== 'detach') {
      this.finish(operation, 'WINDOW_HIDDEN');
    }
    this.drainHidden(slot);
  }
  detach(id: string, timeoutMs: number, retry: boolean = false): Promise<CoreResult> {
    if (!waitValid(timeoutMs)) { return this.result('WINDOW_TIMEOUT_INVALID'); }
    const slot: SurfaceSlot | undefined = this.find(id);
    if (slot === undefined || slot.cleaned) { return this.result('WINDOW_DETACHED'); }
    slot.revoked = true; slot.detachRequested = true;
    if (slot.configuring) { return this.result('WINDOW_PENDING'); }
    const operation: SurfaceOperation | undefined = slot.operation;
    if (operation !== undefined) {
      if (operation.action !== 'detach') { this.finish(operation, 'WINDOW_CANCELLED'); }
      return this.result('WINDOW_PENDING');
    }
    if (slot.cleanupRequired && !retry) { return this.result('WINDOW_CLEANUP_REQUIRED'); }
    slot.cleanupRequired = false;
    this.observeClock();
    return this.dispatch(slot, 'detach', timeoutMs);
  }
  status(): DebugWindowStatus[] {
    if (!this.enabled) { return []; }
    this.observeClock();
    return this.slots.filter((slot: SurfaceSlot): boolean => this.find(slot.id) === slot)
      .map((slot: SurfaceSlot): DebugWindowStatus => {
      const status = new DebugWindowStatus(); status.windowId = slot.id;
      status.state = slot.cleaned ? 'detached' : slot.cleanupRequired ? 'cleanup-required' :
        slot.revoked ? 'detaching' : slot.attached ? 'attached' : 'attaching';
      status.panel = slot.cleaned ? 'closed' : slot.revoked ? 'unknown' : slot.panel ? 'open' : 'closed';
      status.floating = slot.cleaned ? 'hidden' : slot.revoked ? 'unknown' : slot.floating ? 'visible' : 'hidden';
      status.pending = slot.operation !== undefined || slot.configuring; status.attempts = slot.attempts;
      return status;
    });
  }
  async dispose(): Promise<CoreResult> {
    this.disposed = true;
    await Promise.all<CoreResult>(this.slots.map((slot: SurfaceSlot): Promise<CoreResult> =>
      this.detach(slot.id, 1000)));
    return new CoreResult(this.slots.some((slot: SurfaceSlot): boolean => !slot.cleaned) ?
      'WINDOW_CLEANUP_REQUIRED' : 'DISPOSED');
  }
  private admit(timeoutMs: number): string {
    if (!this.enabled) { return 'CAPABILITY_NOT_AVAILABLE'; }
    if (this.disposed) { return 'DISPOSED'; }
    if (!waitValid(timeoutMs)) { return 'WINDOW_TIMEOUT_INVALID'; }
    if (!this.observeClock() || !Number.isSafeInteger(this.lastTime + timeoutMs)) {
      this.invalidateClock(); return 'WINDOW_CLOCK_INVALID';
    }
    return '';
  }
  private observeClock(): boolean {
    if (this.clockInvalid) { return false; }
    try {
      const value: number = this.now();
      if (Number.isSafeInteger(value) && value >= this.lastTime) {
        this.lastTime = value;
        for (const slot of this.slots) {
          const operation: SurfaceOperation | undefined = slot.operation;
          if (operation !== undefined && operation.active && value >= operation.deadline) {
            this.fail(slot, operation, operation.action === 'detach' ? 'WINDOW_CLEANUP_REQUIRED' : 'WINDOW_TIMEOUT');
          }
        }
        return true;
      }
    } catch (_) {}
    this.invalidateClock(); return false;
  }
  private invalidateClock(): void {
    this.clockInvalid = true;
    for (const slot of this.slots) {
      if (slot.cleaned) { continue; }
      slot.revoked = true; slot.cleanupRequired = true;
      const operation: SurfaceOperation | undefined = slot.operation;
      if (operation !== undefined && operation.action !== 'detach') {
        this.finish(operation, 'WINDOW_CLOCK_INVALID');
      }
    }
  }
  private dispatch(slot: SurfaceSlot, action: SurfaceAction, timeoutMs: number): Promise<CoreResult> {
    const operation = new SurfaceOperation(); operation.action = action;
    operation.deadline = this.lastTime + timeoutMs; slot.operation = operation;
    if (action !== 'detach') { slot.attempts++; }
    return new Promise<CoreResult>((resolve): void => {
      operation.finish = resolve;
      operation.timer = setTimeout((): void => {
        this.fail(slot, operation, action === 'detach' ? 'WINDOW_CLEANUP_REQUIRED' : 'WINDOW_TIMEOUT');
      }, timeoutMs);
      try {
        const host: DebugWindowHost | undefined = slot.host;
        if (host === undefined) { this.settled(slot, operation, false); return; }
        this.call(host, action).then((accepted: boolean): void => {
          this.settled(slot, operation, accepted);
        }, (): void => { this.settled(slot, operation, false); });
      } catch (_) { this.settled(slot, operation, false); }
    });
  }
  private call(host: DebugWindowHost, action: SurfaceAction): Promise<boolean> {
    if (action === 'attach') { return host.attach(); }
    if (action === 'open') { return host.openPanel(); }
    if (action === 'close') { return host.closePanel(); }
    if (action === 'show') { return host.showFloatingButton(); }
    if (action === 'hide') { return host.hideFloatingButton(); }
    return host.detach();
  }
  private settled(slot: SurfaceSlot, operation: SurfaceOperation, accepted: boolean): void {
    if (operation.active) {
      const timely: boolean = operation.action === 'detach' && this.clockInvalid ? true :
        this.observeClock() && this.lastTime < operation.deadline;
      if (operation.active) {
        if (accepted !== true || !timely) { this.fail(slot, operation, 'WINDOW_CLEANUP_REQUIRED'); }
        else {
          const action: SurfaceAction = operation.action;
          if (action === 'detach') {
            slot.cleaned = true; slot.cleanupRequired = false; slot.host = undefined;
            slot.panel = false; slot.floating = false;
          } else if (action === 'attach') { slot.attached = true; }
          else if (action === 'open' || action === 'close') { slot.panel = action === 'open' && slot.foreground; }
          else if (action === 'show' || action === 'hide') { slot.floating = action === 'show' && slot.foreground; }
          this.finish(operation, this.successCode(action));
        }
      }
    }
    if (slot.operation === operation) { slot.operation = undefined; }
    // Cancellation schedules cleanup only after the exact native operation returns.
    // Failed/timed-out work never retries cleanup from a query or late callback.
    if (slot.detachRequested && !slot.cleaned && !slot.cleanupRequired && operation.action !== 'detach') {
      this.detach(slot.id, 1000).then((): void => {});
    } else { this.drainHidden(slot); }
  }
  private drainHidden(slot: SurfaceSlot): void {
    if (slot.cleaned || slot.revoked || slot.operation !== undefined || slot.configuring || !slot.attached) { return; }
    if (!slot.closeRequested && !slot.hideRequested) { return; }
    if (this.admit(1000) !== '' || slot.attempts >= 256) {
      slot.revoked = true; slot.cleanupRequired = true; return;
    }
    const action: SurfaceAction = slot.closeRequested ? 'close' : 'hide';
    if (action === 'close') { slot.closeRequested = false; } else { slot.hideRequested = false; }
    // Background cleanup waits for the original effect; it never races a dialog open.
    this.dispatch(slot, action, 1000).then((): void => {});
  }
  private fail(slot: SurfaceSlot, operation: SurfaceOperation, code: string): void {
    slot.revoked = true; slot.cleanupRequired = true; this.finish(operation, code);
  }
  private finish(operation: SurfaceOperation, code: string): void {
    if (!operation.active) { return; }
    operation.active = false;
    if (operation.timer !== -1) { clearTimeout(operation.timer); operation.timer = -1; }
    const finish: ((result: CoreResult) => void) | undefined = operation.finish;
    operation.finish = undefined; finish?.(new CoreResult(code));
  }
  private successCode(action: SurfaceAction): string {
    if (action === 'attach') { return 'WINDOW_ATTACHED'; }
    if (action === 'open') { return 'PANEL_OPEN'; }
    if (action === 'close') { return 'PANEL_CLOSED'; }
    if (action === 'show') { return 'FLOATING_VISIBLE'; }
    if (action === 'hide') { return 'FLOATING_HIDDEN'; }
    return 'WINDOW_DETACHED';
  }
  private find(id: string): SurfaceSlot | undefined {
    for (let index: number = this.slots.length - 1; index >= 0; index--) {
      if (this.slots[index].id === id) { return this.slots[index]; }
    }
    return undefined;
  }
  private result(code: string): Promise<CoreResult> {
    return Promise.resolve<CoreResult>(new CoreResult(code));
  }
}
