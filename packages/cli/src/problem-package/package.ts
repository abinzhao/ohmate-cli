/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../debug-protocol/canonical-hash.js';
import { IdentitySchema, ChannelSchema } from '../debug-protocol/domain-schemas.js';
import { EventEnvelopeSchema } from '../debug-protocol/envelopes.js';
import { advanceClock, type ClockSegment } from '../debug-protocol/clock-segments.js';
import { validateCommittedAnchor } from '../debug-protocol/committed-history.js';
import { redactDebugEvent } from '../debug/event-redaction.js';
import { ProblemManifestSchema, ProblemSessionSchema, ProblemEventSchema, problemSchemas } from './schemas.js';
import type { ProblemManifest, ProblemSession, ProblemEvent, ProblemHistory } from './schemas.js';
import { PROBLEM_LIMITS, problemAttachmentType, readProblemZip, storedProblemZip } from './zip.js';
import type { AsyncProblemZipFile, ProblemLimits } from './zip.js';
import { compatibleProblemSchema, knownProblemFields, newerProblemMinor } from './compatibility.js';
import { encodeProblemClocks, decodeProblemClocks } from './clock-layout.js';
import { buildKitProfile, kitDomain, verifyKitProfile, legacyKitUiSchema } from './kit-profile.js';
import type { KitProfile, KitPageSelection, KitRecordPage } from './kit-profile.js';
import { attachmentVerifier } from './attachments.js';
import { CoreManifestSchema, coreKnownFields, coreProblemSchemas, verifyCoreArchive } from './core-profile.js';
import type { CoreArchive, CoreManifest } from './core-profile.js';

