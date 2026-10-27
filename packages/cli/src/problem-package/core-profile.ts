/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { z } from 'zod';
import { canonicalJson } from '../debug-protocol/canonical-hash.js';
import { ProblemManifestSchema } from './schemas.js';
import { compatibleProblemSchema } from './compatibility.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fieldBase = z.strictObject({ key: identifier });
const field = z.union([
  fieldBase.extend({ kind: z.literal('enum'), values: z.array(identifier).min(1).max(32) }),
  fieldBase.extend({ kind: z.literal('number'), minimum: z.number().finite(), maximum: z.number().finite() }),
  fieldBase.extend({ kind: z.literal('boolean'), values: z.array(identifier).max(32).optional() }),
]);
const registeredSchema = z.strictObject({ name: identifier, fields: z.array(field).max(16) });
const event = z.strictObject({
  sequence: counter.min(1), source: z.enum(['application', 'recorder']), name: identifier,
  priority: z.enum(['critical', 'high', 'normal', 'verbose']), sessionId: identifier,
  clock: z.strictObject({ clockId: identifier, bootId: identifier, monotonicNs: counter,
    wallTimeUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) }),
  fields: z.record(identifier, z.union([identifier, z.number().finite(), z.boolean()])),
});
export const CoreArchiveSchema = z.strictObject({
  profile: z.literal('core-readonly-v1'), provenance: z.literal('application-reported'),
  privacy: z.literal('registered-fields-only'),
  schemas: z.array(registeredSchema).max(64),
  summary: z.strictObject({
    schemaVersion: z.literal('1.0'), profile: z.literal('ohmate-core-summary'),
    problemId: identifier, sessionId: identifier,
    buildId: z.string().max(128).regex(/^[A-Za-z0-9_.@-]*$/),
    buildVerification: z.literal('unverified-build'), replay: z.literal('manual-only'),
    events: z.array(event).max(1024), attachments: z.array(z.string()).length(0),
    loss: z.strictObject({ dropped: counter, criticalDropped: counter, firstSequence: counter,
      lastSequence: counter, rangeKind: z.literal('envelope') }),
    triage: z.strictObject({ confidence: z.enum(['insufficient-evidence', 'single-reported-clue']),
      fault: z.enum(['unknown', 'crash', 'freeze', 'oom', 'render-exit', 'unhandled-error']),
      source: z.literal('application-reported'),
      missing: z.tuple([z.literal('system-first-scene'), z.literal('authenticated-build'), z.literal('symbols')]) }),
  }),
});
export const CoreManifestSchema = ProblemManifestSchema.extend({ content: z.literal('core-readonly') });
export type CoreArchive = z.infer<typeof CoreArchiveSchema>;
export type CoreManifest = z.infer<typeof CoreManifestSchema>;
export function coreProblemSchemas(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['schemas/manifest.schema.json', z.toJSONSchema(CoreManifestSchema)],
    ['schemas/core-summary.schema.json', z.toJSONSchema(CoreArchiveSchema)],
  ]);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function coreKnownFields(value: unknown, schema: unknown, omitted: { count: number }): unknown {
  if (!object(schema)) { return value; }
  if (Array.isArray(schema.anyOf)) {
    const branch = schema.anyOf.find(option => object(option) && object(option.properties) &&
      object(option.properties.kind) && object(value) && option.properties.kind.const === value.kind);
    return branch ? coreKnownFields(value, branch, omitted) : value;
  }
  if (Array.isArray(value) && schema.type === 'array') {
    return value.map((item, index) => coreKnownFields(item,
      Array.isArray(schema.prefixItems) ? schema.prefixItems[index] : schema.items, omitted));
  }
  if (!object(value) || !object(schema.properties)) { return value; }
  const properties = schema.properties, result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) { result[key] = coreKnownFields(item, properties[key], omitted); }
    else {
      // Minor metadata can be omitted; privacy, authentication and capability claims cannot.
      if (/token|cookie|password|secret|body|phone|device|input|email|address|identity|auth|verif|provenance|clock|replay|diagnos|capabil/i.test(key)) {
        throw new Error('PROBLEM_CORE_FORBIDDEN_CLAIM');
      }
      omitted.count++;
    }
  }
  return result;
}
export function verifyCoreArchive(content: ReadonlyMap<string, Buffer>, manifest: CoreManifest,
  omitted: { count: number }): CoreArchive {
  const additive = Number(manifest.schemaVersion.split('.')[1]) > 5;
  if (Number(manifest.schemaVersion.split('.')[1]) < 5 || content.size !== 3) { throw new Error('PROBLEM_CORE_LAYOUT'); }
  for (const [path, schema] of coreProblemSchemas()) {
    const bytes = content.get(path);
    if (!bytes) { throw new Error('PROBLEM_SCHEMA_MISMATCH'); }
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!(additive ? compatibleProblemSchema(candidate, schema) : canonicalJson(candidate) === canonicalJson(schema))) {
      throw new Error('PROBLEM_SCHEMA_MISMATCH');
    }
  }
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.get('core-summary.json')));
  const archive = CoreArchiveSchema.parse(additive ? coreKnownFields(raw, z.toJSONSchema(CoreArchiveSchema), omitted) : raw);
  verifyCoreSchemas(archive.schemas);
  const { summary, schemas } = archive;
  if (summary.sessionId !== manifest.sessionId || summary.problemId !== manifest.problemId ||
    summary.loss.criticalDropped > summary.loss.dropped || summary.loss.firstSequence > summary.loss.lastSequence) {
    throw new Error('PROBLEM_CORE_IDENTITY');
  }
  verifyCoreEvents(summary, schemas);
  const fault = summary.events.find(event => event.source === 'application' && event.priority === 'critical');
  if (summary.triage.fault !== (fault?.name ?? 'unknown') ||
    summary.triage.confidence !== (fault ? 'single-reported-clue' : 'insufficient-evidence')) {
    throw new Error('PROBLEM_CORE_TRIAGE');
  }
  return archive;
}
function verifyCoreSchemas(schemas: CoreArchive['schemas']): void {
  const names = new Set<string>();
  for (const schema of schemas) {
    if (names.has(schema.name)) { throw new Error('PROBLEM_CORE_SCHEMA'); }
    names.add(schema.name);
    const keys = new Set<string>();
    for (const field of schema.fields) {
      if (keys.has(field.key) || /token|cookie|password|secret|body|phone|device|input|email|address|identity/i.test(field.key) ||
        field.kind === 'enum' && new Set(field.values).size !== field.values.length ||
        field.kind === 'number' && field.minimum > field.maximum) { throw new Error('PROBLEM_CORE_SCHEMA'); }
      keys.add(field.key);
    }
  }
}
function verifyCoreEvents(summary: CoreArchive['summary'], schemas: CoreArchive['schemas']): void {
  let previous: CoreArchive['summary']['events'][number] | undefined;
  for (const event of summary.events) {
    if (event.sessionId !== summary.sessionId || previous && (event.sequence <= previous.sequence ||
      event.clock.clockId !== previous.clock.clockId || event.clock.bootId !== previous.clock.bootId ||
      event.clock.monotonicNs < previous.clock.monotonicNs)) { throw new Error('PROBLEM_CORE_SEQUENCE'); }
    previous = event;
    if (event.source === 'recorder' || event.priority === 'critical') {
      const allowed = event.source === 'recorder' ? ['active', 'heartbeat', 'pause', 'resume', 'close'] :
        ['crash', 'freeze', 'oom', 'render-exit', 'unhandled-error'];
      if (!allowed.includes(event.name) || Object.keys(event.fields).length ||
        event.source === 'recorder' && event.priority !== 'high') { throw new Error('PROBLEM_CORE_EVENT'); }
      continue;
    }
    const schema = schemas.find(schema => schema.name === event.name);
    if (!schema || Object.keys(event.fields).length > 16) { throw new Error('PROBLEM_CORE_EVENT'); }
    for (const [key, value] of Object.entries(event.fields)) {
      const field = schema.fields.find(field => field.key === key);
      if (!field || !(field.kind === 'boolean' ? typeof value === 'boolean' :
        field.kind === 'enum' ? typeof value === 'string' && field.values.includes(value) :
          typeof value === 'number' && value >= field.minimum && value <= field.maximum)) {
        throw new Error('PROBLEM_REDACTION_INVALID');
      }
    }
  }
}
