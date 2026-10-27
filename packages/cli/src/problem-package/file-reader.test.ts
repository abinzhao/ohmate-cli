/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { buildProblemPackage } from './package.js';
import { storedProblemZip } from './zip.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function target() {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-problem-reader-')); roots.push(root);
  return { path: join(root, 'sample.ohmate-problem.zip'), context: await createExecutionContext({ cwd: root, dataDir: join(root, 'data') }),
    runtime: await createRuntime() };
}

it('checks another major manifest without allocating or reading its 96 MiB payload', async () => {
  const { path, context, runtime } = await target();
  const size = 96 * 1024 ** 2;
  const manifest = { format: 'ohmate-problem', schemaVersion: '2.0', problemId: 'future', sessionId: 'session',
    content: 'domain-summaries', integrity: 'sha256-not-signature',
    files: [{ path: 'events.jsonl', type: 'jsonl', sensitivity: 'redacted-summary', compression: 'store', size, sha256: '0'.repeat(64) }] };
  const bytes = storedProblemZip(new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['events.jsonl', Buffer.alloc(0)]]));
  const end = bytes.length - 22, centralStart = bytes.readUInt32LE(end + 16);
  const central = centralStart + 46 + Buffer.byteLength('manifest.json'), local = bytes.readUInt32LE(central + 42);
  for (const [at, delta] of [[central, 20], [central, 24], [local, 18], [local, 22]]) {
    bytes.writeUInt32LE(size, at + delta);
  }
  bytes.writeUInt32LE(centralStart + size, end + 16);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.write(bytes.subarray(0, centralStart), 0, centralStart, 0);
    await handle.write(bytes.subarray(centralStart), 0, bytes.length - centralStart, centralStart + size);
  } finally { await handle.close(); }
  const allocate = Buffer.alloc;
  vi.spyOn(Buffer, 'alloc').mockImplementation((length, ...args) => {
    if (length > 4 * 1024 ** 2) { throw new Error('TEST_WHOLE_ARCHIVE_ALLOCATION'); }
    return allocate(length, ...args);
  });
  const receipt = await runtime.execute('replay.verify', { path }, context);
  expect(receipt).toMatchObject({ exitCode: 3, data: { compatibility: 'manifest-only', payloadIntegrity: 'not-checked' } });
});

it('checks a normal offline file through the same public verifier', async () => {
  const { path, context, runtime } = await target();
  const result = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)] });
  await writeFile(path, result.bytes, { mode: 0o600 });
  expect(await runtime.execute('replay.show', { path, after: 0, limit: 1 }, context))
    .toMatchObject({ exitCode: 0, data: { count: 1, nextCursor: 1, valid: true } });
});

it('returns a safe manifest from show for another major without exposing payload pages', async () => {
  const { path, context, runtime } = await target();
  const result = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)] });
  const zip = new AdmZip(result.bytes), manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString());
  manifest.schemaVersion = '2.0';
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  await writeFile(path, zip.toBuffer(), { mode: 0o600 });
  const receipt = await runtime.execute('replay.show', { path, after: 0, limit: 1 }, context);
  expect(receipt).toMatchObject({ exitCode: 3, data: { compatibility: 'manifest-only', payloadIntegrity: 'not-checked' } });
  expect((receipt.data as Record<string, unknown>).events).toBeUndefined();
});