export const problemHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Buffer => Buffer.from(canonicalJson(value));
function summaryBudget(path: string): number {
  if (problemAttachmentType(path)) { return PROBLEM_LIMITS.maxFileBytes; }
  return path === 'session.json' ? 1024 ** 2 : path.endsWith('.jsonl') ? 32 * 1024 ** 2 : 4 * 1024 ** 2;
}
function decode(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('PROBLEM_JSON_INVALID'); }
}
function identityMatches(identity: ProblemSession['identity'], event: ProblemEvent): void {
  if (Object.keys(identity).some((key) => identity[key as keyof typeof identity] !== event[key as keyof typeof identity])) {
    throw new Error('PROBLEM_IDENTITY_MISMATCH');
  }
}
function checkEvents(session: ProblemSession, events: ProblemEvent[]): void {
  const history = session.history;
  if (events.length > 4096 || events.length !== (history?.retainedCount ?? session.through)) { throw new Error('PROBLEM_SEQUENCE_INVALID'); }
  checkHistory(session);
  if (session.redaction.fieldsRemoved !== events.reduce((sum, event) => sum + event.redaction.fieldsRemoved, 0)) {
    throw new Error('PROBLEM_REDACTION_INVALID');
  }
  let clock: ReturnType<typeof advanceClock> | null = history?.anchor?.clock ?? null;
  let epochIndex = history?.anchor ? history.epochs.indexOf(history.anchor.sessionEpoch) : 0;
  if (session.clockEvidence && session.clockEvidence.length !== events.length) { throw new Error('PROBLEM_CLOCK_INVALID'); }
  const messages = new Set<string>();
  for (const [index, event] of events.entries()) {
    identityMatches(session.identity, event);
    if (event.sequence !== (history?.from ?? 1) + index || messages.has(event.messageId)) { throw new Error('PROBLEM_SEQUENCE_INVALID'); }
    messages.add(event.messageId);
    if (history) {
      const current = history.epochs.indexOf(event.sessionEpoch);
      if (current < epochIndex) { throw new Error('PROBLEM_HISTORY_INVALID'); }
      epochIndex = current;
    }
    const { clockId, bootId, wallTimeUtc, monotonicNs, offsetUncertaintyMs } = event;
    const evidence = session.clockEvidence?.[index];
    try {
      if (evidence?.alignment && evidence.alignment.observation.sessionEpoch !== event.sessionEpoch) {
        throw new Error('PROBLEM_CLOCK_INVALID');
      }
      clock = advanceClock(clock, { clockId, bootId, wallTimeUtc, monotonicNs, offsetUncertaintyMs }, 10,
        evidence?.alignment?.observation);
      if (evidence && canonicalJson(evidence) !== canonicalJson(clock)) { throw new Error('PROBLEM_CLOCK_INVALID'); }
    } catch { throw new Error('PROBLEM_CLOCK_INVALID'); }
    const restored = EventEnvelopeSchema.parse({ ...event, fingerprint: '0'.repeat(64) });
    if (canonicalJson(redactDebugEvent(restored).payload) !== canonicalJson(event.payload)) {
      throw new Error('PROBLEM_REDACTION_INVALID');
    }
  }
  const expected = coverage(events);
  if (canonicalJson(session.coverage) !== canonicalJson(expected)) { throw new Error('PROBLEM_COVERAGE_INVALID'); }
}
function checkHistory(session: ProblemSession): void {
  const history = session.history;
  if (!history) {
    if (session.through > 4096) { throw new Error('PROBLEM_SEQUENCE_INVALID'); }
    return;
  }
  if (Number(session.schemaVersion.split('.')[1]) < 2 || !session.clockEvidence ||
    history.from - 1 + history.retainedCount !== session.through ||
    (history.from === 1) !== (history.anchor === null) ||
    (history.from === 1) !== (history.gap === null) ||
    history.anchor && history.anchor.sequence !== history.from - 1 ||
    history.gap && history.gap.missingThrough !== history.from - 1) { throw new Error('PROBLEM_HISTORY_INVALID'); }
  if (history.anchor) {
    try { validateCommittedAnchor(history.anchor, history.epochs); }
    catch { throw new Error('PROBLEM_HISTORY_INVALID'); }
  }
}
function coverage(events: ProblemEvent[]): ProblemSession['coverage'] {
  return ChannelSchema.options.map((channel) => {
    const count = events.filter((event) => event.channel === channel).length;
    return { channel, count, status: count ? 'summary-only' : 'not-captured' };
  });
}
function problemManifest(files: ReadonlyMap<string, Buffer>, session: ProblemSession, kit: boolean): ProblemManifest {
  const identityHash = createHash('sha256');
  for (const value of files.values()) { identityHash.update(value); }
  return ProblemManifestSchema.parse({
    format: 'ohmate-problem', schemaVersion: session.schemaVersion,
    problemId: `problem-${identityHash.digest('hex').slice(0, 32)}`, sessionId: session.identity.sessionId,
    content: kit ? 'kit-readonly' : 'domain-summaries', integrity: 'sha256-not-signature',
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: problemHash(bytes),
      type: problemAttachmentType(path) ?? (path.startsWith('schemas/') ? 'json-schema' : path.endsWith('.jsonl') ? 'jsonl' : 'json'),
      sensitivity: problemAttachmentType(path) ? 'reviewed-attachment' : path.startsWith('schemas/') ? 'public-schema' : 'redacted-summary',
      compression: 'store' })),
  });
}
export function buildProblemPackage(input: { debugSessionId: string; streamId: string; identity: unknown; events: unknown[];
  clocks?: ClockSegment[]; history?: ProblemHistory; through?: number; kit?: unknown }) {
  z.string().uuid().parse(input.debugSessionId); z.string().uuid().parse(input.streamId);
  const identity = IdentitySchema.parse(input.identity);
  const events = input.events.map((value) => {
    const original = EventEnvelopeSchema.parse(value);
    if (original.fingerprint !== identity.fingerprint) { throw new Error('PROBLEM_IDENTITY_MISMATCH'); }
    const event = Object.fromEntries(Object.entries(redactDebugEvent(original)).filter(([key]) => key !== 'fingerprint'));
    return ProblemEventSchema.parse(event);
  });
  const parsed = ProblemSessionSchema.parse({
    schemaVersion: input.history ? '1.2' : input.clocks ? '1.1' : '1.0',
    identity: Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'fingerprint')),
    ...(input.clocks ? { clockEvidence: input.clocks } : {}),
    ...(input.history ? { history: input.history } : {}),
    source: { kind: 'desktop-durable-summary', debugSessionId: input.debugSessionId, streamId: input.streamId },
    buildVerification: 'unverified', deviceProvenance: 'peer-asserted', authentication: 'not-restored',
    clockCalibration: 'not-verified', through: input.through ?? events.length, coverage: coverage(events),
    redaction: { policyId: 'offline-summary-v1', fieldsRemoved: events.reduce((total, event) => total + event.redaction.fieldsRemoved, 0),
      memoryOnlyText: 'excluded', attachments: 'none' },
  });
  checkEvents(parsed, events);
  const encoded = encodeProblemClocks(parsed, events), kit = input.kit === undefined ? undefined : buildKitProfile(input.kit, parsed.identity);
  const { external, storedEvents } = encoded;
  const session = kit ? { ...encoded.session, schemaVersion: '1.4' } : encoded.session;
  const storedSession = kit ? { ...encoded.storedSession, schemaVersion: '1.4' } : encoded.storedSession;
  const files = new Map<string, Buffer>([
    ['session.json', jsonBytes(storedSession)],
    ['events.jsonl', Buffer.from(storedEvents.map((event) => canonicalJson(event) + '\n').join(''))],
    ...[...problemSchemas(Boolean(input.clocks), Boolean(input.history), external, Boolean(kit))]
      .map(([name, value]): [string, Buffer] => [name, jsonBytes(value)]),
    ...(kit ? [...kit.files] : []),
  ]);
  for (const [path, bytes] of files) {
    if (bytes.length > summaryBudget(path)) { throw new Error('PROBLEM_SUMMARY_LIMIT'); }
  }
  const manifest = problemManifest(files, session, Boolean(kit));
  contentBudgets(manifest);
  const bytes = storedProblemZip(new Map([['manifest.json', jsonBytes(manifest)], ...files]));
  return { bytes, manifest, session, sha256: problemHash(bytes) };
}
export interface VerifiedProblem {
  compatibility: 'compatible' | 'manifest-only';
  payloadIntegrity: 'verified' | 'not-checked';
  fieldCoverage: 'known-profile' | 'known-fields-only';
  ignoredFields: number;
  manifest: ProblemManifest | CoreManifest;
  session?: ProblemSession;
  events?: ProblemEvent[];
  core?: CoreArchive;
  kit?: KitProfile;
  kitPage?: KitRecordPage;
}
function checkedManifest(files: ReadonlyMap<string, { size: number; compression: string }>, bytes: Buffer) {
  const raw = decode(bytes), omitted = { count: 0 };
  const core = raw !== null && typeof raw === 'object' && 'content' in raw && raw.content === 'core-readonly';
  const kit = raw !== null && typeof raw === 'object' && 'content' in raw && raw.content === 'kit-readonly';
  const manifest = core ? CoreManifestSchema.parse(raw !== null && typeof raw === 'object' && 'schemaVersion' in raw &&
    typeof raw.schemaVersion === 'string' && raw.schemaVersion.split('.')[0] === '1' &&
    Number(raw.schemaVersion.split('.')[1]) > 5 ? coreKnownFields(raw, z.toJSONSchema(CoreManifestSchema), omitted) : raw) :
    ProblemManifestSchema.parse(newerProblemMinor(raw) ?
    knownProblemFields(raw, problemSchemas(false, false, false, kit).get('schemas/manifest.schema.json'), omitted) : raw);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (file.path === 'manifest.json' || seen.has(file.path.toLowerCase())) { throw new Error('PROBLEM_DUPLICATE_PATH'); }
    const schema = file.path.startsWith('schemas/'), attachment = problemAttachmentType(file.path);
    if (attachment && manifest.content !== 'kit-readonly' ||
      file.type !== (attachment ?? (schema ? 'json-schema' : file.path.endsWith('.jsonl') ? 'jsonl' : 'json')) ||
      file.sensitivity !== (attachment ? 'reviewed-attachment' : schema ? 'public-schema' : 'redacted-summary')) {
      throw new Error('PROBLEM_FILE_ROLE');
    }
    seen.add(file.path.toLowerCase());
    const entry = files.get(file.path);
    if (!entry || entry.size !== file.size) { throw new Error('PROBLEM_FILE_SIZE'); }
    if (entry.compression !== file.compression) { throw new Error('PROBLEM_COMPRESSION_MISMATCH'); }
  }
  if (files.size !== manifest.files.length + 1) { throw new Error('PROBLEM_UNLISTED_FILE'); }
  return { manifest, omitted };
}
function contentBudgets(manifest: ProblemManifest | CoreManifest): Map<string, number> {
  if (manifest.content === 'core-readonly') {
    const paths = ['core-summary.json', ...coreProblemSchemas().keys()];
    if (Number(manifest.schemaVersion.split('.')[1]) < 5 || manifest.files.length !== paths.length ||
      manifest.files.some(file => !paths.includes(file.path))) { throw new Error('PROBLEM_CORE_LAYOUT'); }
    return new Map(paths.map(path => [path, 262144]));
  }
  const kit = manifest.content === 'kit-readonly';
  if (kit && Number(manifest.schemaVersion.split('.')[1]) < 4) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
  const budgets = new Map([...problemSchemas(false, false, false, kit).keys(), 'session.json', 'events.jsonl',
    ...(kit ? ['profile.json'] : [])].map((path) => [path, summaryBudget(path)]));
  for (const file of manifest.files) {
    if (!budgets.has(file.path) && kit) {
      kitDomain(file.path); budgets.set(file.path, summaryBudget(file.path));
    }
  }
  if (manifest.files.length !== budgets.size || manifest.files.some((file) => !budgets.has(file.path)) ||
    [...budgets.keys()].some((path) => !manifest.files.some((file) => file.path === path))) {
    throw new Error('PROBLEM_CONTENT_UNSUPPORTED');
  }
  if (manifest.files.reduce((size, file) => size + (problemAttachmentType(file.path) ? 0 : file.size), 0) > 64 * 1024 ** 2) {
    throw new Error('PROBLEM_SUMMARY_LIMIT');
  }
  return budgets;
}
function applicationLayout(value: unknown): boolean | 'app-readonly-summary' {
  if (value === null || typeof value !== 'object' || !('source' in value) ||
    value.source === null || typeof value.source !== 'object' || !('kind' in value.source)) { return false; }
  return value.source.kind === 'app-readonly-summary' ? value.source.kind : value.source.kind === 'app-memory-summary';
}
function matchesProblemSchema(manifest: ProblemManifest, path: string, value: Buffer | undefined, schema: unknown): boolean {
  if (!value) { return false; }
  const candidate = decode(value);
  const matched = newerProblemMinor(manifest) ? compatibleProblemSchema(candidate, schema) :
    canonicalJson(candidate) === canonicalJson(schema);
  return matched || manifest.content === 'kit-readonly' && path === 'schemas/kit-ui.schema.json' &&
    canonicalJson(candidate) === canonicalJson(legacyKitUiSchema());
}
function verifiedCoreContent(manifest: CoreManifest, content: Map<string, Buffer>, omitted: { count: number }): VerifiedProblem {
  const core = verifyCoreArchive(content, manifest, omitted);
  return { compatibility: 'compatible', payloadIntegrity: 'verified', manifest, core,
    fieldCoverage: omitted.count ? 'known-fields-only' : 'known-profile', ignoredFields: omitted.count };
}
function verifyContent(manifest: ProblemManifest | CoreManifest, content: Map<string, Buffer>, omitted: { count: number },
  attachments: ReadonlySet<string>, selection?: KitPageSelection): VerifiedProblem {
  if (manifest.content === 'core-readonly') {
    return verifiedCoreContent(manifest, content, omitted);
  }
  const embeddedSession = decode(content.get('schemas/session.schema.json')!);
  const properties = embeddedSession !== null && typeof embeddedSession === 'object' &&
    'properties' in embeddedSession && embeddedSession.properties !== null && typeof embeddedSession.properties === 'object'
    ? embeddedSession.properties : {};
  const eventClocks = 'clockEvidenceLocation' in properties;
  const measuredProfile = 'clockEvidence' in properties || eventClocks;
  const retainedProfile = measuredProfile && 'history' in properties;
  if (measuredProfile && !newerProblemMinor(manifest)) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
  if (retainedProfile && Number(manifest.schemaVersion.split('.')[1]) < 2) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
  if (eventClocks && (!retainedProfile || Number(manifest.schemaVersion.split('.')[1]) < 3)) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
  const kitProfile = manifest.content === 'kit-readonly';
  const rawSession = decode(content.get('session.json')!);
  const appLayout = applicationLayout(rawSession);
  const expectedSchemas = problemSchemas(measuredProfile, retainedProfile, eventClocks, kitProfile, appLayout);
  for (const [path, schema] of expectedSchemas) {
    if (!matchesProblemSchema(manifest, path, content.get(path), schema)) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
  }
  if ((!kitProfile && content.size !== expectedSchemas.size + 2) || !content.has('session.json') || !content.has('events.jsonl')) {
    throw new Error('PROBLEM_CONTENT_UNSUPPORTED');
  }
  const known = (value: unknown, name: string) => newerProblemMinor(manifest) ?
    knownProblemFields(value, expectedSchemas.get(name), omitted) : value;
  if (eventClocks && rawSession !== null && typeof rawSession === 'object' && 'clockEvidence' in rawSession) {
    throw new Error('PROBLEM_SCHEMA_MISMATCH');
  }
  // Compatibility projection must not erase forbidden application provenance or clock claims.
  const storedSession = ProblemSessionSchema.parse(appLayout ? rawSession : known(rawSession, 'schemas/session.schema.json'));
  if (retainedProfile !== Boolean(storedSession.history) ||
    measuredProfile !== Boolean(storedSession.clockEvidence || storedSession.clockEvidenceLocation)) {
    throw new Error('PROBLEM_SCHEMA_MISMATCH');
  }
  if (Number(storedSession.schemaVersion.split('.')[1]) > Number(manifest.schemaVersion.split('.')[1])) {
    throw new Error('PROBLEM_SCHEMA_MISMATCH');
  }
  if (storedSession.identity.sessionId !== manifest.sessionId) { throw new Error('PROBLEM_IDENTITY_MISMATCH'); }
  const lines = new TextDecoder('utf8', { fatal: true }).decode(content.get('events.jsonl')!);
  if (lines && !lines.endsWith('\n')) { throw new Error('PROBLEM_JSONL_INVALID'); }
  const values = lines ? lines.slice(0, -1).split('\n').map((line) => known(decode(Buffer.from(line)), 'schemas/event.schema.json')) : [];
  const { session, events } = decodeProblemClocks(storedSession, values, eventClocks);
  checkEvents(session, events);
  const kit = kitProfile ? verifyKitProfile(content, session.identity, omitted, newerProblemMinor(manifest), attachments, selection) : undefined;
  return { compatibility: 'compatible', payloadIntegrity: 'verified', manifest, session, events,
    ...(kit ? { kit: kit.profile, ...(kit.page ? { kitPage: kit.page } : {}) } : {}),
    fieldCoverage: omitted.count ? 'known-fields-only' : 'known-profile', ignoredFields: omitted.count };
}
export function verifyProblemPackage(bytes: Buffer, limits: Partial<ProblemLimits> = {}): VerifiedProblem {
  const files = readProblemZip(bytes, limits), manifestFile = files.get('manifest.json');
  if (!manifestFile || manifestFile.size > 4 * 1024 ** 2) { throw new Error('PROBLEM_MANIFEST_INVALID'); }
  const { manifest, omitted } = checkedManifest(files, manifestFile.read());
  if (manifest.schemaVersion.split('.')[0] !== '1') {
    return { compatibility: 'manifest-only', payloadIntegrity: 'not-checked', manifest, fieldCoverage: 'known-profile', ignoredFields: 0 };
  }
  const budgets = contentBudgets(manifest), content = new Map<string, Buffer>(), attachments = new Set<string>();
  for (const file of manifest.files) {
    if (file.size > budgets.get(file.path)!) { throw new Error('PROBLEM_SUMMARY_LIMIT'); }
    if (problemAttachmentType(file.path)) {
      const checker = attachmentVerifier(file.path);
      files.get(file.path)!.consume(budgets.get(file.path)!, checker.visit);
      checker.finish(file.size, file.sha256); attachments.add(file.path);
      continue;
    }
    const value = files.get(file.path)!.read();
    if (problemHash(value) !== file.sha256) { throw new Error('PROBLEM_HASH_MISMATCH'); }
    content.set(file.path, value);
  }
  return verifyContent(manifest, content, omitted, attachments);
}
export async function verifyProblemArchive(files: ReadonlyMap<string, AsyncProblemZipFile>, signal: AbortSignal,
  selection?: KitPageSelection): Promise<VerifiedProblem> {
  const manifestFile = files.get('manifest.json');
  if (!manifestFile || manifestFile.size > 4 * 1024 ** 2) { throw new Error('PROBLEM_MANIFEST_INVALID'); }
  const { manifest, omitted } = checkedManifest(files, await manifestFile.read(4 * 1024 ** 2));
  if (manifest.schemaVersion.split('.')[0] !== '1') {
    return { compatibility: 'manifest-only', payloadIntegrity: 'not-checked', manifest, fieldCoverage: 'known-profile', ignoredFields: 0 };
  }
  const budgets = contentBudgets(manifest), content = new Map<string, Buffer>(), attachments = new Set<string>();
  for (const file of manifest.files) {
    signal.throwIfAborted();
    if (problemAttachmentType(file.path)) {
      const checker = attachmentVerifier(file.path);
      await files.get(file.path)!.consume(budgets.get(file.path)!, checker.visit);
      checker.finish(file.size, file.sha256); attachments.add(file.path);
      continue;
    }
    const value = await files.get(file.path)!.read(budgets.get(file.path)!);
    if (problemHash(value) !== file.sha256) { throw new Error('PROBLEM_HASH_MISMATCH'); }
    content.set(file.path, value);
  }
  signal.throwIfAborted();
  return verifyContent(manifest, content, omitted, attachments, selection);
}
