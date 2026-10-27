/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { evidenceFile, privateEvidenceName } from './evidence.js';
import { readEvidenceText } from './source-scope.js';
import { compilerCacheInfoFiles, compilerConfigurationFields } from './compiler-observer-source.js';

const filePath = z.string().min(1).max(4096);
const scope = z.enum(['project', 'sdk']);
const configurationValues = z.record(z.string(), z.union([z.string().max(4096), z.boolean(), z.number().finite()]));
const configurationStageSchema = z.strictObject({
  stage: z.enum(['sdk-loader-input', 'sdk-loader-output', 'rollup-input', 'ark-config', 'ark-project']),
  values: configurationValues.refine(values => Object.keys(values).every(key =>
    (compilerConfigurationFields as readonly string[]).includes(key))),
});
const filesystemTextMethods = ['readFileSync', 'fs.readFile', 'fs.promises.readFile', 'FileHandle.readFile'];
const filesystemReadMethods = [...filesystemTextMethods, 'fs.createReadStream', 'FileHandle.createReadStream'] as const;
const textReadSchema = z.strictObject({
  scope, path: filePath, method: z.enum(['readFile', 'getScriptSnapshot', 'readFileSync', 'fs.readFile', 'fs.promises.readFile', 'FileHandle.readFile']),
  textSha256: z.string().regex(/^[a-f0-9]{64}$/), utf8Size: z.number().int().min(0).max(8 * 1024 * 1024),
  binding: z.enum(['host-text-only', 'decoded-filesystem-text']), readObserved: z.boolean(),
});
const watchSchema = z.strictObject({
  sessionId: z.string().uuid(), round: z.number().int().min(1).max(64),
  operation: z.enum(['run', 'hotCompile', 'close']),
  events: z.array(z.enum(['BUNDLE_START', 'BUNDLE_END', 'ERROR', 'STOP_HOT_COMPILE'])).max(8),
  changedFiles: z.array(filePath).max(10000), reusedFiles: z.array(filePath).max(10000), taskClosed: z.boolean(),
});
const cachePathSchema = z.strictObject({ scope, path: filePath });
const nativeInputWriteSchema = z.strictObject({
  sequence: z.number().int().positive().max(512), observationOrder: z.number().int().positive().max(20000),
  generationId: z.string().uuid(), generationOrder: z.number().int().positive().max(20000).optional(),
  operation: z.enum(['writeFileContentToTempDir', 'writeFileSyncByNode']),
  source: cachePathSchema, destination: cachePathSchema,
  size: z.number().int().min(0).max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  write: z.enum(['returned', 'threw']), generation: z.enum(['pending', 'returned', 'threw']),
  binding: z.literal('sdk-source-write-call-only'),
});
const nativeInputReferenceSchema = z.strictObject({
  ordinal: z.number().int().positive().max(512), format: z.enum(['module', 'bytecode', 'cache-pair']),
  input: cachePathSchema, output: cachePathSchema.optional(),
  fieldSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(6),
  sourceWriteSequence: z.number().int().positive().max(512).optional(),
  sourceDescriptionSequence: z.number().int().positive().max(64).optional(),
});
const nativeDescriptionSchema = cachePathSchema.extend({
  sequence: z.number().int().positive().max(64), observationOrder: z.number().int().positive().max(20000),
  ownerId: z.string().uuid(),
  operation: z.enum(['generateCompileFilesInfo', 'generateNpmEntriesInfo', 'generateAbcCacheFilesInfo', 'generateCompileContextInfo']),
  role: z.enum(['files-info', 'npm-entries', 'cache-info', 'compile-context']),
  size: z.number().int().min(0).max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  write: z.enum(['returned', 'threw']), generation: z.enum(['returned', 'threw']), binding: z.literal('sdk-write-call-only'),
  inputReferences: z.array(nativeInputReferenceSchema).max(512).default([]),
});
const nativeCallSchema = z.strictObject({
  sequence: z.number().int().positive().max(64), kind: z.literal('sdk-es2abc-shell-call'),
  ownerId: z.string().uuid().optional(), observationOrder: z.number().int().positive().max(20000).optional(),
  descriptionSequences: z.array(z.number().int().positive().max(64)).max(4).default([]),
  commandSha256: z.string().regex(/^[a-f0-9]{64}$/), commandBytes: z.number().int().min(1).max(64 * 1024),
  argumentCount: z.number().int().min(1).max(256),
  projectConfiguration: configurationValues, arkConfiguration: configurationValues,
  paths: z.array(cachePathSchema.extend({
    role: z.enum(['files-info', 'npm-entries', 'cache-info', 'compile-context', 'output']),
  })).max(5),
  dispatch: z.enum(['not-observed', 'returned', 'threw']), pid: z.number().int().positive().nullable(),
  close: z.strictObject({ code: z.number().int().nullable(),
    signal: z.string().regex(/^[A-Z0-9_-]{1,40}$/).nullable() }).nullable(),
}).refine(call => [call.projectConfiguration, call.arkConfiguration].every(values =>
  Object.keys(values).every(key => (compilerConfigurationFields as readonly string[]).includes(key))));
