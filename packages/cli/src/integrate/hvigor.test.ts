/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { pluginSource } from './hvigor-plugin.js';

let root: string;
const original = "\ufeff// retained header\r\nimport { appTasks } from '@ohos/hvigor-ohos-plugin';\r\nconst extra = { pluginId: 'extra', apply() {} };\r\nexport default {\r\n  system: appTasks, plugins: [extra /* retain this */],\r\n};\r\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-integration-'));
  await mkdir(join(root, 'entry/src/main'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), '{"modules":[{"name":"entry","srcPath":"./entry"}]}');
  await writeFile(join(root, 'entry/src/main/module.json5'), '{"module":{"name":"entry","type":"entry"}}');
  await writeFile(join(root, 'hvigorfile.ts'), original);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function setup() {
  return { runtime: await createRuntime(), context: await createExecutionContext({
    cwd: root, projectRoot: root, dataDir: join(root, 'private'),
  }) };
}

it('reviews a portable plugin and preserves existing plugins, comments, BOM and CRLF', async () => {
  const { runtime, context } = await setup();
  const plan = await runtime.execute('integrate.hvigor', {}, context);
  expect(plan.exitCode).toBe(5);
  const data = plan.data as { planId: string; review: { files: { path: string; diff: string }[] } };
  expect(data.review.files.map((file) => file.path)).toEqual(['hvigorfile.ts', 'ohmate-hvigor.ts']);
  expect(data.review.files[0].diff).toContain('extra /* retain this */');
  expect(await readFile(join(root, 'hvigorfile.ts'), 'utf8')).toBe(original);
  const result = await runtime.execute('integrate.hvigor', {}, { ...context, policy: { ...context.policy, approvedPlan: data.planId } });
  expect(result.exitCode).toBe(0);
  const attached = await readFile(join(root, 'hvigorfile.ts'), 'utf8');
  expect(attached.startsWith('\ufeff')).toBe(true);
  expect(attached.replace(/\r\n/g, '')).not.toContain('\n');
  expect(attached).toContain('extra /* retain this */');
  const plugin = await readFile(join(root, 'ohmate-hvigor.ts'), 'utf8');
  expect(plugin).toContain('registerTask');
  expect(plugin).toContain('shell: false');
  expect(plugin).not.toContain(root);
  expect(plugin).not.toContain('process.env.OHMATE_APPROVE_PLAN');
  const repeated = await runtime.execute('integrate.hvigor', {}, context);
  expect(repeated.exitCode).toBe(4);
  const journalId = (result.data as { journalId: string }).journalId;
  const restore = await runtime.execute('workspace.recovery.restore', { journalId }, context);
  expect(restore.exitCode).toBe(5);
  expect((await runtime.execute('workspace.recovery.restore', { journalId }, { ...context,
    policy: { ...context.policy, approvedPlan: (restore.data as { planId: string }).planId } })).exitCode).toBe(0);
  expect(await readFile(join(root, 'hvigorfile.ts'), 'utf8')).toBe(original);
  await expect(readFile(join(root, 'ohmate-hvigor.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses dynamic plugin expressions and collisions without executing project code', async () => {
  const { runtime, context } = await setup();
  await writeFile(join(root, 'hvigorfile.ts'), "export default { plugins: loadPlugins() };\n");
  expect((await runtime.execute('integrate.hvigor', {}, context)).exitCode).toBe(4);
  await writeFile(join(root, 'hvigorfile.ts'), original);
  await writeFile(join(root, 'ohmate-hvigor.ts'), '// user file\n');
  expect((await runtime.execute('integrate.hvigor', {}, context)).exitCode).toBe(4);
  expect(await readFile(join(root, 'ohmate-hvigor.ts'), 'utf8')).toBe('// user file\n');
});

it('binds approval to plugin selections and reviewed file bytes', async () => {
  const { runtime, context } = await setup();
  const planned = await runtime.execute('integrate.hvigor', {}, context);
  expect(planned.exitCode).toBe(5);
  await writeFile(join(root, 'hvigorfile.ts'), `${original}// changed\n`);
  const stale = await runtime.execute('integrate.hvigor', {}, { ...context,
    policy: { ...context.policy, approvedPlan: (planned.data as { planId: string }).planId } });
  expect(stale.exitCode).toBe(5);
  expect(stale.data).toMatchObject({ code: 'APPROVAL_STALE' });
});

it('delegates native Scan and Docs and exposes safe test planning', async () => {
  const { runtime, context } = await setup();
  for (const [task, tool] of [['ohmatecliScan', 'scan'], ['ohmatecliDocs', 'docs.check']]) {
    runtime.registry.get(tool)!.execute = async () => ({ exitCode: 0, data: { producer: tool } });
    const result = await runtime.execute('integrate.hvigor-task', { task }, context);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ toolId: tool, execution: 'delegated', result: { data: { producer: tool } } });
  }
  await mkdir(join(root, 'entry/src/test'), { recursive: true });
  await writeFile(join(root, 'entry/src/test/Acceptance.test.ets'), "describe('Suite', () => { it('one', 0, () => {}); });\n");
  const planned = await runtime.execute('integrate.hvigor-task', { task: 'ohmatecliTest' }, context);
  expect(planned.exitCode).toBe(0);
  expect(planned.data).toMatchObject({ task: 'ohmatecliTest', toolId: 'test.plan', execution: 'not-run',
    result: { exitCode: 0, data: { scope: ['Suite'] } } });
  expect((await runtime.execute('integrate.hvigor-task', { task: 'ohmatecliTest', toolId: 'doctor' }, context)).exitCode).toBe(4);
});

it('passes task-specific ranges through the target schema without allowing arbitrary command routing', async () => {
  const { runtime, context } = await setup();
  runtime.registry.get('scan')!.execute = async (input) => ({ exitCode: 0, data: { scope: input } });
  const input = { files: ['entry/src/main/ets/Api.ts'], domains: ['official'] };
  const delegated = await runtime.execute('integrate.hvigor-task', { task: 'ohmatecliScan', input }, context);
  expect(delegated.exitCode).toBe(0);
  expect(delegated.data).toMatchObject({ result: { data: { scope: input } } });
  expect((await runtime.execute('integrate.hvigor-task', { task: 'ohmatecliScan', input: { executable: '/bin/sh' } }, context)).exitCode).toBe(4);
});

it('submits test execution as a persistent approval-bound task without nested Hvigor execution', async () => {
  const { runtime, context } = await setup(), local = runtime.registry.get('test.local')!;
  local.review = async () => ({ writes: ['test outputs'], officialToolBoundary: 'controlled-test' });
  local.execute = async () => { throw new Error('Test producer must not execute before approval'); };
  const result = await runtime.execute('integrate.hvigor-task', { task: 'ohmatecliTest', submit: true }, context);
  expect(result.exitCode).toBe(5);
  expect(result.data).toMatchObject({ task: 'ohmatecliTest', execution: 'awaiting-approval', toolId: 'test.local' });
  const data = result.data as { taskId: string; planId: string; resume: string };
  const task = await runtime.execute('task.show', { id: data.taskId }, context);
  expect(task.data).toMatchObject({ state: 'awaiting-approval', toolId: 'test.local', plan: { planId: data.planId } });
  expect(data.resume).toContain(`ohmatecli task approve ${data.taskId} ${data.planId}`);
  expect((await runtime.execute('integrate.hvigor-task', { task: 'ohmatecliDocs', submit: true }, context)).exitCode).toBe(4);
});

it('passes the official NormalizedFile string path to a real child and retains its nonzero receipt', async () => {
  const entry = join(root, 'child.cjs'), output = join(root, 'child-output.json');
  await writeFile(entry, `const fs = require('node:fs');
    fs.writeFileSync('child-output.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
    console.log(JSON.stringify({ exitCode: 3, data: { code: 'CAPABILITY_UNAVAILABLE' } }));
    process.exitCode = 3;
  `);
  const exports_: { ohmatePlugin?: (input: unknown) => { apply: (node: object) => void } } = {}, tasks: { name: string; run: () => Promise<void> }[] = [];
  const chunks: string[] = [];
  const require_ = Object.assign((name: string) => {
    if (name === 'node:child_process') { return { execFile }; }
    throw new Error('Unexpected generated plugin dependency');
  }, { resolve: () => entry });
  const code = ts.transpileModule(pluginSource(), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports: exports_, require: require_, process: {
    execPath: process.execPath, stdout: { write: (text: string) => chunks.push(text) }, stderr: { write: () => undefined },
  } });
  const input = { files: ['entry/src/main/ets/Api.ts'], domains: ['official'] };
  exports_.ohmatePlugin!({ ohmatecliScan: input }).apply({
    getNodeDir: () => ({ getPath: () => root }),
    registerTask: (task: typeof tasks[number]) => tasks.push(task),
  });
  expect(tasks.map((task) => task.name)).toEqual(['ohmatecliScan', 'ohmatecliDocs', 'ohmatecliTest', 'ohmatecliVerifyRelease']);
  await expect(tasks[0].run()).rejects.toThrow('OHMate task did not pass');
  const invocation = JSON.parse(await readFile(output, 'utf8'));
  expect(invocation.cwd).toBe(root);
  expect(invocation.argv).toEqual(['integrate', 'hvigor-task', '--input',
    JSON.stringify({ task: 'ohmatecliScan', submit: false, input }), '--project', root, '--format', 'json']);
  expect(chunks.join('')).toContain('CAPABILITY_UNAVAILABLE');
});
