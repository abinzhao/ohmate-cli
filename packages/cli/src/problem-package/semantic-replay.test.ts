/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { buildProblemPackage } from './package.js';
import { identity, event } from '../debug-protocol/test-fixtures.js';
import { agentSpecs } from '../agent/agent-tools.js';

let root: string, archive: string, steps: string;
let runtime: Awaited<ReturnType<typeof createRuntime>>, context: Awaited<ReturnType<typeof createExecutionContext>>;
const step = { kind: 'action', actionId: 'test.marker', dataRef: 'test:marker',
  assertionId: 'test.marker-present', expected: 'test:present', waitMs: 1000 };
const script = () => ({ version: '1.0', buildId: identity.buildId, steps: [step] });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-semantic-plan-'));
  await mkdir(join(root, 'data'), { mode: 0o700 });
  context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  runtime = await createRuntime();
  archive = join(root, 'case.ohmate-problem.zip'); steps = join(root, 'case.ohmate-replay.json');
  const result = buildProblemPackage({ debugSessionId: 'a'.repeat(8) + '-1234-4234-8234-' + 'a'.repeat(12),
    streamId: 'b'.repeat(8) + '-1234-4234-8234-' + 'b'.repeat(12), identity, events: [event(1)] });
  await writeFile(archive, result.bytes, { mode: 0o600 });
  await writeFile(steps, JSON.stringify(script()), { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function plan(extra = {}) {
  expect(runtime.registry.get('replay.plan'), 'offline semantic planning must be registered').toBeDefined();
  return runtime.execute('replay.plan', { path: archive, steps, ...extra }, context);
}
it('binds archive and semantic bytes into a deterministic manual-only plan without effects', async () => {
  const before = await readdir(context.dataDir), first = await plan(), again = await plan();
  expect(first).toMatchObject({ exitCode: 0, data: { replay: 'not-performed', access: 'read-only',
    authentication: 'not-restored', buildVerification: 'unverified', execution: 'manual-only',
    archiveHash: createHash('sha256').update(await readFile(archive)).digest('hex'),
    scriptHash: expect.stringMatching(/^[a-f0-9]{64}$/), planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    steps: [{ index: 1, ...step, execution: 'manual', reason: 'adapter-and-local-build-required' }] } });
  expect(again.data).toEqual(first.data); expect(await readdir(context.dataDir)).toEqual(before);
  expect(first.artifacts).toEqual([]);
});
it('provides manual fallback when the archive contains no semantic actions', async () => {
  expect(runtime.registry.get('replay.plan')).toBeDefined();
  const result = await runtime.execute('replay.plan', { path: archive }, context);
  expect(result).toMatchObject({ exitCode: 0, data: { steps: [], execution: 'manual-only',
    reason: 'semantic-steps-required', replay: 'not-performed' } });
});
it('does not infer business actions from event text or summary metadata', async () => {
  const result = await plan();
  expect((result.data as { steps: unknown[] }).steps).toHaveLength(1);
  expect(agentSpecs(runtime, ['replay.plan'])[0].risk).toBe('R0');
});
it('requires exact archive build agreement and refuses mismatched script before output', async () => {
  await writeFile(steps, JSON.stringify({ ...script(), buildId: 'other-build' }));
  expect(await plan()).toMatchObject({ exitCode: 4, data: { message: 'REPLAY_BUILD_MISMATCH' } });
  expect(await plan({ buildId: 'other-build' })).toMatchObject({ exitCode: 4 });
});
it('keeps explicitly unverified builds manual despite matching build strings', async () => {
  const result = await plan();
  expect(result.data).toMatchObject({ execution: 'manual-only', buildVerification: 'unverified' });
});
it.each(['authorization', 'delete', 'payment', 'publish', 'upload', 'share', 'settings', 'coordinate', 'reflect'])(
  'refuses %s instead of coercing it into a replay operation', async (kind) => {
    await writeFile(steps, JSON.stringify({ ...script(), steps: [{ ...step, kind }] }));
    expect((await plan()).exitCode).toBe(4);
  });
it.each([
  { ...step, input: 'PRIVATE_RAW_INPUT' }, { ...step, dataRef: 'PRIVATE_RAW_INPUT' },
  { ...step, expected: 'PRIVATE_RAW_RESULT' }, { ...step, assertionId: '' },
  { ...step, waitMs: 3001 }, { ...step, waitMs: 0 }, { ...step, actionId: 'delete.real' },
])('rejects raw inputs, absent assertions and unbounded waits', async (invalid) => {
  await writeFile(steps, JSON.stringify({ ...script(), steps: [invalid] }));
  const result = await plan(); expect(result.exitCode).toBe(4);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_RAW');
});
it('bounds script count and UTF-8 bytes and refuses linked arbitrary input files', async () => {
  await writeFile(steps, JSON.stringify({ ...script(), steps: Array(65).fill(step) }));
  expect((await plan()).exitCode).toBe(4);
  await writeFile(steps, ' '.repeat(65537));
  expect((await plan()).exitCode).toBe(4);
  const link = join(root, 'linked.ohmate-replay.json'); await symlink(steps, link);
  expect((await plan({ steps: link })).exitCode).toBe(4);
  expect((await plan({ steps: 'credentials.json' })).exitCode).toBe(4);
});
it('retains ordered system interaction as a bounded manual step', async () => {
  await writeFile(steps, JSON.stringify({ ...script(), steps: [step, { kind: 'manual', reason: 'system-interaction' }] }));
  expect(await plan()).toMatchObject({ exitCode: 0, data: { steps: [
    { index: 1, execution: 'manual' }, { index: 2, kind: 'manual', reason: 'system-interaction', execution: 'manual' },
  ] } });
});
it('changes plan identity when source script bytes change and rejects archive corruption', async () => {
  const first = await plan(); await writeFile(steps, JSON.stringify(script(), null, 2));
  const next = await plan();
  expect((first.data as { planHash: string }).planHash).not.toBe((next.data as { planHash: string }).planHash);
  const bytes = await readFile(archive); bytes[100] ^= 1; await writeFile(archive, bytes);
  expect((await plan()).exitCode).toBe(4);
});
