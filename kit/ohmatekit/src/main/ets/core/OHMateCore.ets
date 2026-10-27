/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreArchiveResult, CoreClock, CoreEnvelope, CoreEvent, CoreFault, CoreHealth, CoreHost, CoreLoss, CoreOptions,
  CorePriority, CoreProblem, CoreResult, CoreSchema, CoreSegment, CoreValue } from '../api/CoreTypes';
import { CorePruneSummary } from '../api/CoreTypes';
import { coreIdentifier, SchemaRegistry } from './SchemaRegistry';
import { EventRing } from '../recorder/EventRing';
import { ProblemStore } from './ProblemStore';
import { recoverSegments } from '../recorder/SegmentRecovery';

// Recovery already bounds one segment to 1024 events and 512 KiB. A session keeps
// extending its newest segment within those bounds instead of spending one of the
// 256 global slots per flush; the host only accepts a verified event prefix.
const SEGMENT_EVENTS: number = 1024;
const SEGMENT_BYTES: number = 524288;
function budget(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
export function optionsValid(options: CoreOptions): boolean {
  const keys: string[] = Object.keys(options);
  const expected: string[] = Object.keys(new CoreOptions());
  return keys.length === expected.length && keys.every((key: string): boolean => expected.includes(key)) &&
    typeof options.buildId === 'string' && options.buildId.length <= 128 &&
    new RegExp('^[A-Za-z0-9_.@-]*$').test(options.buildId) &&
    Number.isFinite(options.sampling) && options.sampling >= 0 && options.sampling <= 1 &&
    budget(options.maxRecords, 4, 1024) && budget(options.maxBufferBytes, 4096, 262144) &&
    budget(options.criticalReserveRecords, 1, options.maxRecords - 1) &&
    budget(options.criticalReserveBytes, 1024, options.maxBufferBytes - 1024) &&
    budget(options.maxStorageBytes, 65536, 5242880) && budget(options.maxProblems, 1, 20) &&
    budget(options.retentionDays, 1, 7) && budget(options.flushIntervalMs, 100, 60000) &&
    budget(options.closeTimeoutMs, 1, 1000);
}
export function copyOptions(input: CoreOptions): CoreOptions {
  const output = new CoreOptions();
  output.buildId = input.buildId; output.sampling = input.sampling;
  output.maxRecords = input.maxRecords; output.maxBufferBytes = input.maxBufferBytes;
  output.criticalReserveRecords = input.criticalReserveRecords; output.criticalReserveBytes = input.criticalReserveBytes;
  output.maxStorageBytes = input.maxStorageBytes; output.maxProblems = input.maxProblems;
  output.retentionDays = input.retentionDays; output.flushIntervalMs = input.flushIntervalMs;
  output.closeTimeoutMs = input.closeTimeoutMs; return output;
}
export class OHMateCore {
  private host: CoreHost;
  private schemas: SchemaRegistry = new SchemaRegistry();
  private options: CoreOptions = new CoreOptions();
  private optionKey: string = '';
  private health: CoreHealth = new CoreHealth();
  private ring: EventRing | undefined = undefined;
  private problems: ProblemStore | undefined = undefined;
  private pending: CoreEvent[] = [];
  private pendingText: string = '';
  private pendingCost: number = 0;
  private pendingEvents: CoreEvent[] = [];
  private pendingExtend: boolean = false;
  private open: CoreEvent[] = [];
  private openCost: number = 0;
  private inFlight: Promise<CoreResult> | undefined = undefined;
  private starting: Promise<CoreResult> | undefined = undefined;
  private closing: Promise<CoreResult> | undefined = undefined;
  private timer: number = -1;
  private idleTicks: number = 0;
  private sequence: number = 0;
  private lastClock: CoreClock | undefined = undefined;
  private recent: CoreEvent[] = [];
  private recentBytes: number = 0;
  private closeSequence: number = 0;
  private committedSequence: number = 0;
  private writingCost: number = 0;
  private disposed: boolean = false;
  private maintaining: boolean = false;
  constructor(host: CoreHost) { this.host = host; }
  registerSchema(schema: CoreSchema): CoreResult {
    return this.health.state === 'created' ? this.schemas.register(schema) : new CoreResult('SCHEMA_REGISTRATION_CLOSED');
  }
  start(options: CoreOptions = new CoreOptions()): Promise<CoreResult> {
    try {
      if (this.disposed) { return Promise.resolve<CoreResult>(new CoreResult('DISPOSED')); }
      if (!optionsValid(options)) { return Promise.resolve<CoreResult>(new CoreResult('OPTIONS_INVALID')); }
      const normalized: CoreOptions = copyOptions(options), key: string = JSON.stringify(normalized);
      if (this.optionKey !== '') {
        if (key !== this.optionKey) { return Promise.resolve<CoreResult>(new CoreResult('START_OPTIONS_CONFLICT')); }
        return this.starting ?? Promise.resolve<CoreResult>(new CoreResult('ALREADY_STARTED'));
      }
      this.options = normalized; this.optionKey = key;
      this.ring = new EventRing(this.options, this.host); this.problems = new ProblemStore(this.host, this.options);
      this.health.state = 'starting';
      const operation: Promise<CoreResult> = this.initialize(); this.starting = operation;
      operation.then((): void => { this.starting = undefined; });
      return operation;
    } catch (_) { return Promise.resolve<CoreResult>(new CoreResult('OPTIONS_INVALID')); }
  }
  private async initialize(): Promise<CoreResult> {
    try {
      const sessionId: string = this.host.sessionId();
      if (!coreIdentifier(sessionId)) { throw new Error('SESSION_ID_INVALID'); }
      this.health.sessionId = sessionId;
      const history: string[] = await this.host.recover();
      if (this.disposed) { return new CoreResult('START_CANCELLED'); }
      const recovery = recoverSegments(history, this.host, this.options, this.schemas);
      this.health.recovery = recovery.status; this.health.storageBytes = recovery.bytes;
      await this.problems?.recover(this.schemas);
      if (this.disposed) { return new CoreResult('START_CANCELLED'); }
      this.health.state = 'active';
      if (!this.enqueue('active', 'high', 'recorder', {})) { throw new Error('CLOCK_INVALID'); }
      const committed: CoreResult = await this.flush();
      if (this.disposed) { return new CoreResult('START_CANCELLED'); }
      if (committed.code !== 'FLUSHED') { this.health.storage = 'degraded'; }
      this.timer = setInterval((): void => { this.heartbeat(); }, this.options.flushIntervalMs);
      return new CoreResult('STARTED');
    } catch (_) {
      if (this.disposed) { return new CoreResult('START_CANCELLED'); }
      this.health.errors++; this.health.storage = 'degraded';
      this.health.state = this.health.clockValid ? 'active' : 'clock-invalid';
      return new CoreResult('START_DEGRADED');
    }
  }
  private async heartbeat(): Promise<void> {
    if (this.disposed || this.maintaining || this.health.storage === 'degraded' ||
      (this.health.state !== 'active' && this.health.state !== 'paused')) { return; }
    const idle: boolean = this.pending.length === 0 && this.inFlight === undefined &&
      this.ring?.records === 0 && !this.problems?.isBusy();
    this.idleTicks = idle ? this.idleTicks + 1 : 0;
    try {
      if (!this.enqueue('heartbeat', 'high', 'recorder', {})) { return; }
      const result: CoreResult = await this.flush();
      // Retention scans stay out of event/fault paths and run at most once per idle minute.
      if (!this.disposed && result.code === 'FLUSHED' && idle &&
        this.idleTicks >= Math.ceil(60000 / this.options.flushIntervalMs)) {
        this.idleTicks = 0; await this.prune();
      }
    } catch (_) {
      this.health.errors++; this.health.storage = 'degraded'; this.health.durability = 'uncertain';
    }
  }
  private clock(): CoreClock | undefined {
    if (!this.health.clockValid) { return undefined; }
    try {
      const value: CoreClock = this.host.now(), previous: CoreClock | undefined = this.lastClock;
      if (!coreIdentifier(value.clockId) || !coreIdentifier(value.bootId) || !Number.isSafeInteger(value.monotonicNs) ||
        value.monotonicNs < 0 || !new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$').test(value.wallTimeUtc) ||
        (previous !== undefined && (value.clockId !== previous.clockId || value.bootId !== previous.bootId ||
          value.monotonicNs < previous.monotonicNs))) { throw new Error('CLOCK_INVALID'); }
      const copied: CoreClock = { clockId: value.clockId, bootId: value.bootId,
        monotonicNs: value.monotonicNs, wallTimeUtc: value.wallTimeUtc };
      this.lastClock = copied; return copied;
    } catch (_) {
      this.health.clockValid = false; this.health.errors++; this.problems?.invalidateReviews(); return undefined;
    }
  }
  private enqueue(name: string, priority: CorePriority, source: 'application' | 'recorder',
    fields: Record<string, CoreValue>): boolean {
    const clock: CoreClock | undefined = this.clock(), ring: EventRing | undefined = this.ring;
    if (clock === undefined || ring === undefined || !Number.isSafeInteger(this.sequence + 1)) { return false; }
    const event: CoreEvent = { sequence: ++this.sequence, name, priority, source,
      sessionId: this.health.sessionId, clock, fields };
    try { return ring.push(event, this.pending.length, this.pendingCost); }
    catch (_) { ring.drop(event); this.health.errors++; return false; }
  }
  mark(name: string, fields: Record<string, Object>): CoreResult {
    if (this.clock() === undefined) { return new CoreResult('CLOCK_INVALID'); }
    if (this.health.state !== 'active' && this.health.state !== 'paused') { return new CoreResult('NOT_ACTIVE'); }
    const projection = this.schemas.project(name, fields);
    if (projection === undefined) { this.health.unknownEvents++; return new CoreResult('SCHEMA_NOT_REGISTERED'); }
    this.health.rejectedFields += projection.rejected;
    if (!projection.valid) { return new CoreResult('FIELDS_INVALID'); }
    if (this.health.state === 'paused') { this.health.pausedDropped++; return new CoreResult('PAUSED'); }
    try {
      const sample: number = this.host.random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) { return new CoreResult('SAMPLER_INVALID'); }
      if (sample >= this.options.sampling) { this.health.sampled++; return new CoreResult('SAMPLED'); }
    } catch (_) { this.health.errors++; return new CoreResult('SAMPLER_INVALID'); }
    return new CoreResult(this.enqueue(name, 'normal', 'application', projection.fields) ? 'RECORDED' : 'BUFFER_DROPPED');
  }
  recordFault(fault: CoreFault): CoreResult {
    if (this.clock() === undefined) { return new CoreResult('CLOCK_INVALID'); }
    if (this.health.state !== 'active' && this.health.state !== 'paused') { return new CoreResult('NOT_ACTIVE'); }
    if (!['crash', 'freeze', 'oom', 'render-exit', 'unhandled-error'].includes(fault)) { return new CoreResult('FAULT_INVALID'); }
    return new CoreResult(this.enqueue(fault, 'critical', 'application', {}) ? 'RECORDED' : 'BUFFER_DROPPED');
  }
  pause(): CoreResult {
    if (this.clock() === undefined) { return new CoreResult('CLOCK_INVALID'); }
    if (this.health.state !== 'active') { return new CoreResult('NOT_ACTIVE'); }
    this.enqueue('pause', 'high', 'recorder', {}); this.health.state = 'paused'; return new CoreResult('PAUSED');
  }
  resume(): CoreResult {
    if (this.clock() === undefined) { return new CoreResult('CLOCK_INVALID'); }
    if (this.health.state !== 'paused') { return new CoreResult('NOT_PAUSED'); }
    this.enqueue('resume', 'high', 'recorder', {}); this.health.state = 'active'; return new CoreResult('RESUMED');
  }
  private segmentText(events: CoreEvent[]): string {
    const segment: CoreSegment = { schemaVersion: '1.0', sessionId: this.health.sessionId,
      buildId: this.options.buildId, buildVerification: 'unverified-build', firstSequence: events[0].sequence,
      lastSequence: events[events.length - 1].sequence, events: events,
      loss: this.ring === undefined ? new CoreLoss() : this.ring.loss };
    const payload: string = JSON.stringify(segment);
    const envelope: CoreEnvelope = { schemaVersion: '1.0', bytes: this.host.byteLength(payload),
      sha256: this.host.hash(payload), payload };
    return JSON.stringify(envelope);
  }
  flush(): Promise<CoreResult> {
    if (this.maintaining) { return Promise.resolve<CoreResult>(new CoreResult('STORAGE_BUSY')); }
    if (this.inFlight !== undefined) { return this.inFlight; }
    if (this.ring === undefined) { return Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE')); }
    if (this.pending.length === 0) {
      this.pending = this.ring.drain();
      if (this.pending.length === 0) { return Promise.resolve<CoreResult>(new CoreResult('EMPTY')); }
      this.pendingCost = this.pending.reduce((cost: number, event: CoreEvent): number =>
        cost + this.host.byteLength(JSON.stringify(event)), 0);
      this.pendingEvents = this.pending; this.pendingText = this.segmentText(this.pending); this.pendingExtend = false;
      if (this.open.length > 0 && this.host.extendSegment !== undefined &&
        this.open.length + this.pending.length <= SEGMENT_EVENTS) {
        const combined: CoreEvent[] = this.open.concat(this.pending);
        const text: string = this.segmentText(combined);
        if (this.host.byteLength(text) <= SEGMENT_BYTES) {
          this.pendingEvents = combined; this.pendingText = text; this.pendingExtend = true;
        }
      }
    }
    const operation: Promise<CoreResult> = this.appendPending(); this.inFlight = operation;
    operation.then((): void => { this.inFlight = undefined; });
    return operation;
  }
  private async appendPending(): Promise<CoreResult> {
    try {
      const cost: number = this.host.byteLength(this.pendingText);
      const delta: number = this.pendingExtend ? Math.max(0, cost - this.openCost) : cost;
      const reserved: number = this.pending.some((event: CoreEvent): boolean => event.priority === 'critical') ? 0 : 32768;
      if (this.health.storageBytes + (this.problems?.bytes ?? 0) + delta >
        this.options.maxStorageBytes - reserved) { throw new Error('STORAGE_QUOTA'); }
      this.writingCost = cost;
      const extension: Promise<'synced' | 'uncertain'> | undefined =
        this.pendingExtend ? this.host.extendSegment?.(this.pendingText) : undefined;
      const durability: string = extension === undefined ? await this.host.append(this.pendingText) : await extension;
      if (durability !== 'synced') { throw new Error('STORAGE_UNCERTAIN'); }
      this.health.storageBytes += delta; this.health.durability = 'host-reported-synced'; this.health.storage = 'available';
      this.open = this.pendingEvents; this.openCost = cost;
      this.committedSequence = this.pending[this.pending.length - 1].sequence;
      this.recent = this.pending.slice(); this.recentBytes = this.pendingCost;
      while (this.recentBytes > 12288 && this.recent.length > 0) {
        const old: CoreEvent | undefined = this.recent.shift();
        if (old !== undefined) { this.recentBytes -= this.host.byteLength(JSON.stringify(old)); }
      }
      this.pending = []; this.pendingText = ''; this.pendingCost = 0; this.pendingEvents = []; return new CoreResult('FLUSHED');
    } catch (_) {
      this.health.errors++; this.health.storage = 'degraded'; this.health.durability = 'uncertain';
      return new CoreResult('STORAGE_DEGRADED');
    } finally { if (this.pendingText === '') { this.writingCost = 0; } }
  }
  private clearTimer(): void { if (this.timer !== -1) { clearInterval(this.timer); this.timer = -1; } }
  stopNormally(): Promise<CoreResult> {
    this.clearTimer();
    if (this.health.state === 'closed') { return Promise.resolve<CoreResult>(new CoreResult('CLOSED')); }
    if (this.health.state === 'close_uncertain') { return Promise.resolve<CoreResult>(new CoreResult('CLOSE_UNCERTAIN')); }
    if (this.closing !== undefined) { return this.closing; }
    if (this.health.state !== 'active' && this.health.state !== 'paused') {
      return Promise.resolve<CoreResult>(new CoreResult('NOT_ACTIVE'));
    }
    this.health.state = 'stopping';
    if (!this.enqueue('close', 'high', 'recorder', {})) {
      this.health.state = 'close_uncertain'; return Promise.resolve<CoreResult>(new CoreResult('CLOSE_UNCERTAIN'));
    }
    this.closeSequence = this.sequence; this.closing = this.closeBounded(); return this.closing;
  }
  private async closeBounded(): Promise<CoreResult> {
    let timer: number = -1;
    const expired: Promise<boolean> = new Promise<boolean>((resolve): void => {
      timer = setTimeout((): void => resolve(false), this.options.closeTimeoutMs);
    });
    const done: boolean = await Promise.race<boolean>([this.drainClose(), expired]);
    if (timer !== -1) { clearTimeout(timer); }
    this.health.state = done ? 'closed' : 'close_uncertain';
    return new CoreResult(done ? 'CLOSED' : 'CLOSE_UNCERTAIN');
  }
  private async drainClose(): Promise<boolean> {
    while (this.health.state === 'stopping' && this.committedSequence < this.closeSequence) {
      const result: CoreResult = await this.flush();
      if (result.code !== 'FLUSHED') { return false; }
    }
    return this.health.state === 'stopping' && this.committedSequence >= this.closeSequence;
  }
  async dispose(): Promise<CoreResult> {
    this.clearTimer(); this.disposed = true; this.problems?.dispose();
    if (this.health.state === 'starting') { this.health.state = 'disposed'; return new CoreResult('START_CANCELLED'); }
    return this.stopNormally();
  }
  getHealth(): CoreHealth {
    if (this.health.state !== 'created') { this.clock(); }
    const copied: CoreHealth = JSON.parse(JSON.stringify(this.health)) as CoreHealth;
    copied.bufferRecords = this.ring?.records ?? 0; copied.bufferBytes = this.ring?.bytes ?? 0;
    copied.pendingRecords = this.pending.length; copied.pendingBytes = this.pendingCost;
    copied.problemRecovery = this.problems?.recovery ?? 'unavailable'; copied.problemBytes = this.problems?.bytes ?? 0;
    copied.dropped = this.ring?.loss.dropped ?? 0; copied.criticalDropped = this.ring?.loss.criticalDropped ?? 0;
    try {
      const accounted: number = this.host.accountedStorageBytes?.() ?? -1;
      if (Number.isSafeInteger(accounted) && accounted >= 0) {
        copied.storageAccountedBytes = accounted; copied.storageAccounting = 'host-reported';
      }
    } catch (_) {}
    return copied;
  }
  async createProblem(): Promise<CoreResult> {
    if (this.maintaining) { return new CoreResult('STORAGE_BUSY'); }
    if (this.health.state !== 'active' && this.health.state !== 'paused') { return new CoreResult('NOT_ACTIVE'); }
    const ring: EventRing | undefined = this.ring, store: ProblemStore | undefined = this.problems;
    if (ring === undefined || store === undefined) { return new CoreResult('NOT_ACTIVE'); }
    const events: CoreEvent[] = this.recent.concat(this.pending, ring.snapshot());
    return store.create(this.health.sessionId, events, ring.loss,
      this.options.maxStorageBytes - this.health.storageBytes - this.writingCost - store.bytes - 32768);
  }
  listProblems(): CoreProblem[] { return this.problems?.list() ?? []; }
  getProblem(id: string): CoreProblem | undefined { return this.problems?.get(id); }
  reviewExport(id: string): CoreResult {
    if (this.disposed || this.maintaining || this.clock() === undefined) { return new CoreResult('EXPORT_UNAVAILABLE'); }
    return this.problems?.review(id) ?? new CoreResult('NOT_ACTIVE');
  }
  exportProblem(id: string, reviewHash: string = ''): CoreResult {
    if (this.disposed || this.maintaining || this.clock() === undefined) { return new CoreResult('EXPORT_UNAVAILABLE'); }
    return this.problems?.export(id, reviewHash) ?? new CoreResult('NOT_ACTIVE');
  }
  reviewArchive(id: string): CoreResult {
    if (this.disposed || this.maintaining || this.clock() === undefined) { return new CoreResult('ARCHIVE_UNAVAILABLE'); }
    return this.problems?.reviewArchive(id, this.schemas) ?? new CoreResult('NOT_ACTIVE');
  }
  exportArchive(id: string, reviewHash: string = ''): CoreArchiveResult {
    if (this.disposed || this.maintaining || this.clock() === undefined) { return new CoreArchiveResult('ARCHIVE_UNAVAILABLE'); }
    return this.problems?.exportArchive(id, reviewHash, this.schemas) ?? new CoreArchiveResult('NOT_ACTIVE');
  }
  async deleteProblem(id: string): Promise<CoreResult> {
    if (this.maintaining) { return new CoreResult('STORAGE_BUSY'); }
    return this.problems === undefined ? new CoreResult('NOT_ACTIVE') : this.problems.delete(id);
  }
  async prune(): Promise<CoreResult> {
    if (this.disposed || (this.health.state !== 'active' && this.health.state !== 'paused')) {
      return new CoreResult('NOT_ACTIVE');
    }
    if (this.host.prune === undefined) { return new CoreResult('PRUNE_UNAVAILABLE'); }
    if (this.maintaining || this.inFlight !== undefined || this.problems?.isBusy()) { return new CoreResult('STORAGE_BUSY'); }
    this.problems?.invalidateReviews();
    this.maintaining = true;
    try {
      const summary: CorePruneSummary = await this.host.prune();
      if (this.disposed) { return new CoreResult('PRUNE_CANCELLED'); }
      if (!['PRUNED', 'PRUNE_UNCERTAIN'].includes(summary.code) || !Number.isSafeInteger(summary.segmentBytes) ||
        summary.segmentBytes < 0 || summary.segmentBytes > this.options.maxStorageBytes ||
        !Array.isArray(summary.deletedProblems) || summary.deletedProblems.length > this.options.maxProblems ||
        !summary.deletedProblems.every((id: string): boolean => typeof id === 'string' &&
          coreIdentifier(id) && id.startsWith('problem-')) ||
        new Set<string>(summary.deletedProblems).size !== summary.deletedProblems.length) {
        this.problems?.suspendExports();
        return new CoreResult('PRUNE_UNCERTAIN');
      }
      this.problems?.forget(summary.deletedProblems); this.health.storageBytes = summary.segmentBytes;
      if (summary.code !== 'PRUNED') {
        this.health.errors++; this.health.storage = 'degraded'; this.health.durability = 'uncertain';
        return new CoreResult('PRUNE_UNCERTAIN');
      }
      return new CoreResult('PRUNED');
    } catch (_) {
      this.problems?.suspendExports();
      this.health.errors++; this.health.storage = 'degraded'; this.health.durability = 'uncertain';
      return new CoreResult('PRUNE_UNCERTAIN');
    }
    finally { this.maintaining = false; }
  }
}
