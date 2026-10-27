/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContract } from '../debug-protocol/canonical-hash.js';
import { assertIdentity, negotiateReadonly } from '../debug-protocol/handshake.js';
import { createReadonlyBridge, EVENT_BATCH_LIMIT, type AcceptedEvent, type Handshake } from '../debug-protocol/index.js';
import { eventDigest } from '../debug-protocol/retained-window.js';
import { securityError } from '../debug-protocol/security-schemas.js';
import { redactDebugEvent } from './event-redaction.js';
import { journalDirectory, readJournalFile, writeJournalFile, writeJournalCheckpoint, removeJournalFile } from './journal-files.js';
import { JournalEventSchema, JournalManifestSchema, JournalCheckpointSchema, JournalEpochsSchema, JournalSegmentSchema } from './journal-schemas.js';
import type { JournalEvent, JournalManifest, JournalCheckpoint, JournalRetention } from './journal-schemas.js';
import { createHash, randomUUID } from 'node:crypto';
import { acquireJournalLock } from './journal-lock.js';
import { advanceClock, type ClockSegment } from '../debug-protocol/clock-segments.js';
import { CommittedHistory, validateCommittedAnchor } from '../debug-protocol/committed-history.js';
import { JournalReadCache, type VerifiedJournalPrefix } from './journal-read-cache.js';

const readCache = new JournalReadCache();

