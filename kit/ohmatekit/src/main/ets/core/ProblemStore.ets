/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreArchiveResult, CoreEvent, CoreHost, CoreLoss, CoreOptions, CoreProblem, CoreResult } from '../api/CoreTypes';
import { problemValid } from './ProblemRecovery';
import { SchemaRegistry } from './SchemaRegistry';
import { coreByteHash, makeCoreArchive } from './CoreProblemArchive';

class StoredProblem {
  problem: CoreProblem;
  text: string;
  reviewHash: string = '';
  archiveHash: string = '';
  synced: boolean = false;
  constructor(problem: CoreProblem, text: string) { this.problem = problem; this.text = text; }
}
export class ProblemStore {
  private host: CoreHost;
  private options: CoreOptions;
  private records: StoredProblem[] = [];
  private next: number = 0;
  private busy: boolean = false;
  private disposed: boolean = false;
  bytes: number = 0;
  recovery: string = 'unavailable';
  constructor(host: CoreHost, options: CoreOptions) { this.host = host; this.options = options; }
  async recover(schemas: SchemaRegistry): Promise<void> {
    if (this.host.recoverProblems === undefined) { return; }
    this.busy = true;
    try {
      const history: string[] = await this.host.recoverProblems();
      if (this.disposed) { return; }
      if (!Array.isArray(history) || history.length > this.options.maxProblems) { throw new Error('PROBLEM_BOUND'); }
      const restored: StoredProblem[] = [];
      for (const text of history) {
        const cost: number = this.host.byteLength(text);
        this.bytes += cost;
        if (cost > 16384 || this.bytes > this.options.maxStorageBytes) { throw new Error('PROBLEM_BOUND'); }
        const problem: CoreProblem = JSON.parse(text) as CoreProblem;
        if (!problemValid(problem, schemas) ||
          restored.some((item: StoredProblem): boolean => item.problem.problemId === problem.problemId)) {
          throw new Error('PROBLEM_SCHEMA');
        }
        const record = new StoredProblem(problem, text); record.synced = true; restored.push(record);
      }
      this.records = restored; this.recovery = restored.length === 0 ? 'none' : 'recovered';
    } catch (_) { this.recovery = 'corrupt'; this.bytes = this.options.maxStorageBytes; }
    finally { this.busy = false; }
  }
  dispose(): void { this.disposed = true; this.invalidateReviews(); }
  invalidateReviews(): void {
    for (const record of this.records) { record.reviewHash = ''; record.archiveHash = ''; }
  }
  suspendExports(): void {
    this.invalidateReviews();
    for (const record of this.records) { record.synced = false; }
  }
  isBusy(): boolean { return this.busy; }
  forget(ids: string[]): void {
    for (const record of this.records.filter((item: StoredProblem): boolean => ids.includes(item.problem.problemId))) {
      this.bytes -= this.host.byteLength(record.text);
    }
    this.records = this.records.filter((item: StoredProblem): boolean => !ids.includes(item.problem.problemId));
  }
  private triage(problem: CoreProblem): void {
    const fault: CoreEvent | undefined = problem.events.find((event: CoreEvent): boolean =>
      event.source === 'application' && event.priority === 'critical');
    problem.triage.fault = fault?.name ?? 'unknown';
    problem.triage.confidence = fault === undefined ? 'insufficient-evidence' : 'single-reported-clue';
  }
  async create(sessionId: string, events: CoreEvent[], loss: CoreLoss, remaining: number): Promise<CoreResult> {
    if (this.disposed) { return new CoreResult('PROBLEM_CANCELLED'); }
    if (this.busy) { return new CoreResult('PROBLEM_STORE_BUSY'); }
    if (remaining < 0 || this.recovery === 'corrupt') { return new CoreResult('STORAGE_QUOTA'); }
    if (this.records.length >= this.options.maxProblems || this.next >= 256) { return new CoreResult('PROBLEM_QUOTA'); }
    this.busy = true;
    try {
      const problem = new CoreProblem();
      do { problem.problemId = 'problem-' + sessionId + '-' + (++this.next); }
      while (this.records.some((item: StoredProblem): boolean => item.problem.problemId === problem.problemId) && this.next < 256);
      if (this.records.some((item: StoredProblem): boolean => item.problem.problemId === problem.problemId)) {
        return new CoreResult('PROBLEM_QUOTA');
      }
      problem.sessionId = sessionId; problem.buildId = this.options.buildId;
      problem.events = JSON.parse(JSON.stringify(events)) as CoreEvent[];
      problem.loss = JSON.parse(JSON.stringify(loss)) as CoreLoss;
      this.triage(problem);
      let text: string = JSON.stringify(problem);
      while (this.host.byteLength(text) > 16384 && problem.events.length > 0) {
        const removed: CoreEvent | undefined = problem.events.shift();
        if (removed !== undefined) {
          problem.loss.dropped++; problem.loss.firstSequence = problem.loss.firstSequence || removed.sequence;
          problem.loss.lastSequence = Math.max(problem.loss.lastSequence, removed.sequence);
          if (removed.priority === 'critical') { problem.loss.criticalDropped++; }
        }
        this.triage(problem); text = JSON.stringify(problem);
      }
      if (this.host.byteLength(text) > Math.min(16384, remaining)) { return new CoreResult('STORAGE_QUOTA'); }
      const record = new StoredProblem(problem, text);
      this.records.push(record); this.bytes += this.host.byteLength(text);
      const state: string = await this.host.saveProblem(problem.problemId, text);
      if (this.disposed) { return new CoreResult('PROBLEM_CANCELLED'); }
      if (state !== 'synced') { return new CoreResult('PROBLEM_DURABILITY_UNCERTAIN'); }
      record.synced = true;
      const result = new CoreResult('PROBLEM_CREATED'); result.problemId = problem.problemId;
      return result;
    } catch (_) { return new CoreResult('STORAGE_DEGRADED'); }
    finally { this.busy = false; }
  }
  list(): CoreProblem[] {
    return this.records.filter((item: StoredProblem): boolean => item.synced)
      .map((item: StoredProblem): CoreProblem => JSON.parse(JSON.stringify(item.problem)) as CoreProblem);
  }
  get(id: string): CoreProblem | undefined {
    const record: StoredProblem | undefined = this.records.find((item: StoredProblem): boolean =>
      item.synced && item.problem.problemId === id);
    return record === undefined ? undefined : JSON.parse(JSON.stringify(record.problem)) as CoreProblem;
  }
  review(id: string): CoreResult {
    if (this.disposed || this.busy) { return new CoreResult('EXPORT_UNAVAILABLE'); }
    const record: StoredProblem | undefined = this.records.find((item: StoredProblem): boolean => item.problem.problemId === id);
    if (record === undefined || !record.synced) { return new CoreResult('PROBLEM_NOT_FOUND'); }
    record.reviewHash = this.host.hash(record.text);
    const result = new CoreResult('EXPORT_REVIEWED'); result.problemId = id; result.reviewHash = record.reviewHash;
    return result;
  }
  export(id: string, reviewHash: string): CoreResult {
    if (this.disposed || this.busy) { return new CoreResult('EXPORT_UNAVAILABLE'); }
    const record: StoredProblem | undefined = this.records.find((item: StoredProblem): boolean => item.problem.problemId === id);
    if (record === undefined || !record.synced) { return new CoreResult('PROBLEM_NOT_FOUND'); }
    if (record.reviewHash.length !== 64 || reviewHash !== record.reviewHash || this.host.hash(record.text) !== reviewHash) {
      return new CoreResult('EXPORT_REVIEW_REQUIRED');
    }
    const result = new CoreResult('EXPORTED'); result.problemId = id; result.text = record.text;
    return result;
  }
  reviewArchive(id: string, schemas: SchemaRegistry): CoreResult {
    const record: StoredProblem | undefined = this.records.find((item: StoredProblem): boolean => item.problem.problemId === id);
    if (record === undefined || !record.synced) { return new CoreResult('PROBLEM_NOT_FOUND'); }
    record.archiveHash = '';
    if (this.disposed || this.busy) { return new CoreResult('ARCHIVE_UNAVAILABLE'); }
    try {
      const build = makeCoreArchive(record.text, schemas, this.host);
      const hash: string = coreByteHash(this.host, build.bytes);
      if (this.disposed || this.busy || !this.records.includes(record) || !record.synced) {
        return new CoreResult('ARCHIVE_UNAVAILABLE');
      }
      record.archiveHash = hash;
      const result = new CoreResult('ARCHIVE_REVIEWED');
      result.problemId = id; result.reviewHash = hash; result.text = build.review; return result;
    } catch (_) { return new CoreResult('ARCHIVE_UNAVAILABLE'); }
  }
  exportArchive(id: string, reviewHash: string, schemas: SchemaRegistry): CoreArchiveResult {
    const record: StoredProblem | undefined = this.records.find((item: StoredProblem): boolean => item.problem.problemId === id);
    if (record === undefined || !record.synced) { return new CoreArchiveResult('PROBLEM_NOT_FOUND'); }
    if (this.disposed || this.busy) { return new CoreArchiveResult('ARCHIVE_UNAVAILABLE'); }
    if (record.archiveHash.length !== 64 || reviewHash !== record.archiveHash) {
      return new CoreArchiveResult('EXPORT_REVIEW_REQUIRED');
    }
    try {
      const build = makeCoreArchive(record.text, schemas, this.host);
      if (coreByteHash(this.host, build.bytes) !== reviewHash || this.disposed || this.busy ||
        !this.records.includes(record) || !record.synced || record.archiveHash !== reviewHash) {
        record.archiveHash = ''; return new CoreArchiveResult('EXPORT_REVIEW_REQUIRED');
      }
      const result = new CoreArchiveResult('ARCHIVE_EXPORTED');
      result.problemId = id; result.reviewHash = reviewHash; result.archive = build.bytes.slice();
      result.fileName = id + '.ohmate-problem.zip'; return result;
    } catch (_) { record.archiveHash = ''; return new CoreArchiveResult('ARCHIVE_UNAVAILABLE'); }
  }
  async delete(id: string): Promise<CoreResult> {
    if (this.disposed) { return new CoreResult('PROBLEM_CANCELLED'); }
    if (this.busy) { return new CoreResult('PROBLEM_STORE_BUSY'); }
    const index: number = this.records.findIndex((item: StoredProblem): boolean => item.problem.problemId === id);
    if (index < 0) { return new CoreResult('PROBLEM_NOT_FOUND'); }
    this.records[index].reviewHash = ''; this.records[index].archiveHash = '';
    // The host boolean cannot distinguish failure before unlink from failure after unlink.
    // Keep the reservation and allow explicit retry, but never renew export approval.
    this.records[index].synced = false;
    this.busy = true;
    try {
      if (!await this.host.deleteProblem(id)) { return new CoreResult('PROBLEM_DELETE_UNCERTAIN'); }
      if (this.disposed) { return new CoreResult('PROBLEM_CANCELLED'); }
      this.bytes -= this.host.byteLength(this.records[index].text);
      this.records.splice(index, 1); return new CoreResult('PROBLEM_DELETED');
    } catch (_) { return new CoreResult('STORAGE_DEGRADED'); }
    finally { this.busy = false; }
  }
}
