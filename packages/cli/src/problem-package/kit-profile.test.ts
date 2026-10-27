/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { buildProblemPackage, problemHash, verifyProblemPackage } from './package.js';
import { readProblemZip, storedProblemZip } from './zip.js';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const clock = { clockId: 'fixture-clock', bootId: 'fixture-boot', wallTimeUtc: '2026-10-23T00:00:00Z',
  monotonicNs: '1', offsetUncertaintyMs: 5 };
const source = { id: 'fixture-adapter', kind: 'registered-adapter', provenance: 'peer-reported' };
const record = (payload: unknown) => ({ clock, payload });
function domainEvent(channel: string, payload: unknown) {
  const { fingerprint: _fingerprint, ...value } = event(1, { channel, capability: `${channel}.read`, payload });
  void _fingerprint;
  return value;
}
export function kitInput() {
  const summaries: Record<string, unknown[]> = {
    'arkweb.jsonl': [domainEvent('arkweb.storage', { targetId: 'target', entryCount: 1, summary: '[MEMORY_ONLY]' })],
    'web-console.jsonl': [domainEvent('arkweb.console', { level: 'warn', summary: '[MEMORY_ONLY]' })],
    'network-summary.jsonl': [domainEvent('app.network', { requestId: 'request', method: 'GET', durationMs: 12 })],
    'instrumentation.jsonl': [domainEvent('instrumentation', { eventName: 'open', summary: 'redacted' })],
    'dfx-events.jsonl': [domainEvent('hitrace', { traceId: 'trace', spanId: 'span', durationMs: 2 })],
    'memory-clues.jsonl': [domainEvent('hidebug', { metric: 'pssBytes', value: 8192 })],
  };
  const details: Record<string, unknown[]> = {
    'environment.json': [record({ apiLevel: 26, sdkVersion: '26.0.0', deviceType: 'phone', capabilities: ['hidebug.read'] })],
    'actions.jsonl': [record({ actionId: 'action', kind: 'tap', targetId: 'target', outcome: 'completed' })],
    'navigation.jsonl': [record({ actionId: 'action', from: 'home', to: 'details', operation: 'push' })],
    'web-targets.json': [record({ targetId: 'target', origin: 'https://example.test', debugEnabled: true, state: 'active' })],
    'web-dom/target.json': [record({ targetId: 'target', nodeId: 'node', parentId: null, role: 'button', childCount: 0 })],
    'network-captures/request.json': [record({ requestId: 'request', method: 'GET', durationMs: 12,
      bodyMetadata: { captured: false, byteLength: 17 } })],
    'mock-rules.json': [record({ ruleId: 'rule', enabled: false, hits: 0, expiresAt: '2026-10-23T00:05:00Z' })],
    'ui-tree.json': [record({ windowId: 'window', nodeId: 'node', parentId: null, role: 'button', childCount: 0 })],
    'error-clues.json': [record({ clueId: 'clue', category: 'api', code: '801', api: 'hidebug.getPss', eventIds: ['fixture-message-1'] })],
    'local-diagnosis.json': [record({ candidateId: 'candidate', ruleId: 'api-capability', confidence: 0.5, clueIds: ['clue'] })],
  };
  return { debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)],
    kit: { files: [
      ...Object.entries(summaries).map(([path, records]) => ({ path, records, source, status: 'summary-only', dropped: 0, sampled: false })),
      ...Object.entries(details).map(([path, records]) => ({ path, records, source, status: 'captured', dropped: 0, sampled: false })),
    ] } };
}
function rewrite(bytes: Buffer, change: (files: Map<string, Buffer>, manifest: Record<string, unknown>) => void) {
  const files = new Map([...readProblemZip(bytes)].map(([path, file]) => [path, file.read()]));
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  change(files, manifest);
  for (const file of manifest.files) {
    const value = files.get(file.path)!;
    Object.assign(file, { size: value.length, sha256: problemHash(value) });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return storedProblemZip(files);
}
function resultData(value: ReturnType<typeof verifyProblemPackage>) { return { ...value, kit: value.kit! }; }

it('accepts nonempty inputs for every structured Kit domain and exposes actual files and missing attachments', () => {
  const input = kitInput(), result = buildProblemPackage(input);
  expect(result.manifest.content).toBe('kit-readonly');
  expect(result.manifest.schemaVersion).toBe('1.4');
  const verified = resultData(verifyProblemPackage(result.bytes));
  expect(verified.payloadIntegrity).toBe('verified');
  expect(verified.kit.files).toHaveLength(16);
  expect(verified.kit.domains).toHaveLength(18);
  expect(verified.kit.domains.filter((item: { status: string }) => item.status === 'not-captured')
    .map((item: { domain: string }) => item.domain)).toEqual(['faultlog', 'snapshots']);
  expect(verified.kit.files.find((item: { path: string }) => item.path === 'environment.json'))
    .toMatchObject({ count: 1, source, status: 'captured' });
  expect(verified.kit.provenance).toBe('peer-reported');
  expect(verified.session).toMatchObject({ authentication: 'not-restored', buildVerification: 'unverified',
    deviceProvenance: 'peer-asserted' });
});

it('records all absent domains without synthesizing empty capture files', () => {
  const input = kitInput();
  input.kit.files = input.kit.files.filter((file) => file.path === 'memory-clues.jsonl');
  const result = buildProblemPackage(input), verified = resultData(verifyProblemPackage(result.bytes));
  expect(verified.kit.files).toHaveLength(1);
  expect(verified.kit.domains.filter((item: { status: string }) => item.status === 'not-captured')).toHaveLength(17);
  expect(result.manifest.files.some((file) => file.path === 'ui-tree.json')).toBe(false);
  expect(JSON.stringify(verified.kit)).not.toContain('reference-only');
});

it('preserves the known legacy UI schema that predates optional geometry fields', () => {
  const result = buildProblemPackage(kitInput());
  const bytes = rewrite(result.bytes, (files) => {
    const schema = JSON.parse(files.get('schemas/kit-ui.schema.json')!.toString());
    delete schema.items.properties.payload.properties.bounds;
    delete schema.items.properties.payload.properties.visible;
    files.set('schemas/kit-ui.schema.json', Buffer.from(JSON.stringify(schema)));
  });
  const verified = verifyProblemPackage(bytes);
  expect(verified.kit!.files.find((file) => file.path === 'ui-tree.json')!.count).toBe(1);
  expect(verified.session!.buildVerification).toBe('unverified');
});
it('preserves optional UI geometry through validated public domain pages', async () => {
  const input = kitInput();
  const bounds = { x: -3, y: 7, width: 120, height: 40, unit: 'vp', origin: 'window' };
  input.kit.files.find((file) => file.path === 'ui-tree.json')!.records =
    [record({ windowId: 'window', nodeId: 'node', parentId: null, role: 'Column', childCount: 0, bounds, visible: false })];
  const result = buildProblemPackage(input);
  const { verifyProblemArchive } = await import('./package.js');
  const { readProblemZipAt } = await import('./zip.js');
  const signal = new AbortController().signal;
  const zip = await readProblemZipAt(result.bytes.length,
    async (offset, length) => result.bytes.subarray(offset, offset + length), signal);
  const verified = await verifyProblemArchive(zip, signal, { domain: 'ui', after: 0, limit: 1 });
  expect(verified.kitPage!.records[0].record).toMatchObject({ payload: { bounds, visible: false } });
});
it.each([
  { x: Infinity }, { width: -1 }, { unit: 'px' }, { origin: 'screen' }, { token: 'private' },
])('rejects invalid optional UI bounds %j', (mutation) => {
  const input = kitInput();
  const bounds = { x: 0, y: 0, width: 1, height: 1, unit: 'vp', origin: 'window', ...mutation };
  input.kit.files.find((file) => file.path === 'ui-tree.json')!.records =
    [record({ windowId: 'window', nodeId: 'node', parentId: null, role: 'Column', childCount: 0, bounds })];
  expect(() => buildProblemPackage(input)).toThrow();
});
it('rejects a legacy-shaped UI schema whose coordinate constraints were weakened', () => {
  const result = buildProblemPackage(kitInput());
  const bytes = rewrite(result.bytes, (files) => {
    const schema = JSON.parse(files.get('schemas/kit-ui.schema.json')!.toString());
    delete schema.items.properties.payload.properties.bounds;
    delete schema.items.properties.payload.properties.visible;
    schema.items.properties.payload.properties.childCount.minimum = -1;
    files.set('schemas/kit-ui.schema.json', Buffer.from(JSON.stringify(schema)));
  });
  expect(() => verifyProblemPackage(bytes)).toThrow('PROBLEM_SCHEMA_MISMATCH');
});

it.each(['empty', 'unknown-field', 'wrong-channel', 'wrong-identity', 'private-text', 'reference-source', 'duplicate'])(
  'rejects invalid structured Kit input: %s', (change) => {
    const input = kitInput();
    const file = input.kit.files.find((item) => item.path === 'memory-clues.jsonl')!;
    if (change === 'empty') { file.records = []; }
    if (change === 'unknown-field') { file.records = [record({ token: 'UNSAFE_TEST_ONLY' })]; }
    if (change === 'wrong-channel') { file.records = [domainEvent('hilog', { level: 'info', summary: 'redacted' })]; }
    if (change === 'wrong-identity') { file.records = [{ ...file.records[0] as object, buildId: 'other' }]; }
    if (change === 'private-text') {
      input.kit.files.find((item) => item.path === 'web-console.jsonl')!.records =
        [domainEvent('arkweb.console', { level: 'info', summary: 'PRIVATE_UI_TEXT' })];
    }
    if (change === 'reference-source') { file.source = { ...source, kind: 'sdk-reference' }; }
    if (change === 'duplicate') { input.kit.files.push(file); }
    expect(() => buildProblemPackage(input)).toThrow();
  });

it.each(['count', 'source', 'identity', 'schema', 'missing-domain', 'extra-data', 'empty-data'])(
  'rejects rehashed Kit input with forged %s', (change) => {
    const result = buildProblemPackage(kitInput());
    expect(result.manifest.content).toBe('kit-readonly');
    const bytes = rewrite(result.bytes, (files, manifest) => {
      const profile = JSON.parse(files.get('profile.json')!.toString());
      if (change === 'count') { profile.files[0].count++; }
      if (change === 'source') { profile.files[0].source.kind = 'sdk-reference'; }
      if (change === 'identity') { profile.identity.buildId = 'other'; }
      if (change === 'missing-domain') { profile.domains.pop(); }
      if (change === 'empty-data') { files.set('memory-clues.jsonl', Buffer.alloc(0)); }
      if (change === 'schema') {
        files.set('schemas/kit-memory.schema.json', Buffer.from('{"$ref":"https://invalid.test/schema"}'));
      }
      if (change === 'extra-data') {
        const data = Buffer.from('[]'); files.set('unlisted.json', data);
        (manifest.files as Array<Record<string, unknown>>).push({ path: 'unlisted.json', size: data.length, sha256: problemHash(data),
          type: 'json', sensitivity: 'redacted-summary', compression: 'store' });
      }
      files.set('profile.json', Buffer.from(JSON.stringify(profile)));
    });
    expect(() => verifyProblemPackage(bytes)).toThrow();
  });

it('preserves the original 1.0 summary profile when Kit inputs are absent', () => {
  const { kit: _kit, ...input } = kitInput(); void _kit;
  const result = buildProblemPackage(input), verified = resultData(verifyProblemPackage(result.bytes));
  expect(result.manifest.content).toBe('domain-summaries');
  expect(result.manifest.schemaVersion).toBe('1.0');
  expect(result.manifest.files).toHaveLength(5);
  expect(verified.kit).toBeUndefined();
});

it('returns the same source and missing-domain inventory through the public replay entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-kit-profile-')); roots.push(root);
  const path = join(root, 'sample.ohmate-problem.zip');
  const result = buildProblemPackage(kitInput()); await writeFile(path, result.bytes, { mode: 0o600 });
  const runtime = await createRuntime(), context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const receipt = await runtime.execute('replay.show', { path, after: 0, limit: 1 }, context);
  expect(receipt).toMatchObject({ exitCode: 0, data: { valid: true, count: 1, kit: {
    profile: 'kit-readonly-v1', provenance: 'peer-reported', files: expect.any(Array), domains: expect.any(Array),
  }, authentication: 'not-restored', replay: 'not-performed' } });
});