export class EventJournal {
  private index = 0;
  private bytes = 0;
  private previousHash: string;
  private writing = false;
  private epochs: string[] | undefined;
  private retention: JournalRetention | undefined;
  private constructor(readonly root: string, private manifest: JournalManifest, private dataDir: string) {
    this.previousHash = hashContract(manifest);
  }
  get sessionId(): string { return this.manifest.sessionId; }
  get streamId(): string { return this.manifest.streamId; }
  static async create(dataDir: string, sessionId: string, handshake: Handshake,
    options: { maxBytes?: number; maxEvents?: number; segmented?: boolean; retention?: 'rolling-v1';
      resume?: { peer: Handshake; epoch: string } } = {}): Promise<EventJournal> {
    if ((options.segmented && !options.resume) || (options.retention && (!options.segmented || !options.resume))) {
      throw securityError('JOURNAL_BATCH_INVALID');
    }
    const epochs = options.resume ? JournalEpochsSchema.parse([options.resume.epoch]) : undefined;
    if (options.resume) { negotiateReadonly(handshake, options.resume.peer); }
    const manifest = JournalManifestSchema.parse({ schemaVersion: options.retention ? '1.4' : options.segmented ? '1.3' : options.resume ? '1.2' : '1.1',
      ...(options.segmented ? { storage: 'segments-v1' } : {}),
      ...(options.retention ? { retention: options.retention } : {}),
      ...(options.resume ? { peer: options.resume.peer } : {}), sessionId, streamId: randomUUID(), handshake,
      authentication: 'pairing-proof', buildVerification: 'unverified', deviceProvenance: 'peer-asserted',
      maxBytes: options.maxBytes ?? 5 * 1024 * 1024, maxEvents: options.maxEvents ?? 4096 });
    const root = await journalDirectory(dataDir, sessionId, manifest.streamId, true);
    const release = await acquireJournalLock(dataDir, sessionId, manifest.streamId);
    try {
      const journal = new EventJournal(root, manifest, dataDir);
      journal.epochs = epochs;
      journal.retention = options.retention ? { anchor: null, cleanupPending: false, cleanup: null } : undefined;
      journal.bytes = await writeJournalFile(join(root, 'manifest.json'), manifest);
      if (journal.bytes + 4096 > manifest.maxBytes) { throw securityError('JOURNAL_LIMIT'); }
      await journal.checkpoint(0, journal.previousHash, journal.bytes);
      return journal;
    } finally { await release(); }
  }
  async append(accepted: AcceptedEvent): Promise<JournalEvent> {
    if (this.manifest.schemaVersion === '1.3' || this.manifest.schemaVersion === '1.4') { return (await this.appendBatch([accepted]))[0]; }
    if (this.writing || accepted.disposition !== 'accepted' || accepted.event.sequence !== this.index + 1) {
      throw securityError('JOURNAL_SEQUENCE_INVALID');
    }
    this.writing = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireJournalLock(this.dataDir, this.sessionId, this.streamId);
      await this.assertWriter();
      assertIdentity(this.manifest.handshake.identity, accepted.event);
      if (this.epochs && accepted.event.sessionEpoch !== this.epochs.at(-1)) { throw securityError('EPOCH_MISMATCH'); }
      const value = { index: this.index + 1, previousHash: this.previousHash, sourceDigest: hashContract(accepted.event),
        ...(this.epochs ? { resumeDigest: eventDigest(accepted.event) } : {}),
        event: redactDebugEvent(accepted.event), clock: accepted.clock };
      const record = JournalEventSchema.parse({ ...value, hash: hashContract(value) });
      const size = Buffer.byteLength(JSON.stringify(record));
      if (record.index > this.manifest.maxEvents || this.bytes + size + 4096 > this.manifest.maxBytes) {
        throw securityError('JOURNAL_LIMIT');
      }
      await writeJournalFile(join(this.root, `${String(record.index).padStart(8, '0')}.json`), record);
      await this.checkpoint(record.index, record.hash, this.bytes + size);
      this.index = record.index; this.previousHash = record.hash; this.bytes += size;
      return record;
    } finally { try { await release?.(); } finally { this.writing = false; } }
  }
  async appendBatch(accepted: AcceptedEvent[]): Promise<JournalEvent[]> {
    if (!['1.3', '1.4'].includes(this.manifest.schemaVersion) || !accepted.length || accepted.length > EVENT_BATCH_LIMIT) {
      throw securityError('JOURNAL_BATCH_INVALID');
    }
    if (this.writing) { throw securityError('JOURNAL_SEQUENCE_INVALID'); }
    this.writing = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireJournalLock(this.dataDir, this.sessionId, this.streamId);
      await this.assertWriter();
      const rolling = this.manifest.schemaVersion === '1.4';
      const records: JournalEvent[] = [];
      let previousHash = this.previousHash;
      for (const item of accepted) {
        const index = this.index + records.length + 1;
        if (item.disposition !== 'accepted' || item.event.sequence !== index) { throw securityError('JOURNAL_SEQUENCE_INVALID'); }
        if (!Number.isSafeInteger(index) || (!rolling && index > this.manifest.maxEvents)) { throw securityError('JOURNAL_LIMIT'); }
        assertIdentity(this.manifest.handshake.identity, item.event);
        if (item.event.sessionEpoch !== this.epochs?.at(-1)) { throw securityError('EPOCH_MISMATCH'); }
        const value = { index, previousHash, sourceDigest: hashContract(item.event), resumeDigest: eventDigest(item.event),
          event: redactDebugEvent(item.event), clock: item.clock };
        const record = JournalEventSchema.parse({ ...value, hash: hashContract(value) });
        records.push(record); previousHash = record.hash;
      }
      const body = { schemaVersion: rolling ? '1.1' : '1.0', from: records[0].index, through: records.at(-1)!.index,
        bytes: Buffer.byteLength(JSON.stringify(records)), records };
      const segment = JournalSegmentSchema.parse({ ...body, hash: hashContract(body) });
      const size = Buffer.byteLength(JSON.stringify(segment));
      if (!rolling && (segment.through > this.manifest.maxEvents || this.bytes + size + 4096 > this.manifest.maxBytes)) {
        throw securityError('JOURNAL_LIMIT');
      }
      if (size > 512 * 1024) { throw securityError('JOURNAL_BATCH_INVALID'); }
      const verified = rolling ? await this.retireForBatch(records, size) : undefined;
      const width = rolling ? 16 : 8;
      const name = `${String(segment.from).padStart(width, '0')}-${String(segment.through).padStart(width, '0')}.seg`;
      await writeJournalFile(join(this.root, name), segment);
      await this.checkpoint(segment.through, previousHash, this.bytes + size);
      this.index = segment.through; this.previousHash = previousHash; this.bytes += size;
      if (verified) { this.cacheCommittedBatch(verified, records, name, segment); }
      return records;
    } finally { try { await release?.(); } finally { this.writing = false; } }
  }
  private cacheCommittedBatch(verified: VerifiedJournalPrefix, records: JournalEvent[], name: string, segment: unknown): void {
    const retiredThrough = this.retention!.anchor?.index ?? 0;
    verified.history!.window.retireThrough(retiredThrough);
    readCache.put(this.root, { ...verified,
      events: [...verified.events.filter((record) => record.index > retiredThrough), ...structuredClone(records)],
      files: [...verified.files.filter((file) => Number(file.name.slice(17, 33)) > retiredThrough),
        { name, digest: createHash('sha256').update(JSON.stringify(segment)).digest('hex') }],
      totalBytes: this.bytes, previousHash: this.previousHash, clock: verified.history!.clock,
      retentionHash: hashContract(this.retention),
    });
  }
  private async checkpoint(index: number, lastHash: string, bytes: number): Promise<void> {
    await writeJournalCheckpoint(this.root, this.commit(index, lastHash, bytes));
  }
  private commit(index: number, lastHash: string, bytes: number): JournalCheckpoint {
    return JournalCheckpointSchema.parse({
      schemaVersion: this.retention ? '1.2' : this.epochs ? '1.1' : '1.0', ...(this.epochs ? { epochs: this.epochs } : {}),
      ...(this.retention ? { retention: this.retention } : {}),
      manifestHash: hashContract(this.manifest), index, lastHash, bytes,
    });
  }
  private async assertWriter(): Promise<void> {
    const saved = decode(JournalCheckpointSchema, await readJournalFile(join(this.root, 'checkpoint.json'), 4096));
    if (hashContract(saved) !== hashContract(this.commit(this.index, this.previousHash, this.bytes))) {
      throw securityError('JOURNAL_WRITER_STALE');
    }
  }
  private async retireForBatch(records: JournalEvent[], size: number): Promise<VerifiedJournalPrefix> {
    const count = records.length;
    const manifestSize = (await readJournalFile(join(this.root, 'manifest.json'), 32768)).length;
    if (count > this.manifest.maxEvents || manifestSize + size + 4096 > this.manifest.maxBytes) {
      throw securityError('JOURNAL_LIMIT');
    }
    const saved = await EventJournal.readCommitted(this.root, this.sessionId, this.streamId, 'consume');
    if (this.manifest.schemaVersion !== '1.4' || saved.checkpoint.schemaVersion !== '1.2') { throw securityError('JOURNAL_CORRUPT'); }
    const history = saved.history!;
    for (const record of records) { verifyClock(record, this.manifest, history.clock, history); }
    if (this.retention!.cleanupPending) { await this.finishRetirement(); }
    const retained = this.index - (this.retention!.anchor?.index ?? 0);
    if (retained + count <= this.manifest.maxEvents && this.bytes + size + 4096 <= this.manifest.maxBytes) { return saved.prefix; }
    let remaining = retained, bytes = this.bytes;
    const retirements: Array<{ file: typeof saved.contents[number]; bytes: number; anchor: NonNullable<JournalRetention['anchor']> }> = [];
    for (const file of saved.contents) {
      const segment = decode(JournalSegmentSchema, file.bytes);
      remaining -= segment.records.length; bytes -= file.bytes.length;
      const last = segment.records.at(-1)!;
      if (!last.resumeDigest) { throw securityError('JOURNAL_CORRUPT'); }
      const anchor = { index: last.index, hash: last.hash, sourceDigest: last.sourceDigest,
        resumeDigest: last.resumeDigest, sessionEpoch: last.event.sessionEpoch, clock: last.clock };
      retirements.push({ file, bytes, anchor });
      if (remaining + count <= this.manifest.maxEvents && bytes + size + 4096 <= this.manifest.maxBytes) { break; }
    }
    if (!retirements.length || remaining + count > this.manifest.maxEvents || bytes + size + 4096 > this.manifest.maxBytes) {
      throw securityError('JOURNAL_LIMIT');
    }
    for (const step of retirements) {
      const retention = { anchor: step.anchor, cleanupPending: true,
        cleanup: { name: step.file.name, digest: step.file.digest } };
      await writeJournalCheckpoint(this.root, { ...this.commit(this.index, this.previousHash, step.bytes), retention });
      this.retention = retention; this.bytes = step.bytes;
      await removeJournalFile(join(this.root, step.file.name), step.file.digest);
      const complete = { ...retention, cleanupPending: false, cleanup: null };
      await writeJournalCheckpoint(this.root, { ...this.commit(this.index, this.previousHash, this.bytes), retention: complete });
      this.retention = complete;
    }
    return saved.prefix;
  }
  private async finishRetirement(): Promise<void> {
    const saved = await EventJournal.readCommitted(this.root, this.sessionId, this.streamId);
    for (const file of saved.retired) { await removeJournalFile(join(this.root, file.name), file.digest); }
    const retention = { ...this.retention!, cleanupPending: false, cleanup: null };
    await writeJournalCheckpoint(this.root, { ...this.commit(this.index, this.previousHash, this.bytes), retention });
    this.retention = retention;
  }
  static async resume(dataDir: string, sessionId: string, streamId: string,
    local: Handshake, peer: Handshake, request: unknown, options: { segmented?: boolean; retention?: 'rolling-v1' } = {}) {
    const root = await journalDirectory(dataDir, sessionId, streamId, false);
    const release = await acquireJournalLock(dataDir, sessionId, streamId);
    try {
      const { manifest, events, checkpoint } = await EventJournal.readCommitted(root, sessionId, streamId);
      if ((options.segmented && !['1.3', '1.4'].includes(manifest.schemaVersion)) ||
        (manifest.schemaVersion === '1.4') !== (options.retention === 'rolling-v1') ||
        (options.retention && !options.segmented)) { throw securityError('JOURNAL_BATCH_INVALID'); }
      if (manifest.schemaVersion === '1.1' || checkpoint.schemaVersion === '1.0') {
        throw securityError('JOURNAL_RESUME_UNAVAILABLE');
      }
      assertIdentity(manifest.handshake.identity, local.identity);
      if (hashContract(negotiateReadonly(local, peer)) !== hashContract(negotiateReadonly(manifest.handshake, manifest.peer))) {
        throw securityError('RESUME_MISMATCH');
      }
      const bridge = restoredBridge(manifest, checkpoint, events);
      const { ack } = bridge.resume(peer, request);
      if (checkpoint.epochs.length >= 24) { throw securityError('JOURNAL_EPOCH_LIMIT'); }
      const journal = new EventJournal(root, manifest, dataDir);
      journal.index = checkpoint.index; journal.bytes = checkpoint.bytes; journal.previousHash = checkpoint.lastHash;
      journal.retention = checkpoint.schemaVersion === '1.2' ? checkpoint.retention : undefined;
      journal.epochs = checkpoint.epochs;
      if (journal.retention?.cleanupPending) { await journal.finishRetirement(); }
      journal.epochs = [...checkpoint.epochs, ack.sessionEpoch];
      await journal.checkpoint(journal.index, journal.previousHash, journal.bytes);
      return { journal, bridge, ack };
    } finally { await release(); }
  }
  static async read(dataDir: string, sessionId: string, streamId: string,
    options: { retainedHistory?: true; page?: { after: number; limit: number } } = {}) {
    const root = await journalDirectory(dataDir, sessionId, streamId, false);
    const release = await acquireJournalLock(dataDir, sessionId, streamId);
    try {
      const { manifest, events, checkpoint } = await EventJournal.readCommitted(root, sessionId, streamId, true);
      const anchor = checkpoint.schemaVersion === '1.2' ? checkpoint.retention.anchor : null;
      // Selection follows full validation; only returned records need defensive copies.
      const selected = options.page ? events.filter((record) => record.index > options.page!.after).slice(0, options.page.limit) : events;
      return structuredClone({ manifest, events: selected, count: events.length, through: checkpoint.index,
        ...(checkpoint.schemaVersion === '1.2' ? {
        retention: { from: (anchor?.index ?? 0) + 1, through: checkpoint.index,
          cleanupPending: checkpoint.retention.cleanupPending,
          gap: anchor ? { missingFrom: 1, missingThrough: anchor.index, reason: 'retention-quota' as const } : null },
        ...(options.retainedHistory ? { history: {
          retention: 'rolling-v1' as const, from: (anchor?.index ?? 0) + 1, retainedCount: events.length,
          epochs: checkpoint.epochs, anchor: historyAnchor(checkpoint) ?? null,
          gap: anchor ? { missingFrom: 1 as const, missingThrough: anchor.index, reason: 'retention-quota' as const } : null,
        } } : {}),
      } : {}) });
    }
    finally { await release(); }
  }
  private static async readCommitted(root: string, sessionId: string, streamId: string, reuse: boolean | 'consume' = false) {
    // Consume cached state before IO; a failed validation cannot publish a partial suffix.
    const cached = reuse ? readCache.take(root) : undefined;
    const files = (await readdir(root)).sort();
    if (files.length > 4098 || !files.includes('checkpoint.json')) {
      throw securityError('JOURNAL_CORRUPT');
    }
    const manifestBytes = await readJournalFile(join(root, 'manifest.json'), 32768);
    const manifest = decode(JournalManifestSchema, manifestBytes);
    if (manifest.sessionId !== sessionId || manifest.streamId !== streamId) { throw securityError('JOURNAL_CORRUPT'); }
    const pattern = manifest.schemaVersion === '1.4' ? /^\d{16}-\d{16}\.seg$/ :
      manifest.schemaVersion === '1.3' ? /^\d{8}-\d{8}\.seg$/ : /^\d{8}\.json$/;
    if (files.some((file) => !['manifest.json', 'checkpoint.json'].includes(file) && !pattern.test(file))) {
      throw securityError('JOURNAL_CORRUPT');
    }
    const checkpointBytes = await readJournalFile(join(root, 'checkpoint.json'), 4096);
    const checkpoint = decode(JournalCheckpointSchema, checkpointBytes);
    if ((manifest.schemaVersion !== '1.1') !== (checkpoint.schemaVersion !== '1.0') ||
      (manifest.schemaVersion === '1.4') !== (checkpoint.schemaVersion === '1.2')) { throw securityError('JOURNAL_CORRUPT'); }
    const result = await readEvents(root, files, manifest, manifestBytes, checkpoint, cached);
    const anchor = checkpoint.schemaVersion === '1.2' ? checkpoint.retention.anchor : null;
    if (checkpoint.manifestHash !== hashContract(manifest) || checkpoint.index !== (anchor?.index ?? 0) + result.events.length ||
      checkpoint.lastHash !== result.previousHash || checkpoint.bytes !== result.totalBytes ||
      result.totalBytes + checkpointBytes.length > manifest.maxBytes) { throw securityError('JOURNAL_CORRUPT'); }
    const { contents: _contents, retired: _retired, ...prefix } = result;
    void _contents; void _retired;
    // Writers consume validation and publish it only after the new checkpoint is synced.
    if (reuse === true) { readCache.put(root, prefix); }
    return { manifest, events: result.events, checkpoint, retired: result.retired, contents: result.contents, history: result.history, prefix };
  }
}
function restoredBridge(manifest: Exclude<JournalManifest, { schemaVersion: '1.1' }>,
  checkpoint: Exclude<JournalCheckpoint, { schemaVersion: '1.0' }>, events: JournalEvent[]) {
  const bridge = createReadonlyBridge(manifest.handshake);
  bridge.restoreCommitted(manifest.peer, checkpoint.epochs, events.map((record) => {
    if (!record.resumeDigest) { throw securityError('JOURNAL_CORRUPT'); }
    return { event: record.event, digest: record.resumeDigest, clock: record.clock };
  }), historyAnchor(checkpoint));
  return bridge;
}
function historyAnchor(checkpoint: JournalCheckpoint) {
  const anchor = checkpoint.schemaVersion === '1.2' ? checkpoint.retention.anchor : null;
  return anchor ? { sequence: anchor.index, sessionEpoch: anchor.sessionEpoch, clock: anchor.clock } : undefined;
}
function decode<T>(schema: { parse(input: unknown): T }, bytes: Buffer): T {
  try { return schema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { throw securityError('JOURNAL_CORRUPT'); }
}
function verifyClock(record: Omit<JournalEvent, 'hash'>, manifest: JournalManifest,
  clock: ClockSegment | null, history?: CommittedHistory): ClockSegment {
  try {
    if (history) {
      if (!record.resumeDigest) { throw securityError('JOURNAL_CORRUPT'); }
      history.append({ event: record.event, digest: record.resumeDigest, clock: record.clock });
      return history.clock!;
    }
    assertIdentity(manifest.handshake.identity, record.event);
    const { clockId, bootId, monotonicNs, wallTimeUtc, offsetUncertaintyMs } = record.event;
    const observation = record.clock.alignment?.observation;
    if (observation && observation.sessionEpoch !== record.event.sessionEpoch) { throw securityError('JOURNAL_CORRUPT'); }
    const next = advanceClock(clock, { clockId, bootId, monotonicNs, wallTimeUtc, offsetUncertaintyMs }, 10, observation);
    if (hashContract(next) !== hashContract(record.clock)) { throw securityError('JOURNAL_CORRUPT'); }
    return next;
  } catch { throw securityError('JOURNAL_CORRUPT'); }
}
async function readContents(root: string, files: string[], manifest: JournalManifest, initialBytes: number) {
  const contents: Array<{ name: string; bytes: Buffer; digest: string }> = [];
  let totalBytes = initialBytes;
  const names = files.filter((file) => !['manifest.json', 'checkpoint.json'].includes(file));
  const fileLimit = ['1.3', '1.4'].includes(manifest.schemaVersion) ? 512 * 1024 : 131072;
  // Every query rereads and hashes all named bytes through the safe file reader, including excluded tails.
  for (let offset = 0; offset < names.length;) {
    const remaining = manifest.maxBytes - totalBytes;
    const count = Math.min(4, Math.max(1, Math.floor(remaining / fileLimit)), names.length - offset);
    const group = names.slice(offset, offset + count), budget = Math.min(fileLimit, remaining);
    // Await every close before reporting failure so a sibling cannot outlive the stream lock.
    const results = await Promise.allSettled(group.map((name) => readJournalFile(join(root, name), budget)));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') { throw result.reason; }
      const bytes = result.value;
      totalBytes += bytes.length;
      contents.push({ name: group[index], bytes, digest: createHash('sha256').update(bytes).digest('hex') });
    }
    offset += count;
  }
  return { contents, totalBytes };
}
async function readEvents(root: string, files: string[], manifest: JournalManifest, manifestBytes: Buffer,
  checkpoint: JournalCheckpoint, cached?: VerifiedJournalPrefix) {
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  const epochsHash = hashContract(checkpoint.schemaVersion !== '1.0' ? checkpoint.epochs : null);
  const retention = checkpoint.schemaVersion === '1.2' ? checkpoint.retention : undefined;
  const retentionHash = hashContract(retention ?? null), anchor = retention?.anchor;
  const start = anchor?.index ?? 0;
  const segmented = ['1.3', '1.4'].includes(manifest.schemaVersion), rolling = manifest.schemaVersion === '1.4';
  const read = await readContents(root, files, manifest, manifestBytes.length);
  const { contents, retired } = retainedContents(read.contents, retention);
  const totalBytes = manifestBytes.length + contents.reduce((sum, file) => sum + file.bytes.length, 0);
  const prefix = cached && cached.manifestDigest === manifestDigest && cached.epochsHash === epochsHash &&
    cached.retentionHash === retentionHash &&
    cached.files.length <= contents.length && cached.files.every((file, index) =>
      file.name === contents[index].name && file.digest === contents[index].digest) ? cached : undefined;
  if (prefix && anchor && checkpoint.schemaVersion === '1.2') {
    try { validateCommittedAnchor(historyAnchor(checkpoint)!, checkpoint.epochs); }
    catch { throw securityError('JOURNAL_CORRUPT'); }
  }
  const events = prefix ? [...prefix.events] : [];
  let previousHash = prefix?.previousHash ?? anchor?.hash ?? hashContract(manifest), clock: ClockSegment | null = prefix?.clock ?? anchor?.clock ?? null;
  let history = prefix?.history;
  if (!history && manifest.schemaVersion !== '1.1' && checkpoint.schemaVersion !== '1.0') {
    try { history = new CommittedHistory(manifest.handshake, manifest.peer, checkpoint.epochs, 10, historyAnchor(checkpoint)); }
    catch { throw securityError('JOURNAL_CORRUPT'); }
  }
  for (const { name, bytes } of contents.slice(prefix?.files.length ?? 0)) {
    if (!segmented && name !== `${String(events.length + 1).padStart(8, '0')}.json`) { throw securityError('JOURNAL_CORRUPT'); }
    let records: JournalEvent[];
    if (segmented) {
      const segment = validatedSegment(name, bytes, rolling);
      if (segment.from !== start + events.length + 1) { throw securityError('JOURNAL_CORRUPT'); }
      records = segment.records;
    } else { records = [decode(JournalEventSchema, bytes)]; }
    for (const { hash, ...record } of records) {
      if (record.index !== start + events.length + 1 || record.event.sequence !== record.index || record.previousHash !== previousHash ||
        hashContract(record) !== hash || events.length >= manifest.maxEvents || totalBytes > manifest.maxBytes) {
        throw securityError('JOURNAL_CORRUPT');
      }
      clock = verifyClock(record, manifest, clock, history);
      events.push({ ...record, hash }); previousHash = hash;
    }
  }
  return { manifestDigest, epochsHash, retentionHash, events, previousHash, totalBytes, clock, history, retired, contents,
    files: contents.map(({ name, digest }) => ({ name, digest })) };
}
function retainedContents(input: Array<{ name: string; bytes: Buffer; digest: string }>, retention?: JournalRetention) {
  const retired: Array<{ name: string; digest: string }> = [];
  const contents = input.filter((file) => {
    if (!retention) { return true; }
    const anchor = retention.anchor;
    // Names classify candidates only; retained files are validated below or matched by their full-byte digest.
    if (Number(file.name.slice(17, 33)) > (anchor?.index ?? 0)) { return true; }
    const segment = validatedSegment(file.name, file.bytes, true);
    if (!retention.cleanupPending || retention.cleanup?.name !== file.name || retention.cleanup.digest !== file.digest ||
      segment.records.at(-1)!.hash !== anchor!.hash) { throw securityError('JOURNAL_CORRUPT'); }
    retired.push({ name: file.name, digest: file.digest });
    return false;
  });
  return { contents, retired };
}
function validatedSegment(name: string, bytes: Buffer, rolling: boolean) {
  const { hash, ...segment } = decode(JournalSegmentSchema, bytes);
  const width = rolling ? 16 : 8;
  const expected = `${String(segment.from).padStart(width, '0')}-${String(segment.through).padStart(width, '0')}.seg`;
  if (segment.schemaVersion !== (rolling ? '1.1' : '1.0') || name !== expected ||
    segment.through !== segment.from + segment.records.length - 1 ||
    hashContract(segment) !== hash || Buffer.byteLength(JSON.stringify(segment.records)) !== segment.bytes) {
    throw securityError('JOURNAL_CORRUPT');
  }
  let previousHash = segment.records[0].previousHash;
  for (let n = 0; n < segment.records.length; n++) {
    const { hash: recordHash, ...record } = segment.records[n];
    if (record.index !== segment.from + n || record.event.sequence !== record.index ||
      record.previousHash !== previousHash || hashContract(record) !== recordHash) { throw securityError('JOURNAL_CORRUPT'); }
    previousHash = recordHash;
  }
  return segment;
}
