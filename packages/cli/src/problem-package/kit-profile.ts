/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { CounterSchema, IdentitySchema, IdentifierSchema, PayloadSchemas } from '../debug-protocol/domain-schemas.js';
import { ClockSchema, EventEnvelopeSchema } from '../debug-protocol/envelopes.js';
import { canonicalJson } from '../debug-protocol/canonical-hash.js';
import { redactDebugEvent } from '../debug/event-redaction.js';
import { knownProblemFields } from './compatibility.js';
import { problemAttachmentType } from './zip.js';
import { attachmentVerifier } from './attachments.js';

const identitySchema = IdentitySchema.omit({ fingerprint: true });
const apiSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:]{0,255}$/);
const sourceBase = z.strictObject({
  id: IdentifierSchema, provenance: z.literal('peer-reported'), api: apiSchema.optional(),
});
const sourceSchema = z.union([
  sourceBase.extend({ kind: z.literal('platform-api'), api: apiSchema }),
  sourceBase.extend({ kind: z.literal('registered-adapter') }),
  sourceBase.extend({ kind: z.literal('manual-import') }),
]);
const structural = (payload: z.ZodType) => z.strictObject({ clock: ClockSchema, payload });
const id = IdentifierSchema;
const tree = { nodeId: id, parentId: id.nullable(), role: id, childCount: CounterSchema };
const uiGeometry = {
  bounds: z.strictObject({
    x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().min(0), height: z.number().finite().min(0),
    unit: z.literal('vp'), origin: z.literal('window'),
  }).optional(),
  // Native visibility attribute only; this does not attest occlusion or paint.
  visible: z.boolean().optional(),
};
export function legacyKitUiSchema(): unknown {
  // Exact pre-geometry schema; no generic constraint or required-field fallback.
  return z.toJSONSchema(z.array(structural(z.strictObject({ windowId: id, ...tree }))).min(1).max(4096));
}
function events(channels: string[]): z.ZodType {
  const options = EventEnvelopeSchema.options.filter((option) => channels.includes(option.shape.channel.value))
    .map((option) => option.omit({ fingerprint: true }));
  return z.union(options as [typeof options[number], typeof options[number], ...typeof options[number][]]);
}

