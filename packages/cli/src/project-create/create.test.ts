/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSON5 from 'json5';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ToolProvider } from '../toolchain/index.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-create-'));
  vi.spyOn(ToolProvider, 'new').mockRejectedValue(new Error('Fixture without Studio'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'private') });
  return { context, runtime: await createRuntime(), input: { appName: 'AcceptanceApp', apiLevel: '22', deviceTypes: ['phone', 'tablet'] } };
}

it('exposes only observed SDK API metadata for template defaults', async () => {
  const sdk = join(root, ...process.platform === 'darwin' ? ['Contents'] : [], 'sdk/default');
  await mkdir(sdk, { recursive: true });
  const provider = ToolProvider.fromIDE(root);
  expect(provider).toHaveProperty('getAvailableApiLevel');
  expect(provider.getAvailableApiLevel()).toBeUndefined();
  await writeFile(join(sdk, 'sdk-pkg.json'), '{"data":{"apiVersion":26}}');
  expect(provider.getAvailableApiLevel()).toBe(26);
});

it('previews the actual bundled template and creates only the approved target with project evidence', async () => {
  const { context, runtime, input } = await fixture();
  const planned = await runtime.execute('deveco.create', input, context);
  expect(planned.exitCode).toBe(5);
  const plan = planned.data as { planId: string; review: { files: { path: string; diff?: string }[] } };
  expect(plan.review.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'entry/src/main/ets/pages/Index.ets', diff: expect.stringContaining('@Entry') }),
    expect.objectContaining({ path: 'AGENTS.md', operation: 'create', oldHash: null, newHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
  ]));
  await expect(readdir(join(root, input.appName))).rejects.toMatchObject({ code: 'ENOENT' });
  const created = await runtime.execute('deveco.create', input, { ...context, policy: { ...context.policy, approvedPlan: plan.planId } });
  expect(created.exitCode).toBe(0);
  expect(created.data).toMatchObject({ code: 'PROJECT_CREATED', verification: { doctor: 'passed', project: 'passed', build: 'not-run', test: 'not-run' } });
  const profile = JSON5.parse(await readFile(join(root, input.appName, 'build-profile.json5'), 'utf8'));
  expect(profile.modules).toEqual([expect.objectContaining({ name: 'entry', srcPath: './entry' })]);
  const config = JSON5.parse(await readFile(join(root, input.appName, 'entry/src/main/module.json5'), 'utf8'));
  expect(config.module.deviceTypes).toEqual(input.deviceTypes);
  expect(await readFile(join(root, input.appName, 'AGENTS.md'), 'utf8')).toContain('6.0.2(22)');
  expect(created.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'project-create-manifest' })]));
  expect((await runtime.execute('deveco.create', input, { ...context, policy: { ...context.policy, approvedPlan: plan.planId } })).exitCode).not.toBe(0);
});

it('rejects unsupported API mappings, unknown SDK defaults and unsafe names before an approval', async () => {
  const { context, runtime, input } = await fixture();
  for (const change of [{ apiLevel: '25' }, { apiLevel: undefined }, { appName: '../Outside' }, { projectPath: '../outside' }]) {
    expect((await runtime.execute('deveco.create', { ...input, ...change }, context)).exitCode).toBe(4);
  }
  expect((await readdir(root)).filter((name) => name !== 'private')).toEqual([]);
});

it('accepts an explicitly chosen empty target and rejects nonempty targets and symlink parents', async () => {
  const { context, runtime, input } = await fixture();
  await mkdir(join(root, 'Empty'));
  const target = { ...input, projectPath: 'Empty' };
  const planned = await runtime.execute('deveco.create', target, context);
  expect(planned.exitCode).toBe(5);
  expect((await runtime.execute('deveco.create', target, { ...context, policy: { ...context.policy, approvedPlan: (planned.data as { planId: string }).planId } })).exitCode).toBe(0);
  expect((await runtime.execute('deveco.create', target, context)).exitCode).toBe(4);
  await symlink(join(root, 'Empty'), join(root, 'Linked'));
  expect((await runtime.execute('deveco.create', { ...input, projectPath: 'Linked/New' }, context)).exitCode).toBe(4);
});

it('cleans only its own staging and preserves a target changed by another writer before commit', async () => {
  const { context, runtime, input } = await fixture();
  const planned = await runtime.execute('deveco.create', input, context);
  expect(planned.exitCode).toBe(5);
  const result = await runtime.execute('deveco.create', input, {
    ...context, policy: { ...context.policy, approvedPlan: (planned.data as { planId: string }).planId },
    eventSink: async (event) => {
      if (event.type === 'project.create.prepared') {
        await mkdir(join(root, input.appName));
        await writeFile(join(root, input.appName, 'owned.txt'), 'Other writer');
      }
    },
  });
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(join(root, input.appName, 'owned.txt'), 'utf8')).toBe('Other writer');
  expect((await readdir(root)).some((name) => name.startsWith('.ohmate-create-'))).toBe(false);
});
