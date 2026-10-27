/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime, type Receipt } from '../runtime/index.js';
import { TaskManager } from '../tasks/task-manager.js';

let root: string;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-patch-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return { context, runtime: await createRuntime(), input: { changes: [
    { path: 'src/main.ts', oldHash: hash('export const value = 1;\n'), text: 'export const value = 2;\n' },
    { path: 'src/created.ts', oldHash: null, text: 'export const created = true;\n' },
  ] } };
}
function approval(result: Receipt) { return (result.data as { planId: string }).planId; }

it('previews exact file diffs and applies a single human-approved multi-file patch', async () => {
  const { context, runtime, input } = await fixture();
  const manager = new TaskManager(runtime, context);
  const task = await manager.submit('workspace.patch', input, true);
  expect(task.state).toBe('awaiting-approval');
  expect(task.plan).toMatchObject({ risk: 'R2', review: { files: [
    { path: 'src/main.ts', oldHash: input.changes[0].oldHash, newHash: hash(input.changes[0].text!), operation: 'replace' },
    { path: 'src/created.ts', oldHash: null, operation: 'create' },
  ] } });
  expect(JSON.stringify(task.plan)).toContain('-export const value = 1;');
  expect(JSON.stringify(task.plan)).toContain('+export const value = 2;');
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toContain('value = 1');
  await expect(readFile(join(root, 'src', 'created.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  const applied = await manager.approve(task.id, task.plan!.planId, true);
  expect(applied.state).toBe('succeeded');
  expect(applied.receipt?.data).toMatchObject({ code: 'PATCH_APPLIED', phase: 'applied' });
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe(input.changes[0].text);
  expect(await readFile(join(root, 'src', 'created.ts'), 'utf8')).toBe(input.changes[1].text);
  expect(applied.receipt?.artifacts[0]).toMatchObject({ kind: 'patch-journal', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect((await runtime.execute('workspace.patch', input, { ...context, policy: { ...context.policy, approvedPlan: task.plan!.planId } })).exitCode).not.toBe(0);
});

it('invalidates an approval if old content changes without touching any other file', async () => {
  const { context, runtime, input } = await fixture();
  const planned = await runtime.execute('workspace.patch', input, context);
  expect(planned.exitCode).toBe(5);
  await writeFile(join(root, 'src', 'main.ts'), 'Changed outside OHMate.\n');
  const result = await runtime.execute('workspace.patch', input, { ...context, policy: { ...context.policy, approvedPlan: approval(planned) } });
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('Changed outside OHMate.\n');
  await expect(readFile(join(root, 'src', 'created.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['../outside.ts', '/tmp/outside.ts', 'src/../outside.ts', 'src\\main.ts', '.env', 'node_modules/a.ts', '.git/config', 'private/a.ts'])(
  'rejects a patch target outside its public lexical scope: %s', async (path) => {
    const { context, runtime } = await fixture();
    const result = await runtime.execute('workspace.patch', { changes: [{ path, oldHash: null, text: 'Public text.\n' }] }, context);
    expect(result.exitCode).toBe(4);
    expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toContain('value = 1');
  },
);

it('rejects symlink ancestors, hardlinks, binary content, secrets and duplicate targets before a plan', async () => {
  const { context, runtime, input } = await fixture();
  await symlink(join(root, 'src'), join(root, 'linked'));
  await link(join(root, 'src', 'main.ts'), join(root, 'src', 'hard.ts'));
  await writeFile(join(root, 'src', 'binary.ts'), Buffer.from([0, 1, 2]));
  const cases = [
    { path: 'linked/new.ts', oldHash: null, text: 'Public\n' },
    { path: 'src/hard.ts', oldHash: input.changes[0].oldHash, text: 'Public\n' },
    { path: 'src/binary.ts', oldHash: hash('\0\u0001\u0002'), text: 'Public\n' },
    { path: 'src/secret.ts', oldHash: null, text: 'const token = "EXAMPLE_SECRET";\n' },
  ];
  for (const change of cases) { expect((await runtime.execute('workspace.patch', { changes: [change] }, context)).exitCode).toBe(4); }
  expect((await runtime.execute('workspace.patch', { changes: [input.changes[1], input.changes[1]] }, context)).exitCode).toBe(4);
  await expect(readdir(join(context.dataDir, 'plans'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rolls back earlier writes on a later conflict and preserves the concurrent writer', async () => {
  const { context, runtime, input } = await fixture();
  const planned = await runtime.execute('workspace.patch', input, context);
  expect(planned.exitCode).toBe(5);
  const result = await runtime.execute('workspace.patch', input, {
    ...context, policy: { ...context.policy, approvedPlan: approval(planned) },
    eventSink: async (event) => {
      if (event.type === 'patch.file.applied' && (event.payload as { path: string }).path === 'src/main.ts') {
        await writeFile(join(root, 'src', 'created.ts'), 'Concurrent writer.\n');
      }
    },
  });
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ code: 'PATCH_ROLLED_BACK', phase: 'rolled-back' });
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect(await readFile(join(root, 'src', 'created.ts'), 'utf8')).toBe('Concurrent writer.\n');
  expect((await readdir(join(root, 'src'))).some((name) => name.endsWith('.tmp'))).toBe(false);
});

it('rolls back on cancellation after an applied file and leaves recovery evidence', async () => {
  const { context, runtime, input } = await fixture(), controller = new AbortController();
  const planned = await runtime.execute('workspace.patch', input, context);
  expect(planned.exitCode).toBe(5);
  const result = await runtime.execute('workspace.patch', input, {
    ...context, abortSignal: controller.signal, policy: { ...context.policy, approvedPlan: approval(planned) },
    eventSink: (event) => { if (event.type === 'patch.file.applied') { controller.abort(); } },
  });
  expect(result.exitCode).toBe(130);
  expect(result.data).toMatchObject({ phase: 'rolled-back' });
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('export const value = 1;\n');
  await expect(readFile(join(root, 'src', 'created.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires a reviewed restore, restores deleted files and refuses to overwrite subsequent edits', async () => {
  const { context, runtime } = await fixture();
  const input = { changes: [{ path: 'src/main.ts', oldHash: hash('export const value = 1;\n'), text: null }] };
  const planned = await runtime.execute('workspace.patch', input, context);
  expect(planned.exitCode).toBe(5);
  const applied = await runtime.execute('workspace.patch', input, { ...context, policy: { ...context.policy, approvedPlan: approval(planned) } });
  expect(applied.exitCode).toBe(0);
  const artifact = applied.artifacts![0];
  expect(hash(await readFile(artifact.path, 'utf8'))).toBe(artifact.sha256);
  const journalId = (applied.data as { journalId: string }).journalId;
  const restorePlan = await runtime.execute('workspace.recovery.restore', { journalId }, context);
  expect(restorePlan.exitCode).toBe(5);
  const restored = await runtime.execute('workspace.recovery.restore', { journalId }, { ...context, policy: { ...context.policy, approvedPlan: approval(restorePlan) } });
  expect(restored.exitCode).toBe(0);
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect(hash(await readFile(artifact.path, 'utf8'))).toBe(artifact.sha256);
  await writeFile(join(root, 'src', 'main.ts'), 'New independent edit.\n');
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, context)).exitCode).toBe(4);
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('New independent edit.\n');
});

it('settles an invalid task with a receipt rather than leaving planning state stranded', async () => {
  const { context, runtime, input } = await fixture();
  input.changes[0].oldHash = hash('Different content');
  const manager = new TaskManager(runtime, context);
  const task = await manager.submit('workspace.patch', input, true);
  expect(task.state).toBe('failed');
  expect(task.receipt).toMatchObject({ exitCode: 4, data: { code: 'INPUT_INVALID' } });
  expect(task.processes).toHaveLength(0);
});

it('keeps a recovery-required journal if a concurrent writer changes an already applied file', async () => {
  const { context, runtime, input } = await fixture();
  const planned = await runtime.execute('workspace.patch', input, context);
  const result = await runtime.execute('workspace.patch', input, {
    ...context, policy: { ...context.policy, approvedPlan: approval(planned) },
    eventSink: async (event) => {
      if (event.type === 'patch.file.applied') {
        await writeFile(join(root, 'src', 'main.ts'), 'Independent edit.\n'); throw new Error('Interrupted');
      }
    },
  });
  expect(result.data).toMatchObject({ code: 'PATCH_RECOVERY_REQUIRED', phase: 'recovery-required', failures: ['src/main.ts'] });
  const journalId = (result.data as { journalId: string }).journalId;
  expect((await runtime.execute('workspace.recovery.inspect', { journalId }, context)).data).toMatchObject({
    files: [{ path: 'src/main.ts', state: 'conflict' }, { path: 'src/created.ts', state: 'original' }],
  });
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, context)).exitCode).toBe(4);
  expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('Independent edit.\n');
});

it('uses observed hashes to recover a partly restored patch and rejects tampered review content', async () => {
  const { context, runtime, input } = await fixture();
  const planned = await runtime.execute('workspace.patch', input, context);
  const file = join(context.dataDir, 'plans', `${approval(planned)}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.review.files[0].diff = 'Forged diff';
  await writeFile(file, JSON.stringify(record));
  expect((await runtime.execute('workspace.patch', input, { ...context, policy: { ...context.policy, approvedPlan: approval(planned) } })).exitCode).toBe(5);
  const fresh = await runtime.execute('workspace.patch', input, context);
  const applied = await runtime.execute('workspace.patch', input, { ...context, policy: { ...context.policy, approvedPlan: approval(fresh) } });
  await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  const journalId = (applied.data as { journalId: string }).journalId;
  const restore = await runtime.execute('workspace.recovery.restore', { journalId }, context);
  expect(restore.data).toMatchObject({ review: { files: [{ path: 'src/created.ts', operation: 'delete' }] } });
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, { ...context, policy: { ...context.policy, approvedPlan: approval(restore) } })).exitCode).toBe(0);
  await expect(readFile(join(root, 'src', 'created.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});