// Field-bearing records share the realtime domain definitions. Structural
// records deliberately have no text, body, script, selector or replay arguments.
export const KIT_DOMAINS = [
  { domain: 'environment', path: 'environment.json', schema: structural(z.strictObject({
    apiLevel: z.number().int().min(1).max(999), sdkVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    deviceType: z.enum(['phone', 'tablet', '2in1', 'wearable', 'tv', 'unknown']),
    capabilities: z.array(id).max(256),
  })) },
  { domain: 'actions', path: 'actions.jsonl', schema: structural(z.strictObject({
    actionId: id, kind: z.enum(['tap', 'scroll', 'input', 'back', 'custom']), targetId: id,
    outcome: z.enum(['completed', 'failed', 'cancelled']),
  })) },
  { domain: 'navigation', path: 'navigation.jsonl', schema: structural(z.strictObject({
    actionId: id, from: id, to: id, operation: z.enum(['push', 'pop', 'replace']),
  })) },
  { domain: 'arkweb', path: 'arkweb.jsonl', summary: true, schema: events(['arkweb.dom', 'arkweb.storage']) },
  { domain: 'web-targets', path: 'web-targets.json', schema: structural(z.strictObject({
    targetId: id, origin: z.string().max(512).refine((value) => {
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && value === url.origin; }
      catch { return false; }
    }), debugEnabled: z.boolean(), state: z.enum(['active', 'destroyed']),
  })) },
  { domain: 'web-dom', directory: 'web-dom', schema: structural(z.strictObject({ targetId: id, ...tree })) },
  { domain: 'web-console', path: 'web-console.jsonl', summary: true, schema: events(['arkweb.console']) },
  { domain: 'network-summary', path: 'network-summary.jsonl', summary: true, schema: events(['app.network', 'arkweb.network']) },
  { domain: 'network-captures', directory: 'network-captures', schema: structural(PayloadSchemas['app.network']) },
  { domain: 'mock-rules', path: 'mock-rules.json', schema: structural(z.strictObject({
    ruleId: id, enabled: z.boolean(), hits: CounterSchema, expiresAt: z.iso.datetime(),
  })) },
  { domain: 'instrumentation', path: 'instrumentation.jsonl', summary: true, schema: events(['instrumentation']) },
  { domain: 'dfx', path: 'dfx-events.jsonl', summary: true, schema: events(['hilog', 'hiappevent', 'hitrace', 'hichecker']) },
  { domain: 'memory', path: 'memory-clues.jsonl', summary: true, schema: events(['hidebug', 'jsleak']) },
  { domain: 'ui', path: 'ui-tree.json', schema: structural(z.strictObject({ windowId: id, ...tree, ...uiGeometry })) },
  { domain: 'errors', path: 'error-clues.json', schema: structural(z.strictObject({
    clueId: id, category: z.enum(['api', 'jscrash', 'cppcrash', 'freeze', 'memory', 'network']),
    code: id, api: id.optional(), eventIds: z.array(id).max(256),
  })) },
  { domain: 'diagnosis', path: 'local-diagnosis.json', schema: structural(z.strictObject({
    candidateId: id, ruleId: id, confidence: z.number().finite().min(0).max(1), clueIds: z.array(id).min(1).max(256),
  })) },
  { domain: 'faultlog', directory: 'faultlog', summary: true, schema: events(['faultlog']) },
  { domain: 'snapshots', directory: 'snapshots', summary: true, schema: events(['jsleak']) },
] as const;
export const KitDomainSchema = z.enum(KIT_DOMAINS.map((item) => item.domain));
export const KitPageFields = {
  domain: KitDomainSchema.optional(), file: z.string().min(1).max(240).optional(),
};
export interface KitPageSelection {
  domain: z.infer<typeof KitDomainSchema>; file?: string; after: number; limit: number;
}
export interface KitRecordPage extends KitPageSelection {
  count: number; nextCursor: number; hasMore: boolean;
  records: Array<{ index: number; path: string; representation: string; record: unknown }>;
}
const statusSchema = z.enum(['captured', 'summary-only']);
export const KitFileEvidenceSchema = z.strictObject({
  path: z.string().max(240), domain: KitDomainSchema, source: sourceSchema, status: statusSchema,
  count: z.number().int().min(1).max(4096), dropped: CounterSchema, sampled: z.boolean(),
  representation: z.enum(['domain-summary', 'structural-metadata', 'attachment']),
  review: z.literal('explicit-export').optional(),
});
export const KitProfileSchema = z.strictObject({
  profile: z.literal('kit-readonly-v1'), identity: identitySchema, provenance: z.literal('peer-reported'),
  privacy: z.literal('memory-only-text-excluded'),
  attachmentPolicy: z.enum(['none', 'user-reviewed']),
  files: z.array(KitFileEvidenceSchema).max(10000),
  domains: z.array(z.strictObject({ domain: KitDomainSchema, status: z.enum(['captured', 'summary-only', 'not-captured']),
    count: CounterSchema, reason: z.enum(['provided', 'not-captured']) })).length(KIT_DOMAINS.length),
});
export type KitProfile = z.infer<typeof KitProfileSchema>;
const inputFileSchema = KitFileEvidenceSchema.omit({ domain: true, count: true, representation: true, review: true });
const inputSchema = z.strictObject({ files: z.array(inputFileSchema.extend({
  records: z.array(z.unknown()).min(1).max(4096),
})).max(10000), attachments: z.array(inputFileSchema.extend({
  bytes: z.instanceof(Buffer), review: z.literal('explicit-export'),
})).max(10000).optional() });
type Domain = typeof KIT_DOMAINS[number];

