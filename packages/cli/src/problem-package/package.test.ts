/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { readProblemZip, storedProblemZip } from './zip.js';

async function implementation() {
  expect(existsSync(new URL('./index.ts', import.meta.url)), 'offline problem package implementation is missing').toBe(true);
  return import('./index.js');
}
async function example() {
  const api = await implementation();
  const input = { debugSessionId: randomUUID(), streamId: randomUUID(), identity,
    events: [event(1), event(2, { channel: 'ui', capability: 'ui.read',
      payload: { windowId: 'window', nodeCount: 3, summary: 'private UI text' } })] };
  return { api, input, result: api.buildProblemPackage(input) };
}
function changed(bytes: Buffer, name: string, mutate: (value: unknown) => unknown): Buffer {
  const zip = new AdmZip(bytes), entry = zip.getEntry(name)!;
  zip.updateFile(name, Buffer.from(JSON.stringify(mutate(JSON.parse(entry.getData().toString())))));
  return zip.toBuffer();
}

it('exports standalone schemas and redacted public summaries without handshake material', async () => {
  const { api, input, result } = await example();
  const checked = api.verifyProblemPackage(result.bytes);
  expect(checked.compatibility).toBe('compatible');
  expect(checked.session).toMatchObject({ source: { debugSessionId: input.debugSessionId, streamId: input.streamId },
    buildVerification: 'unverified', deviceProvenance: 'peer-asserted', authentication: 'not-restored' });
  expect(checked.events).toHaveLength(2);
  const text = JSON.stringify(checked);
  expect(text).not.toContain('private UI text');
  expect(text).not.toContain(identity.fingerprint);
  expect(text).not.toContain('pairing-proof');
  expect(checked.events![1].payload).toMatchObject({ summary: '[MEMORY_ONLY]' });
  expect(checked.manifest.files.map((file) => file.path)).toContain('schemas/event.schema.json');
  expect(checked.session!.coverage.find((item) => item.channel === 'arkweb.dom')).toMatchObject({ count: 0, status: 'not-captured' });
});

it('rejects a valid CRC archive with a changed event hash', async () => {
  const { api, result } = await example();
  const zip = new AdmZip(result.bytes);
  zip.updateFile('events.jsonl', Buffer.from('{"sequence":9}\n'));
  expect(() => api.verifyProblemPackage(zip.toBuffer())).toThrow(/HASH|SIZE/);
});

it('rejects event identity changes even after the manifest hash is recomputed', async () => {
  const { api, result } = await example();
  const zip = new AdmZip(result.bytes), name = 'events.jsonl';
  const events = zip.getEntry(name)!.getData().toString().trim().split('\n').map((line) => JSON.parse(line));
  events[0].buildId = 'another-build';
  const bytes = Buffer.from(events.map((item) => JSON.stringify(item)).join('\n') + '\n');
  zip.updateFile(name, bytes);
  const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString());
  Object.assign(manifest.files.find((item: { path: string }) => item.path === name),
    { size: bytes.length, sha256: api.problemHash(bytes), compression: 'deflate' });
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  expect(() => api.verifyProblemPackage(zip.toBuffer())).toThrow(/IDENTITY/);
});

it('accepts same-major minor versions and limits other majors to a safe manifest', async () => {
  const { api, result } = await example();
  const minor = changed(result.bytes, 'manifest.json', (value) => ({ ...(value as object), schemaVersion: '1.9' }));
  expect(api.verifyProblemPackage(minor).events).toHaveLength(2);
  const major = changed(result.bytes, 'manifest.json', (value) => ({ ...(value as object), schemaVersion: '2.0' }));
  const checked = api.verifyProblemPackage(major);
  expect(checked).toMatchObject({ compatibility: 'manifest-only', payloadIntegrity: 'not-checked' });
  expect(checked.events).toBeUndefined();
  expect(checked.session).toBeUndefined();
});

it('checks embedded schemas against the canonical source, never executes them', async () => {
  const { api, result } = await example();
  const zip = new AdmZip(result.bytes), bytes = Buffer.from('{"$ref":"https://invalid.test/schema"}');
  zip.updateFile('schemas/event.schema.json', bytes);
  const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString());
  Object.assign(manifest.files.find((item: { path: string }) => item.path === 'schemas/event.schema.json'),
    { size: bytes.length, sha256: api.problemHash(bytes), compression: 'deflate' });
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  expect(() => api.verifyProblemPackage(zip.toBuffer())).toThrow(/SCHEMA/);
});

