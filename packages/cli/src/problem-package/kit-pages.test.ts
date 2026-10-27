/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { buildProblemPackage, problemHash, verifyProblemPackage } from './package.js';
import { readProblemZip, storedProblemZip } from './zip.js';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { agentSpecs, agentTools } from '../agent/agent-tools.js';
import { startWebServer } from '../web/web-server.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { createHandshake, createReadonlyBridge } from '../debug-protocol/index.js';
import { EventJournal } from '../debug/event-journal.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const source = { id: 'fixture-adapter', kind: 'registered-adapter', provenance: 'peer-reported' };
function summary(index: number, text = 'redacted') {
  const { fingerprint: _fingerprint, ...value } = event(index, {
    channel: 'hilog', capability: 'hilog.read', payload: { level: 'info', summary: text },
  });
  void _fingerprint;
  return value;
}
function input(count = 3, text = 'redacted') {
  const records = Array.from({ length: count }, (_, index) => summary(index + 1, text));
  const node = (nodeId: string) => ({ clock: { clockId: 'clock', bootId: 'boot',
    wallTimeUtc: '2026-10-23T00:00:00Z', monotonicNs: '1', offsetUncertaintyMs: 5 },
    payload: { targetId: 'target', nodeId, parentId: null, role: 'button', childCount: 0 } });
  return { debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)],
    kit: { files: [
      { path: 'dfx-events.jsonl', source, status: 'summary-only', dropped: 2, sampled: true, records },
      { path: 'web-dom/a.json', source, status: 'captured', dropped: 0, sampled: false, records: [node('a'), node('b')] },
      { path: 'web-dom/b.json', source, status: 'captured', dropped: 0, sampled: false, records: [node('c')] },
    ], attachments: [{ path: 'faultlog/fault.txt', source, status: 'captured', dropped: 0, sampled: false,
      review: 'explicit-export', bytes: Buffer.from('TEST_ATTACHMENT_DO_NOT_RETURN') }] } };
}
async function fixture(value = input()) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-kit-page-')); roots.push(root);
  const path = join(root, 'sample.ohmate-problem.zip');
  await writeFile(path, buildProblemPackage(value).bytes, { mode: 0o600 });
  return { path, runtime: await createRuntime(), context: await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }) };
}
function rewrite(bytes: Buffer, change: (files: Map<string, Buffer>, manifest: Record<string, unknown>) => void) {
  const files = new Map([...readProblemZip(bytes)].map(([path, file]) => [path, file.read()]));
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  change(files, manifest);
  for (const file of manifest.files) {
    const bytes = files.get(file.path)!; Object.assign(file, { size: bytes.length, sha256: problemHash(bytes) });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return storedProblemZip(files);
}

it('pages verified Kit summaries without returning unrelated records or changing the old event cursor', async () => {
  const { path, runtime, context } = await fixture();
  const first = await runtime.execute('replay.show', { path, domain: 'dfx', after: 0, limit: 2 }, context);
  expect(first).toMatchObject({ exitCode: 0, data: { kitPage: {
    domain: 'dfx', count: 3, nextCursor: 2, hasMore: true,
    records: [1, 2].map((index) => ({ index, path: 'dfx-events.jsonl', representation: 'domain-summary',
      record: { messageId: `fixture-message-${index}`, channel: 'hilog' } })),
  }, authentication: 'not-restored', replay: 'not-performed' } });
  expect(first.data).not.toHaveProperty('events');
  const last = await runtime.execute('replay.show', { path, domain: 'dfx', after: 2, limit: 2 }, context);
  expect(last).toMatchObject({ exitCode: 0, data: { kitPage: { nextCursor: 3, hasMore: false, records: [{ index: 3 }] } } });
  const old = await runtime.execute('replay.show', { path, after: 0, limit: 1 }, context);
  expect(old).toMatchObject({ exitCode: 0, data: { nextCursor: 1, events: [{ sequence: 1 }] } });
  expect(old.data).not.toHaveProperty('kitPage');
});

it('uses one ordinal across structural files and resets the ordinal for an explicitly selected file', async () => {
  const { path, runtime, context } = await fixture();
  const page = await runtime.execute('replay.show', { path, domain: 'web-dom', after: 1, limit: 2 }, context);
  expect(page).toMatchObject({ exitCode: 0, data: { kitPage: { count: 3, nextCursor: 3, hasMore: false,
    records: [{ index: 2, path: 'web-dom/a.json', record: { payload: { nodeId: 'b' } } },
      { index: 3, path: 'web-dom/b.json', record: { payload: { nodeId: 'c' } } }] } } });
  const selected = await runtime.execute('replay.show', { path, domain: 'web-dom', file: 'web-dom/b.json', after: 0, limit: 1 }, context);
  expect(selected).toMatchObject({ exitCode: 0, data: { kitPage: { file: 'web-dom/b.json', count: 1,
    records: [{ index: 1, representation: 'structural-metadata' }] } } });
});

it('keeps retained event gaps independent of a Kit domain ordinal', async () => {
  const { path, runtime, context } = await fixture();
  await mkdir(context.dataDir, { recursive: true, mode: 0o700 });
  const handshake = createHandshake(identity), bridge = createReadonlyBridge(handshake);
  bridge.connect(handshake, 'epoch-1');
  const journal = await EventJournal.create(context.dataDir, randomUUID(), handshake,
    { maxEvents: 2, segmented: true, retention: 'rolling-v1', resume: { peer: handshake, epoch: 'epoch-1' } });
  for (const from of [1, 3]) { await journal.appendBatch([from, from + 1].map((sequence) => bridge.accept(event(sequence)))); }
  const saved = await EventJournal.read(context.dataDir, journal.sessionId, journal.streamId, { retainedHistory: true });
  expect(saved.history).toMatchObject({ from: 3, gap: { missingFrom: 1, missingThrough: 2 } });
  const value = input();
  await writeFile(path, buildProblemPackage({ ...value, debugSessionId: journal.sessionId, streamId: journal.streamId,
    events: saved.events.map((record) => record.event), clocks: saved.events.map((record) => record.clock),
    history: saved.history, through: 4 }).bytes);
  const receipt = await runtime.execute('replay.show', { path, domain: 'dfx', after: 2, limit: 1 }, context);
  expect(receipt).toMatchObject({ exitCode: 0, data: {
    gap: { missingFrom: 1, missingThrough: 2, reason: 'retention-quota' },
    kitPage: { nextCursor: 3, hasMore: false },
  } });
});

it('returns an empty metadata-only page for reviewed attachments and an explicit absent-domain page', async () => {
  const { path, runtime, context } = await fixture();
  const attachment = await runtime.execute('replay.show', { path, domain: 'faultlog', file: 'faultlog/fault.txt' }, context);
  expect(attachment).toMatchObject({ exitCode: 0, data: { kitPage: { domain: 'faultlog', count: 0,
    records: [], nextCursor: 0, hasMore: false }, kit: { attachmentPolicy: 'user-reviewed' } } });
  expect(JSON.stringify(attachment)).not.toContain('TEST_ATTACHMENT_DO_NOT_RETURN');
  const absent = await runtime.execute('replay.show', { path, domain: 'memory' }, context);
  expect(absent).toMatchObject({ exitCode: 0, data: { kitPage: { count: 0, records: [] },
    kit: { domains: expect.arrayContaining([{ domain: 'memory', status: 'not-captured', count: 0, reason: 'not-captured' }]) } } });
});

it.each([
  { domain: 'unknown' }, { domain: 'dfx', after: 4 }, { domain: 'web-dom', file: 'web-dom/missing.json' },
  { domain: 'dfx', file: 'web-dom/a.json' }, { file: 'dfx-events.jsonl' }, { domain: 'dfx', limit: 257 },
  { domain: 'dfx', after: -1 }, { domain: 'dfx', file: '../private.json' },
])('rejects invalid Kit selections %j', async (selection) => {
  const { path, runtime, context } = await fixture();
  expect((await runtime.execute('replay.show', { path, ...selection }, context)).exitCode).toBe(4);
});

it('limits encoded record pages to 48 KiB and makes contiguous progress to the end', async () => {
  const { path, runtime, context } = await fixture(input(100, '界'.repeat(1024)));
  let cursor = 0; const seen: number[] = [];
  do {
    const receipt = await runtime.execute('replay.show', { path, domain: 'dfx', after: cursor, limit: 256 }, context);
    expect(receipt.exitCode).toBe(0);
    const page = (receipt.data as { kitPage: { records: Array<{ index: number }>; nextCursor: number; hasMore: boolean } }).kitPage;
    expect(Buffer.byteLength(JSON.stringify(page.records))).toBeLessThanOrEqual(48 * 1024);
    expect(page.nextCursor).toBeGreaterThan(cursor);
    expect(page.records.length).toBeLessThan(100);
    seen.push(...page.records.map((record) => record.index)); cursor = page.nextCursor;
    if (!page.hasMore) { break; }
  } while (cursor < 100);
  expect(seen).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
});

it('exports and verifies genuine nonempty Kit JSONL above the old 4 MiB construction budget', () => {
  const result = buildProblemPackage(input(4096, '界'.repeat(1024)));
  expect(result.manifest.files.find((file) => file.path === 'dfx-events.jsonl')!.size).toBeGreaterThan(4 * 1024 ** 2);
  expect(verifyProblemPackage(result.bytes).kit!.files[0].count).toBe(4096);
});

it.each(['bad-tail', 'wrong-identity', 'unselected-role', 'hash'])('validates the entire package before returning a page: %s', async (kind) => {
  const { path, runtime, context } = await fixture();
  const bytes = rewrite(buildProblemPackage(input()).bytes, (files) => {
    if (kind === 'unselected-role') {
      const profile = JSON.parse(files.get('profile.json')!.toString()); profile.files[2].representation = 'attachment';
      files.set('profile.json', Buffer.from(JSON.stringify(profile)));
    } else {
      const values = files.get('dfx-events.jsonl')!.toString().trimEnd().split('\n').map((line) => JSON.parse(line));
      if (kind === 'bad-tail') { values[2].payload.level = 'invalid'; }
      if (kind === 'wrong-identity') { values[2].buildId = 'other-build'; }
      files.set('dfx-events.jsonl', Buffer.from(values.map((value) => JSON.stringify(value) + '\n').join('')));
    }
  });
  // A hash failure must remain unhashed by the fixture rewriter.
  const corrupted = kind === 'hash' ? (() => {
    const files = new Map([...readProblemZip(bytes)].map(([name, file]) => [name, file.read()]));
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    manifest.files.find((file: { path: string }) => file.path === 'dfx-events.jsonl').sha256 = '0'.repeat(64);
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest))); return storedProblemZip(files);
  })() : bytes;
  await writeFile(path, corrupted);
  const receipt = await runtime.execute('replay.show', { path, domain: 'web-dom', after: 0, limit: 1 }, context);
  expect(receipt).toMatchObject({ exitCode: 4, data: { code: 'REQUEST_INVALID' } });
  if (kind !== 'bad-tail') {
    expect(receipt.data).toMatchObject({ message: { 'wrong-identity': 'PROBLEM_IDENTITY_MISMATCH',
      'unselected-role': 'PROBLEM_FILE_ROLE', hash: 'PROBLEM_HASH_MISMATCH' }[kind] });
  }
  expect(receipt.data).not.toHaveProperty('kitPage');
});

