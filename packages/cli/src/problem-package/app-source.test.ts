/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { buildProblemPackage, problemHash, verifyProblemPackage } from './package.js';
import { readProblemZip, storedProblemZip } from './zip.js';
import { ProblemSessionSchema, problemSchemas } from './schemas.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';

function appPackage(events: unknown[] = [], kit = true, extra: Record<string, unknown> = {},
  kind: 'app-memory-summary' | 'app-readonly-summary' = 'app-memory-summary') {
  const { fingerprint: _fingerprint, ...sample } = event(7, {
    channel: 'hidebug', capability: 'hidebug.read', payload: { metric: 'pssBytes', value: 4096 },
  });
  void _fingerprint;
  const built = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events,
    ...(kit ? { kit: { files: [{ path: 'memory-clues.jsonl', records: [sample],
      source: { id: 'process-pss', kind: 'platform-api', api: 'hidebug.getPss', provenance: 'peer-reported' },
      status: 'summary-only', dropped: 6, sampled: true }] } } : {}) });
  const files = new Map([...readProblemZip(built.bytes)].map(([name, entry]) => [name, entry.read()]));
  const session = { ...built.session, source: { kind }, ...extra };
  files.set('session.json', Buffer.from(JSON.stringify(session)));
  if (kit) {
    const schema = problemSchemas(false, false, false, true, kind === 'app-memory-summary' ? true : kind)
      .get('schemas/session.schema.json');
    files.set('schemas/session.schema.json', Buffer.from(JSON.stringify(schema)));
  }
  const manifest = { ...built.manifest, files: built.manifest.files.map((file) => ({
    ...file, size: files.get(file.path)!.length, sha256: problemHash(files.get(file.path)!),
  })) };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return { bytes: storedProblemZip(files), session };
}

test('application memory source has no fictitious desktop stream or durable events', () => {
  const { bytes, session } = appPackage();
  expect(ProblemSessionSchema.parse(session).source).toEqual({ kind: 'app-memory-summary' });
  const result = verifyProblemPackage(bytes);
  expect(result.payloadIntegrity).toBe('verified');
  expect(result.session!.through).toBe(0);
  expect(result.kit!.files[0].dropped).toBe(6);
  expect(result.events).toEqual([]);
});
test('desktop source still requires both real-shaped IDs; sources reject additive claims', () => {
  const { session } = appPackage();
  for (const source of [
    { kind: 'desktop-durable-summary' },
    { kind: 'app-memory-summary', streamId: randomUUID() },
    { kind: 'app-memory-summary', authenticated: true },
  ]) { expect(() => ProblemSessionSchema.parse({ ...session, source })).toThrow(); }
});
test('application source cannot relabel a desktop durable event journal', () => {
  expect(() => verifyProblemPackage(appPackage([event(1)]).bytes)).toThrow('PROBLEM_APP_SOURCE_INVALID');
});
test('application source is restricted to explicit Kit content', () => {
  expect(() => verifyProblemPackage(appPackage([], false).bytes)).toThrow('PROBLEM_APP_SOURCE_INVALID');
});
test('application snapshot refuses journal history and calibration claims', () => {
  const { session } = appPackage();
  for (const extra of [{ clockEvidence: [] }, { clockEvidenceLocation: 'events.jsonl' }]) {
    expect(() => ProblemSessionSchema.parse({ ...session, ...extra })).toThrow();
  }
});
test.each([
  { source: { kind: 'app-memory-summary', streamId: randomUUID() } },
  { source: { kind: 'app-memory-summary', authenticated: true } },
  { clockEvidence: [] },
  { clockEvidenceLocation: 'events.jsonl' },
  { history: {} },
  { through: 7 },
  { schemaVersion: '1.3' },
])('archive verification rejects raw application claims before minor field projection: %j', (extra) => {
  expect(() => verifyProblemPackage(appPackage([], true, extra).bytes)).toThrow();
});
test('existing Kit 1.4 schemas retain the desktop-only source layout for archive compatibility', () => {
  const schema = problemSchemas(false, false, false, true).get('schemas/session.schema.json') as {
    properties: { source: { properties: { kind: { const: string } } } };
  };
  expect(schema.properties.source.properties.kind.const).toBe('desktop-durable-summary');
  const built = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [],
    kit: { files: [] } });
  expect(verifyProblemPackage(built.bytes).payloadIntegrity).toBe('verified');
});
test('readonly application source preserves current Kit verification without restoring stream or authentication', () => {
  const result = verifyProblemPackage(appPackage([], true, {}, 'app-readonly-summary').bytes);
  expect(result.payloadIntegrity).toBe('verified');
  expect(result.session!.source).toEqual({ kind: 'app-readonly-summary' });
  expect(result.session!.through).toBe(0);
  expect(result.session!.authentication).toBe('not-restored');
});
test.each([
  { source: { kind: 'app-readonly-summary', streamId: randomUUID() } },
  { source: { kind: 'app-readonly-summary', authenticated: true } },
  { clockEvidence: [] }, { clockEvidenceLocation: 'events.jsonl' }, { history: {} }, { through: 7 },
  { schemaVersion: '1.3' },
])('readonly archive rejects raw forbidden source claims: %j', (extra) => {
  expect(() => verifyProblemPackage(appPackage([], true, extra, 'app-readonly-summary').bytes)).toThrow();
});
test('readonly application source also refuses event journals and non-Kit content', () => {
  expect(() => verifyProblemPackage(appPackage([event(1)], true, {}, 'app-readonly-summary').bytes)).toThrow();
  expect(() => verifyProblemPackage(appPackage([], false, {}, 'app-readonly-summary').bytes)).toThrow();
});