it.each([
  ['faultlog/fault.json', 'faultlog', { faultId: 'fault', kind: 'jscrash', summary: 'redacted fault' }],
  ['snapshots/heap.json', 'jsleak', { snapshotId: 'heap', suspectedCount: 1, summary: 'redacted snapshot' }],
])('uses realtime redacted summaries for %s', (path, channel, payload) => {
  const input = kitInput();
  input.kit.files.push({ path, records: [domainEvent(channel, payload)], source, status: 'summary-only', dropped: 0, sampled: false });
  expect(verifyProblemPackage(buildProblemPackage(input).bytes).kit!.files.find((file) => file.path === path))
    .toMatchObject({ count: 1, representation: 'domain-summary', status: 'summary-only' });
});

it.each([
  ['faultlog/fault.json', { faultId: 'fault', kind: 'jscrash', summary: 'cookie=TEST_SECRET_ONLY' }],
  ['snapshots/heap.json', { snapshotId: 'heap', suspectedCount: 1, summary: 'cookie=TEST_SECRET_ONLY' }],
])('rejects unsanitized structural summary bypass in %s', (path, payload) => {
  const input = kitInput();
  input.kit.files.push({ path, records: [record(payload)], source, status: 'captured', dropped: 0, sampled: false });
  expect(() => buildProblemPackage(input)).toThrow();
});

it('rejects platform-source assertions that do not name a collecting API', () => {
  const input = kitInput();
  input.kit.files[0].source = { ...source, kind: 'platform-api' };
  expect(() => buildProblemPackage(input)).toThrow();
});

it('reads additive Kit minor fields and reports omitted data', () => {
  const result = buildProblemPackage(kitInput());
  const bytes = rewrite(result.bytes, (files, manifest) => {
    manifest.schemaVersion = '1.9';
    const schema = JSON.parse(files.get('schemas/kit-environment.schema.json')!.toString());
    schema.items.properties.future = { type: 'string' };
    files.set('schemas/kit-environment.schema.json', Buffer.from(JSON.stringify(schema)));
    const values = JSON.parse(files.get('environment.json')!.toString()); values[0].future = 'TEST_HIDDEN_FIELD';
    files.set('environment.json', Buffer.from(JSON.stringify(values)));
  });
  const verified = verifyProblemPackage(bytes);
  expect(verified).toMatchObject({ compatibility: 'compatible', fieldCoverage: 'known-fields-only', ignoredFields: 1 });
  expect(JSON.stringify(verified)).not.toContain('TEST_HIDDEN_FIELD');
});