const cacheEventSchema = z.strictObject({
  sequence: z.number().int().positive().max(10000),
  operation: z.enum(['store-load', 'store-get', 'store-set', 'store-persist', 'memory-load',
    'file-module-load', 'rollup-input', 'rollup-output']),
  cacheId: z.string().uuid().nullable(), storeId: z.string().uuid().optional(),
  modules: z.array(z.string().uuid()).max(10000), path: cachePathSchema.optional(),
  reads: z.array(cachePathSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
    binding: z.enum(['raw-filesystem-bytes', 'decoded-filesystem-text']) })).max(10000),
});
const observationSchema = z.strictObject({
  version: z.literal(1), phase: z.enum(['started', 'closed', 'unfinished']), pid: z.number().int().positive(),
  configuration: configurationValues,
  configurationStages: z.array(configurationStageSchema).max(64).default([]),
  cacheEvents: z.array(cacheEventSchema).max(10000).default([]),
  nativeCalls: z.array(nativeCallSchema).max(64).default([]),
  nativeDescriptions: z.array(nativeDescriptionSchema).max(64).default([]),
  nativeInputWrites: z.array(nativeInputWriteSchema).max(512).default([]),
  watch: watchSchema.optional(),
  files: z.array(z.strictObject({ scope, path: filePath, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(8 * 1024 * 1024),
    readMethods: z.array(z.enum(filesystemReadMethods)).max(6).default([]),
    role: z.enum(['compiler-host-read', 'runtime-read', 'generated-runtime-read', 'compiler-cache-read']) })).max(10000),
  probes: z.array(z.strictObject({ scope, path: filePath, exists: z.boolean() })).max(10000),
  resolutions: z.array(z.strictObject({ containingFile: filePath, containingScope: scope,
    resolvedFile: filePath, resolvedScope: scope })).max(10000),
  hosts: z.array(z.strictObject({ kind: z.enum(['language-service', 'watch-compiler', 'watch-program', 'compiler', 'program']), path: filePath })).max(10000),
  textReads: z.array(textReadSchema).max(10000).default([]),
  drift: z.array(filePath).max(10000), missing: z.array(z.string().max(100)).max(100),
});
export interface CompilerObservation {
  scope: 'actual-compiler-hosts'; binding: 'observed-partial' | 'not-observed';
  configurations: Record<string, string | number | boolean>[];
  configurationStages: (z.infer<typeof configurationStageSchema> & { configurationIndex: number })[];
  watchRounds: (z.infer<typeof watchSchema> & { configurationIndex: number; binding: 'rollup-reported' })[];
  cacheEvents: (z.infer<typeof cacheEventSchema> & { configurationIndex: number; binding: 'observed-reference-only' })[];
  nativeCalls: (z.infer<typeof nativeCallSchema> & { configurationIndex: number; binding: 'sdk-call-reference-only' })[];
  nativeDescriptions: (z.infer<typeof nativeDescriptionSchema> & { configurationIndex: number })[];
  nativeInputWrites: (z.infer<typeof nativeInputWriteSchema> & { configurationIndex: number })[];
  hosts: { kind: string; path: string; sha256?: string }[];
  files: { path: string; scope: 'project' | 'sdk'; sha256: string; size: number; role: string; readMethods?: string[] }[];
  textReads: z.infer<typeof textReadSchema>[];
  resolutions: { containingFile: string; resolvedFile: string }[];
  cacheTransitions: { path: string; readSha256: string | null; afterSha256: string; binding: 'cache-unverified' }[];
  drift: string[]; missing: string[]; invalid: boolean;
}
export function emptyCompilerObservation(): CompilerObservation {
  return { scope: 'actual-compiler-hosts', binding: 'not-observed', configurations: [], configurationStages: [],
    watchRounds: [], cacheEvents: [], nativeCalls: [], nativeDescriptions: [], nativeInputWrites: [],
    hosts: [], files: [], textReads: [],
    resolutions: [], cacheTransitions: [], drift: [], missing: ['actual-compiler-hosts-not-observed', 'full-final-compiler-configuration',
      'filesystem-observation-partial', 'compiler-cache-closure-unverified', 'native-compiler-inputs-unverified'], invalid: false };
}
function safePath(root: string, file: string) {
  const name = relative(root, file).split(sep).join('/');
  if (!isAbsolute(file) || name === '..' || name.startsWith('../') || isAbsolute(name) ||
    name.split('/').some((part) => privateEvidenceName.test(part) || /^(?:local\.properties|\.ohpmrc)$/i.test(part) ||
      [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) { throw new Error('Unsafe compiler path'); }
  return name;
}
export async function collectCompilerObservations(directory: string, project: string, sdk: string): Promise<CompilerObservation> {
  const result = emptyCompilerObservation(), roots = { project: resolve(project), sdk: resolve(sdk) };
  const names = await readdir(directory);
  const watchIdentities = new Map<string, { pid: number; configuration: string }>();
  let entries = 0, documentBytes = 0, inputBytes = 0;
  if (names.length > 64) { return { ...result, invalid: true, missing: [...result.missing, 'compiler-observation-file-budget'] }; }
  for (const name of names.sort()) {
    try {
      if (!/^[a-f0-9-]{36}\.jsonl$/.test(name)) { throw new Error('Unexpected compiler observation'); }
      const document = await readEvidenceText(directory, join(directory, name), Math.min(8 * 1024 * 1024, 16 * 1024 * 1024 - documentBytes));
      documentBytes += document.evidence.size;
      const records = document.text.trim().split('\n').map((line) => observationSchema.parse(JSON.parse(line)));
      const record = records.at(-1)!, usage = observationUsage(record);
      entries += usage.entries; inputBytes += usage.inputBytes;
      if (entries > 10000 || inputBytes > 64 * 1024 * 1024 || usage.exceeded) {
        result.invalid = true; result.missing.push('compiler-observation-total-budget'); break;
      }
      if (records.length !== 2 || records[0].phase !== 'started' || record.phase !== 'closed' ||
        records[0].configurationStages.length ||
        records[0].pid !== record.pid || JSON.stringify(records[0].configuration) !== JSON.stringify(record.configuration)) {
        result.invalid = true; result.missing.push('compiler-observation-unfinished');
      }
      result.binding = 'observed-partial';
      result.configurations.push({ ...record.configuration, officialBuildId: record.configuration.buildId ?? '' });
      result.configurationStages.push(...record.configurationStages.map(item =>
        ({ ...item, configurationIndex: result.configurations.length - 1 })));
      observedCache(record, records[0].cacheEvents, roots, result);
      observedInputWrites(record, records[0].nativeInputWrites, roots, result);
      observedDescriptions(record, records[0].nativeDescriptions, roots, result);
      observedNative(record, records[0].nativeCalls, roots, result);
      observedWatch(record, records[0].watch, roots, result, watchIdentities);
      await observedFiles(record, roots, result);
    } catch {
      result.invalid = true; result.missing.push('compiler-observation-unreadable');
    }
  }
  validateWatchRounds(result);
  result.missing = [...new Set(result.missing.filter((item) => item !== 'actual-compiler-hosts-not-observed' || !result.hosts.length))];
  result.drift = [...new Set(result.drift)].sort();
  return result;
}
function observationUsage(record: z.infer<typeof observationSchema>) {
  const configurationBytes = record.configurationStages.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.values)), 0);
  const cacheBytes = Buffer.byteLength(JSON.stringify(record.cacheEvents));
  const nativeBytes = Buffer.byteLength(JSON.stringify(record.nativeCalls));
  const descriptionBytes = Buffer.byteLength(JSON.stringify(record.nativeDescriptions));
  const descriptionInputs = record.nativeDescriptions.reduce((sum, item) => sum + item.size, 0);
  const generatedInputs = record.nativeInputWrites.reduce((sum, item) => sum + item.size, 0);
  const generatedBytes = Buffer.byteLength(JSON.stringify(record.nativeInputWrites));
  const references = record.nativeDescriptions.flatMap(item => item.inputReferences);
  const referenceBytes = Buffer.byteLength(JSON.stringify(references));
  const watchPaths = [...(record.watch?.changedFiles ?? []), ...(record.watch?.reusedFiles ?? [])];
  const entries = record.files.length + record.probes.length + record.resolutions.length + record.hosts.length +
    record.textReads.length + record.configurationStages.length + watchPaths.length + (record.watch?.events.length ?? 0) +
    record.nativeCalls.reduce((sum, call) => sum + 1 + call.paths.length + call.descriptionSequences.length, 0) +
    record.nativeDescriptions.length + record.nativeInputWrites.length + references.length +
    record.cacheEvents.reduce((sum, event) => sum + 1 + event.modules.length + event.reads.length, 0);
  const inputBytes = record.files.reduce((sum, item) => sum + item.size, 0) +
    record.textReads.reduce((sum, item) => sum + item.utf8Size, 0) + configurationBytes + cacheBytes + nativeBytes +
    descriptionBytes + descriptionInputs + generatedInputs + generatedBytes +
    watchPaths.reduce((sum, file) => sum + Buffer.byteLength(file), 0);
  return { entries, inputBytes, exceeded: configurationBytes > 256 * 1024 || nativeBytes > 256 * 1024 ||
    descriptionBytes > 256 * 1024 || descriptionInputs > 16 * 1024 * 1024 ||
    generatedInputs > 16 * 1024 * 1024 || generatedBytes > 512 * 1024 || referenceBytes > 256 * 1024 };
}
function observedInputWrites(record: z.infer<typeof observationSchema>, started: z.infer<typeof nativeInputWriteSchema>[],
  roots: { project: string; sdk: string }, result: CompilerObservation) {
  if (started.length) { result.invalid = true; result.missing.push('native-input-start-mismatch'); }
  const orders = new Map<number, string>();
  for (const item of record.nativeDescriptions) { orders.set(item.observationOrder, 'description'); }
  for (const call of record.nativeCalls) {
    if (call.observationOrder !== undefined) { orders.set(call.observationOrder, 'call'); }
  }
  const generations = new Map<string, { order?: number; outcome: string; source: string; operation: string }>();
  const nameOf = (file: z.infer<typeof cachePathSchema>) =>
    ({ ...file, path: `${file.scope === 'sdk' ? 'sdk/' : ''}${safePath(roots[file.scope], file.path)}` });
  for (const [index, item] of record.nativeInputWrites.entries()) {
    const source = JSON.stringify(item.source), generation = generations.get(item.generationId);
    if (item.sequence !== index + 1 || orders.has(item.observationOrder) ||
        index > 0 && item.observationOrder <= record.nativeInputWrites[index - 1]!.observationOrder ||
        (item.generation === 'pending' ? item.generationOrder !== undefined :
          item.generationOrder === undefined || item.generationOrder <= item.observationOrder) ||
        item.generationOrder !== undefined && orders.has(item.generationOrder) && orders.get(item.generationOrder) !== item.generationId ||
        generation && (generation.order !== item.generationOrder || generation.outcome !== item.generation ||
          generation.source !== source || generation.operation !== item.operation)) {
      result.invalid = true; result.missing.push('native-input-record-invalid');
    }
    orders.set(item.observationOrder, 'write');
    if (item.generationOrder !== undefined) { orders.set(item.generationOrder, item.generationId); }
    generations.set(item.generationId, { order: item.generationOrder, outcome: item.generation, source, operation: item.operation });
    result.nativeInputWrites.push({ ...item, source: nameOf(item.source), destination: nameOf(item.destination),
      configurationIndex: result.configurations.length - 1 });
  }
}
function observedInputReferences(description: z.infer<typeof nativeDescriptionSchema>,
  record: z.infer<typeof observationSchema>, roots: { project: string; sdk: string }, result: CompilerObservation) {
  const writes = record.nativeInputWrites;
  const nameOf = (file: z.infer<typeof cachePathSchema>) =>
    ({ ...file, path: `${file.scope === 'sdk' ? 'sdk/' : ''}${safePath(roots[file.scope], file.path)}` });
  const matches = (a: z.infer<typeof cachePathSchema>, b: z.infer<typeof cachePathSchema>) => a.path === b.path && a.scope === b.scope;
  return description.inputReferences.map((reference, index) => {
    const cache = reference.format === 'cache-pair', bytecode = reference.format === 'bytecode';
    if (reference.ordinal !== index + 1 || description.role !== (cache ? 'cache-info' : 'files-info') ||
        reference.fieldSha256.length !== (cache ? 1 : bytecode ? 5 : 6) ||
        cache !== Boolean(reference.output) || bytecode && reference.sourceWriteSequence !== undefined) {
      result.invalid = true; result.missing.push('native-input-reference-invalid');
    }
    if (reference.sourceWriteSequence !== undefined) {
      const write = writes[reference.sourceWriteSequence - 1];
      if (!write || write.sequence !== reference.sourceWriteSequence || !matches(write.destination, reference.input) ||
          write.write !== 'returned' || write.generation !== 'returned' ||
          !write.generationOrder || write.generationOrder >= description.observationOrder ||
          description.write !== 'returned' || description.generation !== 'returned' ||
          writes.some(other => other !== write && (other.generationId === write.generationId ||
            other.observationOrder > write.observationOrder && other.observationOrder < description.observationOrder &&
              (matches(other.destination, write.destination) || matches(other.source, write.source))))) {
        result.invalid = true; result.missing.push('native-input-source-binding-invalid');
      }
    }
    if (reference.sourceDescriptionSequence !== undefined && !validCacheDescriptionOrigin(description, reference, record)) {
      result.invalid = true; result.missing.push('native-input-description-binding-invalid');
    }
    return { ...reference, input: nameOf(reference.input), ...(reference.output ? { output: nameOf(reference.output) } : {}) };
  });
}
function validCacheDescriptionOrigin(description: z.infer<typeof nativeDescriptionSchema>,
  reference: z.infer<typeof nativeInputReferenceSchema>, record: z.infer<typeof observationSchema>) {
  const origin = record.nativeDescriptions[(reference.sourceDescriptionSequence ?? 0) - 1];
  const matches = (file: z.infer<typeof cachePathSchema>) => file.path === reference.input.path && file.scope === reference.input.scope;
  return Boolean(origin && origin.sequence === reference.sourceDescriptionSequence && reference.format === 'cache-pair' &&
    reference.sourceWriteSequence === undefined && description.role === 'cache-info' && origin.role === 'npm-entries' &&
    origin.ownerId === description.ownerId && matches(origin) && origin.write === 'returned' && origin.generation === 'returned' &&
    description.write === 'returned' && description.generation === 'returned' &&
    origin.observationOrder < description.observationOrder &&
    !record.nativeDescriptions.some(other => other.observationOrder > origin.observationOrder &&
      other.observationOrder < description.observationOrder &&
      (matches(other) || other.ownerId === origin.ownerId && other.role === origin.role)) &&
    !record.nativeInputWrites.some(other => other.observationOrder > origin.observationOrder &&
      other.observationOrder < description.observationOrder && matches(other.destination)));
}
function observedDescriptions(record: z.infer<typeof observationSchema>, started: z.infer<typeof nativeDescriptionSchema>[],
  roots: { project: string; sdk: string }, result: CompilerObservation) {
  if (started.length) { result.invalid = true; result.missing.push('native-description-start-mismatch'); }
  const operations = { 'files-info': 'generateCompileFilesInfo', 'npm-entries': 'generateNpmEntriesInfo',
    'cache-info': 'generateAbcCacheFilesInfo', 'compile-context': 'generateCompileContextInfo' };
  const orders = new Set<number>();
  for (const [index, item] of record.nativeDescriptions.entries()) {
    if (item.sequence !== index + 1 || operations[item.role] !== item.operation || orders.has(item.observationOrder) ||
        index > 0 && item.observationOrder <= record.nativeDescriptions[index - 1]!.observationOrder) {
      result.invalid = true; result.missing.push('native-description-record-invalid');
    }
    orders.add(item.observationOrder);
    result.nativeDescriptions.push({ ...item, configurationIndex: result.configurations.length - 1,
      inputReferences: observedInputReferences(item, record, roots, result),
      path: `${item.scope === 'sdk' ? 'sdk/' : ''}${safePath(roots[item.scope], item.path)}` });
  }
  for (const call of record.nativeCalls) {
    if (call.observationOrder !== undefined) {
      if (orders.has(call.observationOrder)) { result.invalid = true; result.missing.push('native-description-order-invalid'); }
      orders.add(call.observationOrder);
    }
    validateDescriptionReferences(call, record.nativeDescriptions, result);
  }
}
function validateDescriptionReferences(call: z.infer<typeof nativeCallSchema>,
  descriptions: z.infer<typeof nativeDescriptionSchema>[], result: CompilerObservation) {
  const roles = new Set<string>();
  for (const sequence of call.descriptionSequences) {
    const item = descriptions[sequence - 1];
    const path = item && call.paths.find(file => file.role === item.role);
    if (!item || item.sequence !== sequence || roles.has(item.role) || item.ownerId !== call.ownerId ||
        !call.observationOrder || item.observationOrder >= call.observationOrder || item.write !== 'returned' ||
        item.generation !== 'returned' || !path || path.path !== item.path || path.scope !== item.scope ||
        descriptions.some(later => later.ownerId === item.ownerId && later.role === item.role &&
          later.observationOrder > item.observationOrder && later.observationOrder < call.observationOrder!)) {
      result.invalid = true; result.missing.push('native-description-reference-invalid');
    }
    if (item) { roles.add(item.role); }
  }
  if (call.paths.some(file => file.role !== 'output' && !roles.has(file.role))) {
    result.missing.push('native-description-origin-unavailable');
  }
}
function observedNative(record: z.infer<typeof observationSchema>, started: z.infer<typeof nativeCallSchema>[],
  roots: { project: string; sdk: string }, result: CompilerObservation) {
  if (started.length) { result.invalid = true; result.missing.push('native-compiler-start-mismatch'); }
  for (const [index, call] of record.nativeCalls.entries()) {
    if (call.sequence !== index + 1 || new Set(call.paths.map(file => file.role)).size !== call.paths.length ||
        call.dispatch !== 'returned' && (call.pid !== null || call.close !== null)) {
      result.invalid = true; result.missing.push('native-compiler-call-invalid');
    }
    if (call.dispatch !== 'returned' || !call.close) {
      result.invalid = true; result.missing.push('native-compiler-dispatch-unavailable');
    }
    const paths = call.paths.map(file => ({ ...file,
      path: `${file.scope === 'sdk' ? 'sdk/' : ''}${safePath(roots[file.scope], file.path)}` }));
    for (const values of [call.projectConfiguration, call.arkConfiguration]) {
      for (const value of Object.values(values)) {
        if (typeof value === 'string' && (value.split(/[\\/]/).some(part =>
          privateEvidenceName.test(part) || /^(?:local\.properties|\.ohpmrc)$/i.test(part)) ||
          [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
          throw new Error('Unsafe native configuration');
        }
      }
    }
    result.nativeCalls.push({ ...call, paths, configurationIndex: result.configurations.length - 1,
      binding: 'sdk-call-reference-only' });
  }
}
function observedCache(record: z.infer<typeof observationSchema>, started: z.infer<typeof cacheEventSchema>[],
  roots: { project: string; sdk: string }, result: CompilerObservation) {
  if (started.length) { result.invalid = true; result.missing.push('compiler-cache-start-mismatch'); }
  const origins = new Set<string>(), nameOf = (file: z.infer<typeof cachePathSchema>) =>
    ({ ...file, path: `${file.scope === 'sdk' ? 'sdk/' : ''}${safePath(roots[file.scope], file.path)}` });
  for (const [index, event] of record.cacheEvents.entries()) {
    if (event.sequence !== index + 1) { result.invalid = true; result.missing.push('compiler-cache-sequence-mismatch'); }
    if (event.operation === 'file-module-load' || event.operation === 'memory-load') {
      if (event.cacheId) { origins.add(event.cacheId); }
      for (const id of event.modules) { origins.add(id); }
      if (event.operation === 'file-module-load' && !event.reads.length) {
        result.missing.push('compiler-cache-file-read-unavailable');
      }
    }
    if (event.operation === 'rollup-input' && event.cacheId &&
        (!origins.has(event.cacheId) || event.modules.some(id => !origins.has(id)))) {
      result.missing.push('compiler-cache-input-origin-unverified');
    }
    for (const read of event.reads) {
      const matches = read.binding === 'raw-filesystem-bytes' ?
        record.files.some(file => file.scope === read.scope && file.path === read.path && file.sha256 === read.sha256) :
        record.textReads.some(text => text.scope === read.scope && text.path === read.path &&
          text.binding === 'decoded-filesystem-text' && text.textSha256 === read.sha256);
      if (!matches) { result.invalid = true; result.missing.push('compiler-cache-read-binding-unavailable'); }
    }
    result.cacheEvents.push({ ...event, ...(event.path ? { path: nameOf(event.path) } : {}),
      reads: event.reads.map(read => ({ ...read, ...nameOf(read) })),
      configurationIndex: result.configurations.length - 1, binding: 'observed-reference-only' });
  }
}
function observedWatch(record: z.infer<typeof observationSchema>, started: z.infer<typeof watchSchema> | undefined,
  roots: { project: string; sdk: string }, result: CompilerObservation,
  identities: Map<string, { pid: number; configuration: string }>) {
  const watch = record.watch;
  if (!watch) {
    if (started) { result.invalid = true; result.missing.push('watch-round-start-mismatch'); }
    return;
  }
  if (!started || started.sessionId !== watch.sessionId || started.round !== watch.round ||
      started.operation !== watch.operation || started.events.length || started.changedFiles.length ||
      started.reusedFiles.length || started.taskClosed) {
    result.invalid = true; result.missing.push('watch-round-start-mismatch');
  }
  const configuration = JSON.stringify(Object.keys(record.configuration).sort().map(key => [key, record.configuration[key]]));
  const identity = identities.get(watch.sessionId);
  if (identity && (identity.pid !== record.pid || identity.configuration !== configuration)) {
    result.invalid = true; result.missing.push('watch-session-identity-mismatch');
  } else if (!identity) { identities.set(watch.sessionId, { pid: record.pid, configuration }); }
  const nameOf = (file: string) => file.startsWith(`${roots.sdk}${sep}`) ?
    `sdk/${safePath(roots.sdk, file)}` : safePath(roots.project, file);
  result.watchRounds.push({ ...watch, changedFiles: watch.changedFiles.map(nameOf),
    reusedFiles: watch.reusedFiles.map(nameOf), configurationIndex: result.configurations.length - 1, binding: 'rollup-reported' });
  result.missing.push('watch-cache-reuse-unverified');
}
function validateWatchRounds(result: CompilerObservation) {
  result.watchRounds.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.round - b.round);
  const sessions = new Map<string, CompilerObservation['watchRounds']>();
  for (const round of result.watchRounds) {
    const previous = sessions.get(round.sessionId) ?? [];
    const terminal = previous.at(-1);
    if (round.round !== previous.length + 1 || terminal?.operation === 'close' ||
        round.operation === 'close' && (!round.taskClosed || round.events.length || round.changedFiles.length || round.reusedFiles.length) ||
        round.events.filter(event => ['BUNDLE_END', 'ERROR', 'STOP_HOT_COMPILE'].includes(event)).length > 1 ||
        round.reusedFiles.length > 0 && !round.events.includes('BUNDLE_END')) {
      result.invalid = true; result.missing.push('watch-round-lifecycle-invalid');
    }
    previous.push(round); sessions.set(round.sessionId, previous);
  }
  for (const rounds of sessions.values()) {
    if (rounds.at(-1)?.operation !== 'close') {
      result.invalid = true; result.missing.push('watch-session-not-closed');
    }
  }
}
async function observedFiles(record: z.infer<typeof observationSchema>, roots: { project: string; sdk: string }, result: CompilerObservation) {
  const nameOf = (scope: 'project' | 'sdk', file: string) => {
    const name = safePath(roots[scope], file);
    return scope === 'project' ? name : `sdk/${name}`;
  };
  for (const file of record.files) {
    const name = nameOf(file.scope, file.path);
    result.files.push({ ...file, path: name });
    if (file.role === 'generated-runtime-read') { continue; }
    try {
      const current = await evidenceFile(roots[file.scope], file.path, 8 * 1024 * 1024);
      if (file.role === 'compiler-cache-read') {
        result.cacheTransitions.push({ path: name, readSha256: file.sha256, afterSha256: current.sha256, binding: 'cache-unverified' });
      } else if (current.sha256 !== file.sha256 || current.size !== file.size) { result.drift.push(name); }
    } catch { result.invalid = true; result.missing.push('observed-compiler-input-unreadable'); }
  }
  await observedProbes(record, roots, result, nameOf);
  for (const read of record.textReads) {
    const name = nameOf(read.scope, read.path);
    if (read.binding !== (filesystemTextMethods.includes(read.method) ? 'decoded-filesystem-text' : 'host-text-only')) {
      result.invalid = true; result.missing.push('host-text-representation-mismatch');
    }
    if (read.readObserved && !record.files.some((file) => file.scope === read.scope && file.path === read.path)) {
      result.invalid = true; result.missing.push('host-text-read-binding-unavailable');
    }
    result.textReads.push({ ...read, path: name });
    if (!read.readObserved) { result.missing.push(filesystemTextMethods.includes(read.method) ?
      'decoded-filesystem-read-without-raw-bytes' : 'host-text-without-observed-read'); }
  }
  for (const resolution of record.resolutions) {
    result.resolutions.push({ containingFile: nameOf(resolution.containingScope, resolution.containingFile),
      resolvedFile: nameOf(resolution.resolvedScope, resolution.resolvedFile) });
  }
  for (const host of record.hosts) {
    try {
      const name = nameOf('sdk', host.path);
      const previous = result.hosts.find((item) => item.path === name) ?? result.files.find((item) => item.path === name);
      const file = previous?.sha256 ? previous : await evidenceFile(roots.sdk, host.path, 32 * 1024 * 1024);
      result.hosts.push({ kind: host.kind, path: name, sha256: file.sha256 });
    } catch { result.invalid = true; result.missing.push('observed-compiler-host-unreadable'); }
  }
  for (const file of record.drift) { result.drift.push(nameOf(file.startsWith(`${roots.sdk}${sep}`) ? 'sdk' : 'project', file)); }
  if (record.missing.some((item) => !['host-text-without-observed-read', 'decoded-filesystem-read-without-raw-bytes'].includes(item))) { result.invalid = true; }
  result.missing.push(...record.missing);
}
async function observedProbes(record: z.infer<typeof observationSchema>, roots: { project: string; sdk: string },
  result: CompilerObservation, nameOf: (scope: 'project' | 'sdk', file: string) => string) {
  for (const probe of record.probes) {
    const name = nameOf(probe.scope, probe.path);
    try {
      await lstat(probe.path);
      if (!probe.exists) {
        const cachePath = record.configuration.cachePath;
        const cacheInfo = typeof cachePath === 'string' && compilerCacheInfoFiles
          .some((suffix) => probe.path === resolve(cachePath, '..', suffix));
        if (cacheInfo) {
          const file = await evidenceFile(roots[probe.scope], probe.path, 8 * 1024 * 1024);
          result.cacheTransitions.push({ path: name, readSha256: null, afterSha256: file.sha256, binding: 'cache-unverified' });
        } else { result.drift.push(name); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (probe.exists) { result.drift.push(name); } }
      else { result.invalid = true; result.missing.push('observed-compiler-probe-unreadable'); }
    }
  }
}
