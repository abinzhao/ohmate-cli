/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionContext, createRuntime, type ToolSpec } from './index.js';
import { executeLegacy } from '../legacy/runner.js';
import { ToolProvider } from '../toolchain/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-execution-'));
  roots.push(root);
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const runtime = await createRuntime();
  return { root, context, runtime };
}
function tool(runtime: Awaited<ReturnType<typeof createRuntime>>, id: string, execute: ToolSpec['execute'], risk: ToolSpec['risk'] = 'R1') {
  runtime.registry.register({ ...runtime.registry.get('doctor')!, id, command: [id], execute, risk });
}
async function buildFixture(root: string) {
  await mkdir(join(root, 'entry/src/main'), { recursive: true });
  await mkdir(join(root, 'AppScope'));
  await mkdir(join(root, 'sdk/default'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), JSON.stringify({ app: { products: [{ name: 'default' }],
    signingConfigs: [{ name: 'test-signing' }] }, modules: [{ name: 'entry', srcPath: './entry' }] }));
  await writeFile(join(root, 'entry/src/main/module.json5'), '{"module":{"name":"entry","type":"entry"}}');
  await writeFile(join(root, 'oh-package.json5'), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(join(root, 'AppScope/app.json5'), '{"app":{"bundleName":"org.example.fixture"}}');
  await writeFile(join(root, 'producer.cjs'), 'console.log("fixture");');
  await writeFile(join(root, 'sdk/default/sdk-pkg.json'), '{"data":{"apiVersion":26}}');
  vi.spyOn(ToolProvider, 'new').mockResolvedValue({ nodePath: process.execPath, javaPath: process.execPath,
    hvigorJsPath: join(root, 'producer.cjs'), ohpmJsPath: join(root, 'producer.cjs'), sdkPath: join(root, 'sdk'),
    sourceType: 'studio', assertJava: () => undefined, readVersion: () => '26.0.0.821' } as unknown as ToolProvider);
}

describe('execution policies and resource lifetime', () => {
  it.each([
    { argv: [], risk: 'R2' },
    { argv: ['--signing-config', 'test-signing'], risk: 'R3' },
    { argv: ['--signing-config=test-signing'], risk: 'R3' },
  ])('requires $risk approval before a compatibility build with $argv', async ({ argv, risk }) => {
    const { runtime, context, root } = await fixture();
    await buildFixture(root);
    const spec = runtime.registry.get('deveco.build')!;
    const execute = vi.fn<ToolSpec['execute']>(async () => ({ exitCode: 0, data: {} }));
    spec.execute = execute;
    const receipt = await runtime.execute(spec.id, { argv }, context);
    expect(receipt.exitCode).toBe(5);
    expect(receipt.data).toMatchObject({ code: 'APPROVAL_REQUIRED', risk });
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks overlapping workspace writes but allows concurrent reads', async () => {
    const { context, runtime } = await fixture();
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn<ToolSpec['execute']>(async () => { started(); await gate; return { exitCode: 0, data: {} }; });
    tool(runtime, 'fixture.write', execute);
    tool(runtime, 'fixture.read', async () => ({ exitCode: 0, data: {} }), 'R0');
    const running = runtime.execute('fixture.write', {}, context);
    try {
      await ready;
      const overlapping = await runtime.execute('fixture.write', {}, context);
      expect(overlapping.exitCode).toBe(5);
      expect(overlapping.data).toMatchObject({ code: 'RESOURCE_BUSY' });
      expect((await runtime.execute('fixture.read', {}, context)).exitCode).toBe(0);
      expect(execute).toHaveBeenCalledOnce();
    } finally { release(); await running; }
    expect((await runtime.execute('fixture.write', {}, context)).exitCode).toBe(0);
  });

  it('enforces timeout, waits for child exit, and keeps partial output', async () => {
    const { root, context, runtime } = await fixture();
    const entry = join(root, 'waiting.mjs');
    await writeFile(entry, `console.log('ready'); setInterval(() => {}, 1000);`);
    runtime.registry.register({
      ...runtime.registry.get('doctor')!, id: 'fixture.timeout', command: ['fixture.timeout'], timeoutMs: 1000,
      execute: (_, current) => executeLegacy([], current, false, entry),
    });
    const result = await runtime.execute('fixture.timeout', {}, context);
    expect(result.exitCode).toBe(6);
    expect(result.data).toMatchObject({ code: 'TOOL_TIMEOUT', partial: { stdout: 'ready\n', signal: 'SIGTERM' } });
  });

  it('expires a plan and invalidates the changed ToolSpec schema or target', async () => {
    const { context, runtime } = await fixture();
    const execute = vi.fn<ToolSpec['execute']>(async () => ({ exitCode: 0, data: {} }));
    tool(runtime, 'fixture.write', execute, 'R2');
    const first = await runtime.execute('fixture.write', {}, context);
    expect(first.exitCode).toBe(5);
    const planId = (first.data as { planId: string }).planId;
    const file = join(context.dataDir, 'plans', `${planId}.json`);
    const plan = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...plan, expiresAt: new Date(0).toISOString() }));
    const expired = await runtime.execute('fixture.write', {}, { ...context, policy: { ...context.policy, approvedPlan: planId } });
    expect(expired.exitCode).toBe(5);
    expect(expired.data).toMatchObject({ code: 'APPROVAL_STALE' });
    const freshId = (expired.data as { planId: string }).planId;
    expect((await runtime.execute('fixture.write', {}, { ...context, target: { device: 'fixture-device' },
      policy: { ...context.policy, approvedPlan: freshId } })).exitCode).toBe(5);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not give a protocol tool access to service stdin', async () => {
    const { runtime, context } = await fixture();
    const execute = vi.fn<ToolSpec['execute']>(async () => ({ exitCode: 0, data: {} }));
    runtime.registry.register({ ...runtime.registry.get('doctor')!, id: 'fixture.protocol', command: ['protocol'], protocol: true, execute });
    const result = await runtime.execute('fixture.protocol', {}, context);
    expect(result.exitCode).toBe(5);
    expect(result.data).toMatchObject({ code: 'PROTOCOL_REQUIRES_TERMINAL' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a fresh approval for a second high risk execution', async () => {
    const { runtime, context } = await fixture();
    const execute = vi.fn<ToolSpec['execute']>(async () => ({ exitCode: 0, data: {} }));
    tool(runtime, 'fixture.write', execute, 'R3');
    const planned = await runtime.execute('fixture.write', {}, context);
    const approved = { ...context, policy: { ...context.policy, approvedPlan: (planned.data as { planId: string }).planId } };
    expect((await runtime.execute('fixture.write', {}, approved)).exitCode).toBe(0);
    expect((await runtime.execute('fixture.write', {}, approved)).exitCode).toBe(5);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('binds a legacy task plan to its declared project instead of the caller cwd', async () => {
    const { runtime, context, root } = await fixture();
    const actual = await mkdtemp(join(tmpdir(), 'ohmate-target-'));
    roots.push(actual);
    const execute = vi.fn<ToolSpec['execute']>(async () => ({ exitCode: 0, data: {} }));
    runtime.registry.register({ ...runtime.registry.get('deveco.init')!, id: 'fixture.legacy', risk: 'R2', execute });
    const { TaskManager } = await import('../tasks/index.js');
    const task = await new TaskManager(runtime, context).submit('fixture.legacy', { argv: ['--project', actual] }, true);
    expect(task.projectRoot).toBe(actual);
    expect(task.plan?.project).toBe(actual);
    expect(task.plan?.project).not.toBe(root);
    expect(execute).not.toHaveBeenCalled();
  });
});
