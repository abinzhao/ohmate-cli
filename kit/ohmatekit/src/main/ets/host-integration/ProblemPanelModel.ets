/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { CoreArchiveResult, CoreProblem, CoreResult, CoreSchema } from '../api/CoreTypes';
import { OHMateCore } from '../core/OHMateCore';
import { coreIdentifier } from '../core/SchemaRegistry';
import { CORE_ARCHIVE_MAX_BYTES } from '../core/StoredZip';
import { ArchiveSaveOwner } from './ArchiveSaveOwner';

interface PanelArchiveFile { path: string; }
interface PanelArchiveReview {
  archiveBytes: number;
  files: PanelArchiveFile[];
  fields: CoreSchema[];
}
function countValid(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

// V2 observes presentation only. Core owns evidence validation and deletion;
// SaveOwner retains the original Picker/file responsibility after cancellation.
@ObservedV2
export class ProblemPanelModel {
  @Trace selectedId: string = '';
  @Trace eventCount: number = 0;
  @Trace dropped: number = 0;
  @Trace criticalDropped: number = 0;
  @Trace lossFirst: number = 0;
  @Trace lossLast: number = 0;
  @Trace triageFault: string = 'unknown';
  @Trace triageConfidence: string = 'insufficient-evidence';
  @Trace archiveFiles: string[] = [];
  @Trace fieldNames: string[] = [];
  @Trace archiveBytes: number = 0;
  @Trace confirmation: string = 'none';
  @Trace busy: boolean = false;
  @Trace deleteUncertain: boolean = false;
  @Trace resultCode: string = '';
  private core: OHMateCore;
  private save: ArchiveSaveOwner;
  private now: () => number;
  private current: () => boolean;
  private active: boolean = true;
  private disposed: boolean = false;
  private selection: string = '';
  private reviewHash: string = '';
  private expires: number = 0;
  private epoch: number = 0;
  private lastTime: number = -1;
  private clockInvalid: boolean = false;
  private deleting: boolean = false;
  private deleteAttempts: number = 0;
  private deleteTimer: number = -1;
  private deleteWake: ((code: string) => void) | undefined = undefined;
  constructor(core: OHMateCore, save: ArchiveSaveOwner, now: () => number, current: () => boolean) {
    this.core = core; this.save = save; this.now = now; this.current = current;
  }
  getState(): string {
    this.clock();
    const saving: string = this.save.getState();
    return saving === 'cleanup-required' ? saving : this.deleting || saving === 'busy' ? 'busy' : 'idle';
  }
  select(id: string): string {
    if (this.busy || this.getState() !== 'idle') { return this.report('PANEL_BUSY'); }
    if (this.deleteUncertain && id !== this.selection) { return this.report('PANEL_DELETE_UNCERTAIN'); }
    if (this.deleteUncertain) { this.cancel(); return this.report('PANEL_DELETE_UNCERTAIN'); }
    this.cancel(); this.clearDetail();
    if (!this.live() || typeof id !== 'string' || !new RegExp('^problem-[A-Za-z0-9_.-]{1,152}$').test(id)) {
      return this.report('PANEL_UNAVAILABLE');
    }
    this.selection = id; this.selectedId = id;
    return this.refresh();
  }
  refresh(): string {
    if (this.busy || this.getState() !== 'idle') { return this.report('PANEL_BUSY'); }
    this.revokeConfirmation();
    if (!this.live()) { return this.report('PANEL_UNAVAILABLE'); }
    if (this.deleteUncertain) { return this.report('PANEL_DELETE_UNCERTAIN'); }
    try {
      const problem: CoreProblem | undefined = this.core.getProblem(this.selection);
      if (problem === undefined || problem.problemId !== this.selection || !Array.isArray(problem.events) ||
        problem.events.length > 1024 || ![problem.loss.dropped, problem.loss.criticalDropped,
          problem.loss.firstSequence, problem.loss.lastSequence].every(countValid) ||
        !['unknown', 'crash', 'freeze', 'oom', 'render-exit', 'unhandled-error'].includes(problem.triage.fault) ||
        !['insufficient-evidence', 'single-reported-clue'].includes(problem.triage.confidence)) {
        this.clearDetail(); return this.report('PANEL_UNAVAILABLE');
      }
      this.eventCount = problem.events.length; this.dropped = problem.loss.dropped;
      this.criticalDropped = problem.loss.criticalDropped; this.lossFirst = problem.loss.firstSequence;
      this.lossLast = problem.loss.lastSequence; this.triageFault = problem.triage.fault;
      this.triageConfidence = problem.triage.confidence;
      return this.report('PANEL_SELECTED');
    } catch (_) { this.clearDetail(); return this.report('PANEL_UNAVAILABLE'); }
  }
  reviewExport(): string {
    if (this.busy || this.getState() !== 'idle') { return this.report('PANEL_BUSY'); }
    this.revokeConfirmation();
    if (!this.live() || this.selection === '' || this.deleteUncertain) { return this.report('PANEL_UNAVAILABLE'); }
    try {
      const result: CoreResult = this.core.reviewArchive(this.selection);
      if (result.code !== 'ARCHIVE_REVIEWED' || result.problemId !== this.selection ||
        !new RegExp('^[a-f0-9]{64}$').test(result.reviewHash) || result.text.length > CORE_ARCHIVE_MAX_BYTES) {
        return this.report('PANEL_UNAVAILABLE');
      }
      const review: PanelArchiveReview = JSON.parse(result.text) as PanelArchiveReview;
      const expected: string[] = ['manifest.json', 'core-summary.json',
        'schemas/manifest.schema.json', 'schemas/core-summary.schema.json'];
      if (!Number.isSafeInteger(review.archiveBytes) || review.archiveBytes < 1 ||
        review.archiveBytes > CORE_ARCHIVE_MAX_BYTES || !Array.isArray(review.files) ||
        review.files.length !== expected.length ||
        !review.files.every((file: PanelArchiveFile, index: number): boolean => file.path === expected[index]) ||
        !Array.isArray(review.fields) || review.fields.length > 64) { return this.report('PANEL_UNAVAILABLE'); }
      const names: string[] = [];
      for (const schema of review.fields) {
        if (!coreIdentifier(schema.name) || !Array.isArray(schema.fields) || schema.fields.length > 16) {
          return this.report('PANEL_UNAVAILABLE');
        }
        for (const field of schema.fields) {
          if (!coreIdentifier(field.key)) { return this.report('PANEL_UNAVAILABLE'); }
          names.push(schema.name + '.' + field.key);
        }
      }
      if (!this.prepareConfirmation('export')) { return this.report('PANEL_UNAVAILABLE'); }
      this.reviewHash = result.reviewHash; this.archiveBytes = review.archiveBytes;
      this.archiveFiles = expected; this.fieldNames = names;
      return this.report('PANEL_EXPORT_REVIEWED');
    } catch (_) { this.revokeConfirmation(); return this.report('PANEL_UNAVAILABLE'); }
  }
  reviewDelete(): string {
    if (this.busy || this.getState() !== 'idle') { return this.report('PANEL_BUSY'); }
    this.revokeConfirmation();
    try {
      if (!this.live() || this.selection === '' ||
        (!this.deleteUncertain && this.core.getProblem(this.selection) === undefined) ||
        !this.prepareConfirmation('delete')) { return this.report('PANEL_UNAVAILABLE'); }
      return this.report('PANEL_DELETE_REVIEWED');
    } catch (_) { return this.report('PANEL_UNAVAILABLE'); }
  }
  async confirmExport(timeoutMs: number = 30000): Promise<string> {
    if (this.confirmation !== 'export') { return this.report('PANEL_CONFIRM_REQUIRED'); }
    if (this.busy || this.getState() !== 'idle') { return this.report('PANEL_BUSY'); }
    const epoch: number = this.epoch, id: string = this.selection, hash: string = this.reviewHash;
    if (!this.approved(epoch, id) || hash === '') { this.cancel(); return this.report('PANEL_UNAVAILABLE'); }
    try {
      const result: CoreArchiveResult = this.core.exportArchive(id, hash);
      if (result.code !== 'ARCHIVE_EXPORTED' || result.problemId !== id || result.reviewHash !== hash ||
        result.fileName !== id + '.ohmate-problem.zip' || result.archive.length !== this.archiveBytes ||
        !this.approved(epoch, id)) { this.cancel(); return this.report('PANEL_UNAVAILABLE'); }
      this.confirmation = 'none'; this.busy = true;
      const operation: Promise<string> = this.save.save(result.archive, result.fileName,
        (): boolean => this.archiveApproved(epoch, id, hash), timeoutMs);
      // SaveOwner synchronously copies its own buffer before waiting for Picker.
      result.archive.fill(0);
      const code: string = await operation;
      if (this.epoch === epoch) { this.revokeConfirmation(); this.report(code); }
      return code;
    } catch (_) { this.cancel(); return this.report('PANEL_UNAVAILABLE'); }
    finally { this.busy = false; }
  }
  async confirmDelete(timeoutMs: number = 1000): Promise<string> {
    if (this.confirmation !== 'delete') { return this.report('PANEL_CONFIRM_REQUIRED'); }
    if (this.busy || this.getState() !== 'idle') { return this.report('PANEL_BUSY'); }
    const epoch: number = this.epoch, id: string = this.selection;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000 ||
      !this.approved(epoch, id)) { this.cancel(); return this.report('PANEL_UNAVAILABLE'); }
    if (this.deleteAttempts >= 256) { this.cancel(); return this.report('PANEL_QUOTA'); }
    this.deleteAttempts++; this.confirmation = 'none'; this.deleting = true; this.busy = true;
    const waiting: Promise<string> = new Promise<string>((resolve): void => {
      this.deleteWake = resolve;
      this.deleteTimer = setTimeout((): void => { this.cancel(); }, timeoutMs);
    });
    Promise.resolve<void>(undefined).then((): Promise<CoreResult> => {
      if (!this.approved(epoch, id)) { return Promise.resolve<CoreResult>(new CoreResult('PANEL_CANCELLED')); }
      return this.core.deleteProblem(id);
    }).then((result: CoreResult): void => {
      this.deleting = false; this.busy = false;
      this.deleteUncertain = result.code !== 'PROBLEM_DELETED';
      if (this.approved(epoch, id)) {
        if (result.code === 'PROBLEM_DELETED') { this.clearDetail(); }
        this.revokeConfirmation(); this.report(result.code); this.finishDelete(result.code);
      } else { this.finishDelete('PANEL_CANCELLED'); }
    }).catch((): void => {
      this.deleting = false; this.busy = false; this.deleteUncertain = true;
      const code: string = this.approved(epoch, id) ? 'PROBLEM_DELETE_UNCERTAIN' : 'PANEL_CANCELLED';
      this.revokeConfirmation(); this.report(code); this.finishDelete(code);
    });
    return waiting;
  }
  cancel(): void {
    this.revokeConfirmation(); this.save.cancel(); this.finishDelete('PANEL_CANCELLED');
  }
  suspend(): void { this.active = false; this.cancel(); }
  resume(): void { if (!this.disposed) { this.active = true; } }
  dispose(): void { this.disposed = true; this.suspend(); }
  async retryCleanup(timeoutMs: number = 1000): Promise<boolean> {
    const epoch: number = this.epoch;
    const cleaned: boolean = !this.deleting && await this.save.retryCleanup(timeoutMs);
    if (this.live() && this.epoch === epoch) { this.report(cleaned ? 'SAVE_CLEANED' : 'SAVE_CLEANUP_REQUIRED'); }
    return cleaned;
  }
  private prepareConfirmation(kind: string): boolean {
    const now: number = this.clock();
    if (!this.live() || now < 0 || now > Number.MAX_SAFE_INTEGER - 30000) { return false; }
    this.expires = now + 30000; this.confirmation = kind; return true;
  }
  private approved(epoch: number, id: string): boolean {
    const now: number = this.clock();
    return this.live() && now >= 0 && now < this.expires && this.epoch === epoch &&
      this.selection === id && this.selectedId === id;
  }
  private archiveApproved(epoch: number, id: string, hash: string): boolean {
    if (!this.approved(epoch, id)) { return false; }
    try {
      // Core alone knows whether prune/delete/clock/dispose revoked the bytes.
      const checked: CoreArchiveResult = this.core.exportArchive(id, hash);
      const accepted: boolean = checked.code === 'ARCHIVE_EXPORTED' && checked.problemId === id &&
        checked.reviewHash === hash && checked.archive.length === this.archiveBytes;
      checked.archive.fill(0);
      return accepted && this.approved(epoch, id);
    } catch (_) { return false; }
  }
  private live(): boolean {
    if (!this.active || this.disposed || this.clockInvalid) { return false; }
    try { return this.current(); } catch (_) { return false; }
  }
  private clock(): number {
    if (this.clockInvalid) { return -1; }
    try {
      const now: number = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now < this.lastTime) { throw new Error('PANEL_CLOCK_INVALID'); }
      this.lastTime = now;
      if (this.expires > 0 && now >= this.expires) { this.cancel(); }
      return now;
    } catch (_) { this.clockInvalid = true; this.cancel(); return -1; }
  }
  private revokeConfirmation(): void {
    this.epoch++; this.confirmation = 'none'; this.reviewHash = ''; this.expires = 0;
    this.archiveFiles = []; this.fieldNames = []; this.archiveBytes = 0;
  }
  private clearDetail(): void {
    this.selection = ''; this.selectedId = ''; this.eventCount = 0; this.dropped = 0; this.criticalDropped = 0;
    this.lossFirst = 0; this.lossLast = 0; this.triageFault = 'unknown'; this.triageConfidence = 'insufficient-evidence';
    this.deleteUncertain = false;
  }
  private finishDelete(code: string): void {
    if (this.deleteTimer !== -1) { clearTimeout(this.deleteTimer); this.deleteTimer = -1; }
    const wake: ((code: string) => void) | undefined = this.deleteWake;
    this.deleteWake = undefined; wake?.(code);
  }
  private report(code: string): string { this.resultCode = code; return code; }
}
