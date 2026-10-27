/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreResult } from '../api/CoreTypes';
import { coreIdentifier, CoreProjection, SchemaRegistry } from '../core/SchemaRegistry';
import { ProviderDescriptor, ProviderReadResult, ProviderStatus, SummaryProvider } from './ProviderTypes';

class ProviderReadOperation {
  active: boolean = true;
  deadline: number = 0;
  timer: number = -1;
  finish: ((result: ProviderReadResult) => void) | undefined = undefined;
}
class ProviderCloseOperation {
  active: boolean = true;
  deadline: number = 0;
  timer: number = -1;
  finish: ((result: CoreResult) => void) | undefined = undefined;
}
class ProviderSlot {
  id: string = '';
  eventName: string = '';
  registry: SchemaRegistry = new SchemaRegistry();
  provider: SummaryProvider | undefined = undefined;
  revoked: boolean = false;
  cleaned: boolean = false;
  cleanupRequired: boolean = false;
  pendingRead: boolean = false;
  pendingClose: boolean = false;
  reads: number = 0;
  errors: number = 0;
  rejectedFields: number = 0;
  operation: ProviderReadOperation | undefined = undefined;
}
function timeoutValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 100 && value <= 3000;
}

// Profile is an application declaration, never compiler evidence or remote admission.
export class ProviderRegistry {
  private enabled: boolean = false;
  private disposed: boolean = false;
  private clockInvalid: boolean = false;
  private lastTime: number = 0;
  private now: () => number;
  private slots: ProviderSlot[] = [];
  private owners: WeakSet<SummaryProvider> = new WeakSet<SummaryProvider>();
  constructor(profile: string, now: () => number) {
    this.enabled = profile === 'debug' || profile === 'test';
    this.now = now;
    if (this.enabled) { this.observeClock(); }
  }
  register(descriptor: ProviderDescriptor, provider: SummaryProvider): CoreResult {
    if (!this.enabled) { return new CoreResult('CAPABILITY_NOT_AVAILABLE'); }
    if (this.disposed) { return new CoreResult('DISPOSED'); }
    if (!this.observeClock()) { return new CoreResult('PROVIDER_CLOCK_INVALID'); }
    try {
      if (!coreIdentifier(descriptor.id)) { return new CoreResult('PROVIDER_DESCRIPTOR_INVALID'); }
      if (this.find(descriptor.id) !== undefined) { return new CoreResult('PROVIDER_CONFLICT'); }
      if (this.slots.length >= 32) { return new CoreResult('PROVIDER_QUOTA'); }
      if (this.owners.has(provider)) { return new CoreResult('PROVIDER_OWNER_CONFLICT'); }
      const slot = new ProviderSlot();
      const result: CoreResult = slot.registry.register(descriptor.schema);
      if (result.code !== 'REGISTERED') { return result; }
      slot.id = descriptor.id; slot.eventName = descriptor.schema.name; slot.provider = provider;
      this.owners.add(provider);
      this.slots.push(slot);
      return new CoreResult('REGISTERED');
    } catch (_) { return new CoreResult('PROVIDER_DESCRIPTOR_INVALID'); }
  }
  capture(id: string, timeoutMs: number = 1000): Promise<ProviderReadResult> {
    if (!this.enabled) { return this.readResult('CAPABILITY_NOT_AVAILABLE'); }
    if (this.disposed) { return this.readResult('DISPOSED'); }
    if (!timeoutValid(timeoutMs)) { return this.readResult('PROVIDER_TIMEOUT_INVALID'); }
    if (!this.observeClock()) { return this.readResult('PROVIDER_CLOCK_INVALID'); }
    const slot: ProviderSlot | undefined = this.find(id);
    if (slot === undefined) { return this.readResult('PROVIDER_UNAVAILABLE'); }
    if (slot.revoked) { return this.readResult('PROVIDER_UNREGISTERED'); }
    if (slot.pendingRead || slot.pendingClose) { return this.readResult('PROVIDER_BUSY'); }
    if (slot.reads >= 256) { return this.readResult('PROVIDER_READ_QUOTA'); }
    const provider: SummaryProvider | undefined = slot.provider;
    if (provider === undefined) { return this.readResult('PROVIDER_UNAVAILABLE'); }
    if (!Number.isSafeInteger(this.lastTime + timeoutMs)) {
      this.invalidateClock(); return this.readResult('PROVIDER_CLOCK_INVALID');
    }
    const operation = new ProviderReadOperation();
    operation.deadline = this.lastTime + timeoutMs;
    slot.operation = operation; slot.pendingRead = true; slot.reads++;
    return new Promise<ProviderReadResult>((resolve): void => {
      operation.finish = resolve;
      operation.timer = setTimeout((): void => {
        this.finishRead(operation, new ProviderReadResult('PROVIDER_TIMEOUT'));
      }, timeoutMs);
      try {
        provider.read().then((fields: Record<string, Object>): void => {
          this.readSettled(slot, operation, fields);
        }, (): void => { this.readSettled(slot, operation); });
      } catch (_) { this.readSettled(slot, operation); }
    });
  }
  status(): ProviderStatus[] {
    if (!this.enabled) { return []; }
    this.observeClock();
    return this.slots.map((slot: ProviderSlot): ProviderStatus => {
      const status = new ProviderStatus();
      status.id = slot.id; status.eventName = slot.eventName;
      status.reads = slot.reads; status.errors = slot.errors; status.rejectedFields = slot.rejectedFields;
      status.pending = slot.pendingRead || slot.pendingClose;
      status.state = slot.cleaned ? 'unregistered' : slot.cleanupRequired ? 'cleanup-required' :
        slot.revoked ? 'closing' : slot.pendingRead ? 'pending' : 'registered';
      return status;
    });
  }
  unregister(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    if (!timeoutValid(timeoutMs)) { return this.result('PROVIDER_TIMEOUT_INVALID'); }
    const slot: ProviderSlot | undefined = this.find(id);
    if (slot === undefined) { return this.result('PROVIDER_UNAVAILABLE'); }
    slot.revoked = true;
    if (slot.operation !== undefined) {
      this.finishRead(slot.operation, new ProviderReadResult('PROVIDER_CANCELLED'));
    }
    return this.closeSlot(slot, timeoutMs);
  }
  retryCleanup(id: string, timeoutMs: number = 1000): Promise<CoreResult> {
    if (!timeoutValid(timeoutMs)) { return this.result('PROVIDER_TIMEOUT_INVALID'); }
    const slot: ProviderSlot | undefined = this.find(id);
    if (slot === undefined) { return this.result('PROVIDER_UNAVAILABLE'); }
    if (!slot.revoked) { return this.result('PROVIDER_NOT_REVOKED'); }
    if (slot.pendingRead || slot.pendingClose) { return this.result('PROVIDER_PENDING'); }
    slot.cleanupRequired = false;
    return this.closeSlot(slot, timeoutMs);
  }
  async dispose(): Promise<CoreResult> {
    this.disposed = true;
    const pending: Promise<CoreResult>[] = this.slots.map((slot: ProviderSlot): Promise<CoreResult> =>
      this.unregister(slot.id));
    await Promise.all<CoreResult>(pending);
    return new CoreResult(this.slots.some((slot: ProviderSlot): boolean => !slot.cleaned) ?
      'PROVIDER_CLEANUP_REQUIRED' : 'DISPOSED');
  }
  private find(id: string): ProviderSlot | undefined {
    return this.slots.find((slot: ProviderSlot): boolean => slot.id === id);
  }
  private result(code: string): Promise<CoreResult> {
    return Promise.resolve<CoreResult>(new CoreResult(code));
  }
  private readResult(code: string): Promise<ProviderReadResult> {
    return Promise.resolve<ProviderReadResult>(new ProviderReadResult(code));
  }
  private observeClock(): boolean {
    if (this.clockInvalid) { return false; }
    try {
      const value: number = this.now();
      if (Number.isSafeInteger(value) && value >= this.lastTime) {
        this.lastTime = value;
        for (const slot of this.slots) {
          if (slot.operation !== undefined && value >= slot.operation.deadline) {
            this.finishRead(slot.operation, new ProviderReadResult('PROVIDER_TIMEOUT'));
          }
        }
        return true;
      }
    } catch (_) {}
    this.invalidateClock();
    return false;
  }
  private invalidateClock(): void {
    this.clockInvalid = true;
    for (const slot of this.slots) {
      if (slot.operation !== undefined) {
        this.finishRead(slot.operation, new ProviderReadResult('PROVIDER_CLOCK_INVALID'));
      }
    }
  }
  private finishRead(operation: ProviderReadOperation, result: ProviderReadResult): void {
    if (!operation.active) { return; }
    operation.active = false;
    if (operation.timer !== -1) { clearTimeout(operation.timer); operation.timer = -1; }
    const finish: ((result: ProviderReadResult) => void) | undefined = operation.finish;
    operation.finish = undefined; finish?.(result);
  }
  private readSettled(slot: ProviderSlot, operation: ProviderReadOperation,
    fields: Record<string, Object> | undefined = undefined): void {
    slot.pendingRead = false;
    if (operation.active) {
      const valid: boolean = this.observeClock();
      if (!valid) { this.finishRead(operation, new ProviderReadResult('PROVIDER_CLOCK_INVALID')); }
      else if (this.lastTime >= operation.deadline) {
        this.finishRead(operation, new ProviderReadResult('PROVIDER_TIMEOUT'));
      } else if (fields === undefined) {
        slot.errors++; this.finishRead(operation, new ProviderReadResult('PROVIDER_READ_FAILED'));
      } else {
        const projection: CoreProjection | undefined = slot.registry.project(slot.eventName, fields);
        const result = new ProviderReadResult(projection?.valid ? 'CAPTURED' : 'PROVIDER_FIELDS_INVALID');
        if (projection !== undefined && projection.valid) {
          result.fields = projection.fields; result.rejectedFields = projection.rejected;
          slot.rejectedFields += projection.rejected;
        } else { slot.errors++; }
        this.finishRead(operation, result);
      }
    }
    if (slot.operation === operation) { slot.operation = undefined; }
    if (slot.revoked && !slot.cleaned && !slot.cleanupRequired) {
      this.closeSlot(slot, 1000).then((): void => {});
    }
  }
  private closeSlot(slot: ProviderSlot, timeoutMs: number): Promise<CoreResult> {
    if (slot.cleaned) { return this.result('UNREGISTERED'); }
    if (slot.pendingRead || slot.pendingClose) { return this.result('PROVIDER_PENDING'); }
    if (slot.cleanupRequired) { return this.result('PROVIDER_CLEANUP_REQUIRED'); }
    const provider: SummaryProvider | undefined = slot.provider;
    if (provider === undefined) { return this.result('PROVIDER_CLEANUP_REQUIRED'); }
    this.observeClock();
    const operation = new ProviderCloseOperation();
    operation.deadline = this.lastTime + timeoutMs; slot.pendingClose = true;
    return new Promise<CoreResult>((resolve): void => {
      operation.finish = resolve;
      operation.timer = setTimeout((): void => {
        slot.cleanupRequired = true; this.finishClose(operation, 'PROVIDER_CLEANUP_REQUIRED');
      }, timeoutMs);
      try {
        provider.close().then((closed: boolean): void => {
          this.closeSettled(slot, operation, closed);
        }, (): void => { this.closeSettled(slot, operation, false); });
      } catch (_) { this.closeSettled(slot, operation, false); }
    });
  }
  private closeSettled(slot: ProviderSlot, operation: ProviderCloseOperation, closed: boolean): void {
    slot.pendingClose = false;
    // A late close return never repairs a timeout receipt; only an explicit retry may do so.
    if (!operation.active) { return; }
    const timely: boolean = this.clockInvalid || (this.observeClock() && this.lastTime < operation.deadline);
    if (closed === true && timely) {
      slot.cleaned = true; slot.cleanupRequired = false; slot.provider = undefined;
      this.finishClose(operation, 'UNREGISTERED');
    } else {
      slot.errors++; slot.cleanupRequired = true;
      this.finishClose(operation, 'PROVIDER_CLEANUP_REQUIRED');
    }
  }
  private finishClose(operation: ProviderCloseOperation, code: string): void {
    if (!operation.active) { return; }
    operation.active = false;
    if (operation.timer !== -1) { clearTimeout(operation.timer); operation.timer = -1; }
    const finish: ((result: CoreResult) => void) | undefined = operation.finish;
    operation.finish = undefined; finish?.(new CoreResult(code));
  }
}