it('rejects source sequence gaps and source identity drift before export', async () => {
  const { api, input } = await example();
  expect(() => api.buildProblemPackage({ ...input, events: [event(2)] })).toThrow(/SEQUENCE/);
  expect(() => api.buildProblemPackage({ ...input, events: [event(1, { device: 'other' })] })).toThrow(/IDENTITY/);
});

async function edited(change: (files: Map<string, Buffer>, manifest: Record<string, unknown>) => void) {
  const { api, result } = await example();
  const files = new Map([...readProblemZip(result.bytes)].map(([name, file]) => [name, file.read()]));
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  change(files, manifest);
  for (const file of manifest.files) {
    const bytes = files.get(file.path)!;
    Object.assign(file, { size: bytes.length, sha256: api.problemHash(bytes) });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return { api, bytes: storedProblemZip(files) };
}

it.each([
  ['events.jsonl', 'type', 'json'],
  ['session.json', 'sensitivity', 'public-schema'],
  ['schemas/event.schema.json', 'sensitivity', 'redacted-summary'],
])('rejects false %s %s declarations after all hashes match', async (path, field, value) => {
  const { api, bytes } = await edited((_files, manifest) => {
    const file = (manifest.files as Array<Record<string, unknown>>).find((file) => file.path === path)!;
    file[field] = value;
  });
  expect(() => api.verifyProblemPackage(bytes)).toThrow('PROBLEM_FILE_ROLE');
});

it('rejects a forged aggregate redaction count after all hashes match', async () => {
  const { api, bytes } = await edited((files) => {
    const session = JSON.parse(files.get('session.json')!.toString());
    session.redaction.fieldsRemoved++;
    files.set('session.json', Buffer.from(JSON.stringify(session)));
  });
  expect(() => api.verifyProblemPackage(bytes)).toThrow('PROBLEM_REDACTION_INVALID');
});

it('reads a session from a newer minor while the independent realtime domain schema stays pinned', async () => {
  const { api, bytes } = await edited((files, manifest) => {
    manifest.schemaVersion = '1.9';
    const session = JSON.parse(files.get('session.json')!.toString());
    session.schemaVersion = '1.9';
    files.set('session.json', Buffer.from(JSON.stringify(session)));
  });
  expect(api.verifyProblemPackage(bytes).session!.schemaVersion).toBe('1.9');
});

it('reads additive minor fields using the canonical known profile and reports omitted fields', async () => {
  const { api, bytes } = await edited((files, manifest) => {
    manifest.schemaVersion = '1.9'; manifest.futureNote = 'PRIVATE_FUTURE_NOTE';
    const schema = JSON.parse(files.get('schemas/session.schema.json')!.toString());
    schema.properties.futureNote = { type: 'string' };
    schema.required.push('futureNote');
    files.set('schemas/session.schema.json', Buffer.from(JSON.stringify(schema)));
    const session = JSON.parse(files.get('session.json')!.toString());
    session.schemaVersion = '1.9'; session.futureNote = 'PRIVATE_FUTURE_NOTE';
    files.set('session.json', Buffer.from(JSON.stringify(session)));
  });
  const checked = api.verifyProblemPackage(bytes);
  expect(checked).toMatchObject({ compatibility: 'compatible', fieldCoverage: 'known-fields-only', ignoredFields: 2 });
  expect(checked.events).toHaveLength(2);
  expect(JSON.stringify(checked)).not.toContain('PRIVATE_FUTURE_NOTE');
});

it.each(['constraint', 'remote-ref', 'required-optional'])('rejects a breaking minor schema change: %s', async (change) => {
  const { api, bytes } = await edited((files, manifest) => {
    manifest.schemaVersion = '1.9';
    const schema = JSON.parse(files.get('schemas/event.schema.json')!.toString());
    const network = schema.anyOf.find((item: { properties: { channel: { const: string } } }) =>
      item.properties.channel.const === 'app.network').properties.payload;
    if (change === 'constraint') { network.properties.durationMs.maximum = 1; }
    if (change === 'remote-ref') { network.$ref = 'https://invalid.test/schema'; }
    if (change === 'required-optional') { network.required.push('status'); }
    files.set('schemas/event.schema.json', Buffer.from(JSON.stringify(schema)));
  });
  expect(() => api.verifyProblemPackage(bytes)).toThrow('PROBLEM_SCHEMA_MISMATCH');
});