export function kitDomain(path: string): Domain {
  if (problemAttachmentType(path)) { return KIT_DOMAINS.find((item) => item.domain === path.split('/')[0])!; }
  const domain = KIT_DOMAINS.find((item) => 'path' in item ? item.path === path :
    new RegExp(`^${item.directory}/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$`).test(path));
  if (!domain) { throw new Error('PROBLEM_CONTENT_UNSUPPORTED'); }
  return domain;
}
export function kitSchemas(): Map<string, unknown> {
  return new Map([
    ['schemas/kit-profile.schema.json', z.toJSONSchema(KitProfileSchema)],
    ...KIT_DOMAINS.map((item): [string, unknown] => [`schemas/kit-${item.domain}.schema.json`,
      z.toJSONSchema('path' in item && item.path.endsWith('.jsonl') ? item.schema : z.array(item.schema).min(1).max(4096))]),
  ]);
}
function* checkedRecords(path: string, values: unknown[], identity: z.infer<typeof identitySchema>,
  omitted: { count: number }, additive: boolean): Generator<unknown> {
  if (!values.length || values.length > 4096) { throw new Error('PROBLEM_KIT_RECORDS_INVALID'); }
  const domain = kitDomain(path), schema = z.toJSONSchema(domain.schema), messages = new Set<string>();
  for (const value of values) {
    const record = domain.schema.parse(additive ? knownProblemFields(value, schema, omitted) : value);
    if ('summary' in domain) {
      const event = EventEnvelopeSchema.parse({ ...record as object, fingerprint: '0'.repeat(64) });
      if (Object.entries(identity).some(([key, item]) => event[key as keyof typeof identity] !== item)) {
        throw new Error('PROBLEM_IDENTITY_MISMATCH');
      }
      if (messages.has(event.messageId)) { throw new Error('PROBLEM_KIT_RECORDS_INVALID'); }
      messages.add(event.messageId);
      if (canonicalJson(redactDebugEvent(event).payload) !== canonicalJson(event.payload)) {
        throw new Error('PROBLEM_REDACTION_INVALID');
      }
    }
    yield record;
  }
}
function domainCoverage(files: KitProfile['files']): KitProfile['domains'] {
  return KIT_DOMAINS.map(({ domain }) => {
    const selected = files.filter((file) => file.domain === domain);
    return { domain, count: selected.reduce((count, file) => count + file.count, 0),
      status: selected.some((file) => file.status === 'captured') ? 'captured' : selected.length ? 'summary-only' : 'not-captured',
      reason: selected.length ? 'provided' : 'not-captured' };
  });
}
function checkFileRole(file: KitProfile['files'][number]): void {
  const domain = kitDomain(file.path);
  const attachment = Boolean(problemAttachmentType(file.path));
  const expected = attachment ? 'attachment' : 'summary' in domain ? 'domain-summary' : 'structural-metadata';
  if (domain.domain !== file.domain || file.representation !== expected ||
    attachment && (file.count !== 1 || file.review !== 'explicit-export' || file.status !== 'captured') ||
    !attachment && (file.review !== undefined || 'summary' in domain && file.status !== 'summary-only')) {
    throw new Error('PROBLEM_FILE_ROLE');
  }
}
export function buildKitProfile(input: unknown, identity: z.infer<typeof identitySchema>) {
  const parsed = inputSchema.parse(input), files = new Map<string, Buffer>(), evidence: KitProfile['files'] = [], seen = new Set<string>();
  for (const item of parsed.files) {
    if (seen.has(item.path.toLowerCase())) { throw new Error('PROBLEM_DUPLICATE_PATH'); }
    seen.add(item.path.toLowerCase());
    const domain = kitDomain(item.path), records = [...checkedRecords(item.path, item.records, identity, { count: 0 }, false)];
    const { records: _records, ...metadata } = item; void _records;
    const descriptor: KitProfile['files'][number] = { ...metadata, domain: domain.domain, count: records.length,
      representation: 'summary' in domain ? 'domain-summary' : 'structural-metadata' };
    checkFileRole(descriptor); evidence.push(descriptor);
    files.set(item.path, Buffer.from(item.path.endsWith('.jsonl') ?
      records.map((value) => canonicalJson(value) + '\n').join('') : canonicalJson(records)));
  }
  for (const item of parsed.attachments ?? []) {
    if (seen.has(item.path.toLowerCase())) { throw new Error('PROBLEM_DUPLICATE_PATH'); }
    seen.add(item.path.toLowerCase());
    const checker = attachmentVerifier(item.path);
    for (let offset = 0; offset < item.bytes.length; offset += 65536) { checker.visit(item.bytes.subarray(offset, offset + 65536)); }
    checker.finish(item.bytes.length);
    const { bytes, ...metadata } = item;
    const descriptor: KitProfile['files'][number] = { ...metadata, domain: kitDomain(item.path).domain, count: 1, representation: 'attachment' };
    checkFileRole(descriptor); evidence.push(descriptor); files.set(item.path, bytes);
  }
  const profile = KitProfileSchema.parse({ profile: 'kit-readonly-v1', identity, provenance: 'peer-reported',
    privacy: 'memory-only-text-excluded', attachmentPolicy: parsed.attachments?.length ? 'user-reviewed' : 'none',
    files: evidence, domains: domainCoverage(evidence) });
  files.set('profile.json', Buffer.from(canonicalJson(profile)));
  return { files, profile };
}
function pageCollector(profile: KitProfile, selection: KitPageSelection) {
  const files = profile.files.filter((file) => file.domain === selection.domain && (!selection.file || file.path === selection.file));
  if (selection.file && !files.length) { throw new Error('PROBLEM_KIT_FILE_INVALID'); }
  const count = files.reduce((total, file) => total + (file.representation === 'attachment' ? 0 : file.count), 0);
  if (selection.after > count) { throw new Error('PROBLEM_CURSOR_INVALID'); }
  const page: KitRecordPage = { ...selection, count, nextCursor: selection.after, hasMore: selection.after < count, records: [] };
  let index = 0, bytes = 2, full = false;
  const paths = new Set(files.map((file) => file.path));
  return { page, visit(file: KitProfile['files'][number], record: unknown) {
    if (!paths.has(file.path)) { return; }
    index++;
    if (index <= selection.after || full) { return; }
    const item = { index, path: file.path, representation: file.representation, record };
    const size = Buffer.byteLength(JSON.stringify(item)) + (page.records.length ? 1 : 0);
    if (page.records.length >= selection.limit || bytes + size > 48 * 1024) {
      if (!page.records.length) { throw new Error('PROBLEM_PAGE_LIMIT'); }
      full = true; return;
    }
    page.records.push(item); bytes += size; page.nextCursor = index; page.hasMore = index < count;
  } };
}
export function verifyKitProfile(content: ReadonlyMap<string, Buffer>, identity: z.infer<typeof identitySchema>,
  omitted: { count: number }, additive: boolean, attachments: ReadonlySet<string>, selection?: KitPageSelection) {
  const raw = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(content.get('profile.json')));
  const profile = KitProfileSchema.parse(additive ? knownProblemFields(raw, z.toJSONSchema(KitProfileSchema), omitted) : raw);
  if (canonicalJson(profile.identity) !== canonicalJson(identity)) { throw new Error('PROBLEM_IDENTITY_MISMATCH'); }
  const collector = selection ? pageCollector(profile, selection) : undefined;
  const seen = new Set<string>();
  for (const file of profile.files) {
    checkFileRole(file);
    if (seen.has(file.path.toLowerCase())) { throw new Error('PROBLEM_DUPLICATE_PATH'); }
    seen.add(file.path.toLowerCase());
    if (file.representation === 'attachment') {
      if (!attachments.has(file.path)) { throw new Error('PROBLEM_CONTENT_UNSUPPORTED'); }
      continue;
    }
    const bytes = content.get(file.path);
    if (!bytes) { throw new Error('PROBLEM_CONTENT_UNSUPPORTED'); }
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (file.path.endsWith('.jsonl') && (!text || !text.endsWith('\n'))) { throw new Error('PROBLEM_JSONL_INVALID'); }
    const values = file.path.endsWith('.jsonl') ? text.slice(0, -1).split('\n').map((line) => JSON.parse(line)) : JSON.parse(text);
    let count = 0;
    for (const record of checkedRecords(file.path, z.array(z.unknown()).parse(values), identity, omitted, additive)) {
      count++; collector?.visit(file, record);
    }
    if (count !== file.count) { throw new Error('PROBLEM_KIT_RECORDS_INVALID'); }
  }
  if (profile.attachmentPolicy !== (attachments.size ? 'user-reviewed' : 'none')) { throw new Error('PROBLEM_FILE_ROLE'); }
  if (canonicalJson(profile.domains) !== canonicalJson(domainCoverage(profile.files))) { throw new Error('PROBLEM_COVERAGE_INVALID'); }
  const actual = [...content.keys(), ...attachments].filter((path) => !path.startsWith('schemas/') &&
    !['session.json', 'events.jsonl', 'profile.json'].includes(path));
  if (actual.length !== seen.size || actual.some((path) => !seen.has(path.toLowerCase()))) {
    throw new Error('PROBLEM_CONTENT_UNSUPPORTED');
  }
  return { profile, page: collector?.page };
}
