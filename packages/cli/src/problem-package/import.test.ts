/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildProblemPackage } from './package.js';
import { readProblemZip, storedProblemZip } from './zip.js';
import { isProblemPackageTool } from './tool-ids.js';
import { event, identity } from '../debug-protocol/test-fixtures.js';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { TaskManager } from '../tasks/task-manager.js';
import { agentSpecs, agentTools } from '../agent/agent-tools.js';
import { startWebServer } from '../web/web-server.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-problem-import-')); roots.push(root);
  const path = join(root, 'sample.ohmate-problem.zip'), dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const bytes = buildProblemPackage({ debugSessionId: randomUUID(), streamId: randomUUID(), identity, events: [event(1)] }).bytes;
  await writeFile(path, bytes, { mode: 0o600 });
  return { root, path, bytes, context: await createExecutionContext({ cwd: root, dataDir }), runtime: await createRuntime() };
}

it('opens a validated absolute read-only reference without copying files or restoring authentication', async () => {
  const { root, path, bytes, context, runtime } = await fixture();
  const before = await readdir(root), dataBefore = await readdir(context.dataDir);
  const receipt = await runtime.execute('replay.import', { path: 'sample.ohmate-problem.zip' }, context);
  expect(receipt).toMatchObject({ exitCode: 0, command: 'replay.import', artifacts: [], data: {
    path, importStatus: 'opened', access: 'read-only', valid: true, payloadIntegrity: 'verified', count: 1,
    authentication: 'not-restored', buildVerification: 'unverified', deviceProvenance: 'peer-asserted',
    clockCalibration: 'not-verified', replay: 'not-performed',
  } });
  expect(receipt.data).not.toHaveProperty('events');
  expect(receipt.data).not.toHaveProperty('clockEvidence');
  expect(receipt.data).not.toHaveProperty('session.clockEvidence');
  expect(await readFile(path)).toEqual(bytes);
  expect(await readdir(root)).toEqual(before);
  expect(await readdir(context.dataDir)).toEqual(dataBefore);
  const again = await runtime.execute('replay.import', { path }, context);
  expect(again.data).toEqual(receipt.data);
  const shown = await runtime.execute('replay.show', { path, after: 0, limit: 1 }, context);
  expect(shown).toMatchObject({ exitCode: 0, data: { events: [{ sequence: 1 }], nextCursor: 1 } });
});

it('revalidates file bytes after import before opening or showing the same path again', async () => {
  const { path, bytes, context, runtime } = await fixture();
  expect((await runtime.execute('replay.import', { path }, context)).exitCode).toBe(0);
  const entries = new Map([...readProblemZip(bytes)].map(([name, file]) => [name, file.read()]));
  entries.set('events.jsonl', Buffer.from(entries.get('events.jsonl')!.toString().replace('fixture-message-1', 'fixture-message-2')));
  await writeFile(path, storedProblemZip(entries));
  for (const tool of ['replay.import', 'replay.show']) {
    const receipt = await runtime.execute(tool, { path }, context);
    expect(receipt).toMatchObject({ exitCode: 4, data: { message: 'PROBLEM_HASH_MISMATCH' } });
    expect(receipt.data).not.toHaveProperty('importStatus');
    expect(receipt.data).not.toHaveProperty('events');
  }
});

it('preserves manifest-only degradation for another major without opening unchecked payload', async () => {
  const { path, bytes, context, runtime } = await fixture();
  const entries = new Map([...readProblemZip(bytes)].map(([name, file]) => [name, file.read()]));
  const manifest = JSON.parse(entries.get('manifest.json')!.toString()); manifest.schemaVersion = '2.0';
  entries.set('events.jsonl', Buffer.from('INERT_UNCHECKED_PAYLOAD'));
  manifest.files.find((file: { path: string }) => file.path === 'events.jsonl').size = entries.get('events.jsonl')!.length;
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  await writeFile(path, storedProblemZip(entries));
  const receipt = await runtime.execute('replay.import', { path }, context);
  expect(receipt).toMatchObject({ exitCode: 3, data: { path, importStatus: 'manifest-only', access: 'read-only',
    valid: false, compatibility: 'manifest-only', payloadIntegrity: 'not-checked', authentication: 'not-restored' } });
  expect(receipt.data).not.toHaveProperty('events');
  expect(JSON.stringify(receipt)).not.toContain('INERT_UNCHECKED_PAYLOAD');
});

it('rejects unsafe paths, corrupt archives, build mismatches, unexpected actions and cancellation', async () => {
  const { root, path, context, runtime } = await fixture();
  const linked = join(root, 'linked.ohmate-problem.zip'); await symlink(path, linked);
  for (const [input, message] of [
    [{ path: linked }, 'PROBLEM_FILE_UNSAFE'],
    [{ path, buildId: 'wrong-build' }, 'PROBLEM_IDENTITY_MISMATCH'],
  ] as const) {
    expect(await runtime.execute('replay.import', input, context)).toMatchObject({ exitCode: 4, data: { message } });
  }
  for (const input of [{ path: 'private.json' }, { path, execute: true }, { path, destination: root }]) {
    expect(await runtime.execute('replay.import', input, context)).toMatchObject({ exitCode: 4, data: { code: 'INPUT_SCHEMA_INVALID' } });
  }
  expect(await runtime.execute('replay.import', { path }, { ...context, abortSignal: AbortSignal.abort('test-stop') }))
    .toMatchObject({ exitCode: 130 });
  await writeFile(path, 'INERT_NOT_A_ZIP');
  const corrupt = await runtime.execute('replay.import', { path }, context);
  expect(corrupt.exitCode).toBe(4);
  expect(corrupt.data).not.toHaveProperty('path');
});

it('registers a cancellable R0 read and shares metadata through tasks, Agent and authenticated HTTP', async () => {
  const { path, context, runtime } = await fixture();
  expect(isProblemPackageTool('replay.import')).toBe(true);
  const spec = runtime.registry.get('replay.import');
  expect(spec).toMatchObject({ risk: 'R0', adapter: 'native', idempotency: 'read', recovery: 'verify-and-retry', cancellable: true });
  expect(spec!.options.map((option) => option.flags)).toEqual(['--path <value>', '--build-id <value>']);
  const direct = await runtime.execute('replay.import', { path }, context);
  expect(direct.exitCode).toBe(0);
  const task = await new TaskManager(runtime, context).submit('replay.import', { path }, true);
  expect(task.state).toBe('succeeded');
  expect(task.receipt!.data).toEqual(direct.data);
  const state = { pending: [], receipts: [] };
  const tools = agentTools(runtime, agentSpecs(runtime, ['replay.import']), context, [], state);
  expect(tools[0].replay).toBe('safe');
  const agent = await tools[0].execute('import-reference', { path });
  expect(JSON.parse((agent.content[0] as { text: string }).text).data).toEqual(direct.data);
  expect(agent.terminate).toBe(false);
  expect(state.pending).toEqual([]);
  const server = await startWebServer(runtime, context);
  try {
    const connection = await fetch(`${server.origin}/api/v1/connect`, { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: server.ticket() }) });
    const cookie = connection.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await (await fetch(`${server.origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
    const response = await fetch(`${server.origin}/api/v1/tasks`, { method: 'POST',
      headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-ohmate-csrf': csrf },
      body: JSON.stringify({ toolId: 'replay.import', input: { path }, wait: true }) });
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.state).toBe('succeeded');
    expect(result.receipt.data).toEqual(direct.data);
  } finally { await server.close(); }
});