it('strips additive fields before returning a Kit page', async () => {
  const { path, runtime, context } = await fixture();
  const bytes = rewrite(buildProblemPackage(input()).bytes, (files, manifest) => {
    manifest.schemaVersion = '1.9';
    const values = JSON.parse(files.get('web-dom/a.json')!.toString()); values[0].future = 'TEST_DO_NOT_EXPOSE';
    files.set('web-dom/a.json', Buffer.from(JSON.stringify(values)));
  });
  await writeFile(path, bytes);
  const receipt = await runtime.execute('replay.show', { path, domain: 'web-dom' }, context);
  expect(receipt).toMatchObject({ exitCode: 0, data: { ignoredFields: 1, kitPage: { count: 3 } } });
  expect(JSON.stringify(receipt)).not.toContain('TEST_DO_NOT_EXPOSE');
});

it('rejects a Kit selection on a legacy summary package and cancellation before a read', async () => {
  const { path, runtime, context } = await fixture();
  const { kit: _kit, ...value } = input(); void _kit;
  await writeFile(path, buildProblemPackage(value).bytes);
  expect(await runtime.execute('replay.show', { path, domain: 'dfx' }, context))
    .toMatchObject({ exitCode: 4, data: { message: 'PROBLEM_KIT_PROFILE_REQUIRED' } });
  expect(await runtime.execute('replay.show', { path, domain: 'dfx' }, { ...context, abortSignal: AbortSignal.abort('test-stop') }))
    .toMatchObject({ exitCode: 130 });
});

it('shares the schema and exact Kit page between Registry, Agent and authenticated HTTP', async () => {
  const { path, runtime, context } = await fixture();
  const selection = { path, domain: 'web-dom', file: 'web-dom/b.json', after: 0, limit: 1 };
  const spec = runtime.registry.get('replay.show')!;
  expect(spec.options.map((option) => option.flags)).toEqual(expect.arrayContaining(['--domain <value>', '--file <value>']));
  const direct = await runtime.execute('replay.show', selection, context);
  expect(direct.exitCode).toBe(0);
  const state = { pending: [], receipts: [] };
  const tools = agentTools(runtime, agentSpecs(runtime, ['replay.show']), context, [], state);
  const agent = await tools[0].execute('test-page', selection);
  expect(JSON.parse((agent.content[0] as { text: string }).text).data).toEqual(direct.data);
  expect(agent.terminate).toBe(false);
  const server = await startWebServer(runtime, context);
  try {
    const connection = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
    const cookie = connection.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
    const response = await fetch(`${server.origin}/api/v1/tasks`, { method: 'POST',
      headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
      body: JSON.stringify({ toolId: 'replay.show', input: selection, wait: true }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.receipt.data).toEqual(direct.data);
  } finally { await server.close(); }
});
