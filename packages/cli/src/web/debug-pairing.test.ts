/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionContext, createRuntime, type ExecutionContext } from '../runtime/index.js';
import { TaskManager } from '../tasks/task-manager.js';
import { readWebService, writeWebService } from './web-state.js';
import { PairingInvitationSchema } from '../debug-protocol/security.js';

let root: string, context: ExecutionContext;
const target = { buildId: 'unverified-fixture', device: 'fixture-device', process: 'fixture-process', sessionId: 'fixture-session' };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-private-pair-'));
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data'), nonInteractive: false });
});
afterEach(async () => {
  await (await createRuntime()).execute('debug.stop', {}, context);
  await rm(root, { recursive: true, force: true });
});
async function contents(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? contents(join(path, entry.name)) : readFile(join(path, entry.name), 'utf8')))).join('');
}

it('requires a private terminal sink before creating an invitation and stays out of tasks', async () => {
  const runtime = await createRuntime();
  const result = await runtime.execute('debug.pair', target, context);
  expect(result.exitCode).toBe(5);
  expect(result.data).toEqual({ code: 'PRIVATE_TTY_REQUIRED' });
  expect(await readWebService(context.dataDir)).toBeNull();
  await expect(new TaskManager(runtime, context).submit('debug.pair', target)).rejects.toThrow();
});

it('delivers an invitation privately while public receipts and saved records contain no code', async () => {
  const runtime = await createRuntime();
  expect((await runtime.execute('debug.start', {}, context)).exitCode).toBe(0);
  let privateText = '';
  const result = await runtime.execute('debug.pair', target, { ...context, privatePairing: async (text: string) => { privateText = text; } } as ExecutionContext);
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(privateText);
  const invite = PairingInvitationSchema.parse(envelope.invitation);
  expect(envelope.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/bridge\/v1$/);
  expect(invite.handshake.identity.project).toBe(context.workspaceId);
  expect(result.data).toMatchObject({ state: 'pairing', buildVerification: 'unverified', deviceProvenance: 'peer-asserted' });
  expect(JSON.stringify(result)).not.toContain(invite.oneTimeCode);
  expect(await contents(context.dataDir)).not.toContain(invite.oneTimeCode);
});

it('rejects startup scope and code drift before invoking the private sink', async () => {
  const runtime = await createRuntime();
  expect((await runtime.execute('debug.start', {}, context)).exitCode).toBe(0);
  let writes = 0;
  const pairedContext = { ...context, privatePairing: async () => { writes++; } } as ExecutionContext;
  const other = await mkdtemp(join(root, 'other-'));
  expect((await runtime.execute('debug.pair', target, { ...pairedContext, cwd: other })).data).toMatchObject({ code: 'WORKBENCH_SCOPE_CHANGED' });
  const record = (await readWebService(context.dataDir))!;
  await writeWebService(context.dataDir, { ...record, workbenchFingerprint: 'a'.repeat(64) });
  expect((await runtime.execute('debug.pair', target, pairedContext)).data).toMatchObject({ code: 'WORKBENCH_CODE_CHANGED' });
  expect(writes).toBe(0);
});

it('revokes an invitation after private output failure without leaking the sink error', async () => {
  const runtime = await createRuntime();
  expect((await runtime.execute('debug.start', {}, context)).exitCode).toBe(0);
  const result = await runtime.execute('debug.pair', target, { ...context, privatePairing: async (text: string) => { throw new Error(text); } } as ExecutionContext);
  expect(result.exitCode).toBe(6);
  expect(result.data).toEqual({ code: 'PRIVATE_OUTPUT_FAILED', revoked: true });
  expect(JSON.stringify(result)).not.toMatch(/oneTimeCode|publicKey/);
  expect((await runtime.execute('debug.status', {}, context)).data).toMatchObject({ debugSession: { bridge: { state: 'revoked' } } });
});

it('serves a development-only invitation only after an explicit startup flag', async () => {
  const runtime = await createRuntime();
  expect((await runtime.execute('debug.start', {}, context)).exitCode).toBe(0);
  let record = (await readWebService(context.dataDir))!;
  const query = new URLSearchParams(target).toString();
  expect((await fetch(`${record.origin}/dev-invitation?${query}`)).status).toBe(404);
  await runtime.execute('debug.stop', {}, context);
  const started = await runtime.execute('debug.start', { devAutoPair: true }, context);
  expect(started.exitCode).toBe(0);
  expect(started.data).toMatchObject({ devAutoPair: true });
  record = (await readWebService(context.dataDir))!;
  const response = await fetch(`${record.origin}/dev-invitation?${query}`);
  expect(response.status).toBe(200);
  const envelope = await response.json() as { endpoint: string; invitation: unknown };
  expect(envelope.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/bridge\/v1$/);
  const invite = PairingInvitationSchema.parse(envelope.invitation);
  expect(invite.handshake.identity).toMatchObject({ ...target, project: context.workspaceId });
  expect((await fetch(`${record.origin}/dev-invitation?buildId=a&buildId=b&device=c&process=d&sessionId=e`)).status).toBe(400);
});

it('guards the local pairing route independently of browser authentication', async () => {
  const runtime = await createRuntime();
  const started = await runtime.execute('debug.start', {}, context);
  expect(started.exitCode).toBe(0);
  const record = (await readWebService(context.dataDir))!;
  const input = { cwd: record.cwd, projectRoot: record.projectRoot, fingerprint: record.workbenchFingerprint,
    target: { ...target, project: context.workspaceId } };
  const post = (headers: Record<string, string>, value = input) => fetch(`${record.origin}/_ohmate/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  expect((await post({})).status).toBe(403);
  expect((await post({ 'x-ohmate-control': record.controlSecret, origin: record.origin })).status).toBe(403);
  expect((await post({ 'x-ohmate-control': record.controlSecret }, { ...input, fingerprint: 'b'.repeat(64) })).status).toBe(409);
  expect((await post({ 'x-ohmate-control': record.controlSecret })).status).toBe(200);
});
