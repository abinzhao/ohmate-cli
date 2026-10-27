/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const taskSource = () => readFile(new URL('../../../../apps/web/tasks.js', import.meta.url), 'utf8');

async function presentation() {
  const source = await taskSource();
  return runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + `
    ({
      taskTitle,
      taskStage: typeof taskStage === 'function' ? taskStage : null,
      taskProgress: typeof taskProgress === 'function' ? taskProgress : null,
      resultProjection: typeof resultProjection === 'function' ? resultProjection : null,
      logEntry: typeof logEntry === 'function' ? logEntry : null,
      taskSignature: typeof taskSignature === 'function' ? taskSignature : null,
      filterTasks: typeof filterTasks === 'function' ? filterTasks : null,
    });`, {
    node: () => ({}), button: () => ({}), details: () => ({}), pre: () => ({}),
    toast: () => {}, download: () => {}, problemReview: () => ({}), $: () => null,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  });
}

it('imports the empty-state renderer used by result views', async () => {
  const source = await taskSource();
  expect(source).toMatch(/import \{[^}]*\bempty\b[^}]*\} from '\.\/view\.js';/);
});

it('names deterministic tools by user outcome instead of registry id', async () => {
  const view = await presentation();
  expect(view.taskTitle({ toolId: 'doctor', input: {} })).toBe('检查本地环境');
  expect(view.taskTitle({ toolId: 'project.inspect', input: {} })).toBe('检查应用工程');
  expect(view.taskTitle({ toolId: 'agent.run', input: { prompt: '修复构建问题' } })).toBe('修复构建问题');
});

it('maps runtime state to a user-facing stage with an explicit next action', async () => {
  const view = await presentation();
  expect(view.taskStage).toBeTypeOf('function');
  if (!view.taskStage) { return; }
  expect(view.taskStage({ state: 'awaiting-approval' })).toMatchObject({
    label: '等待确认', index: 2, tone: 'warning', next: '检查影响范围并确认是否执行',
  });
  expect(view.taskStage({ state: 'cancelled' })).toMatchObject({
    label: '已停止', index: 5, tone: 'neutral',
  });
  expect(view.taskStage({ state: 'succeeded', receipt: { status: 'degraded', exitCode: 3 } })).toMatchObject({
    label: '完成，证据不完整', index: 5, tone: 'warning',
  });
});

it('projects a receipt into summary, findings, changes, evidence and raw views', async () => {
  const view = await presentation();
  expect(view.resultProjection).toBeTypeOf('function');
  if (!view.resultProjection) { return; }
  const receipt = {
    exitCode: 0, status: 'passed', durationMs: 24, warnings: [], artifacts: [],
    provenance: { adapter: 'native' },
    data: {
      node: { version: 'v22.22.0', supported: true }, platform: 'darwin', arch: 'arm64',
      project: { root: '/fixture/project', modules: [] }, toolchain: { available: true },
    },
  };
  const projected = view.resultProjection({
    toolId: 'doctor', state: 'succeeded', projectRoot: '/fixture/project', receipt,
  });
  expect(projected.summary.map((item: { label: string }) => item.label)).toEqual(
    expect.arrayContaining(['任务', '结果', '耗时', 'Node.js', '平台', '工程']),
  );
  expect(projected.findings).toEqual([]);
  expect(projected.changes).toEqual([]);
  expect(projected.appliedChanges).toEqual([]);
  expect(projected.planChanges).toEqual([]);
  expect(projected.evidence).toMatchObject({ source: 'native', artifacts: [], warnings: [] });
  expect(projected.raw).toEqual(receipt);
});

it('marks verification as not completed when a task is cancelled or failed', async () => {
  const view = await presentation();
  expect(view.taskProgress).toBeTypeOf('function');
  if (!view.taskProgress) { return; }
  const awaiting = view.taskProgress({ state: 'cancelled', plan: { planId: 'p', review: { files: [] } }, processes: [] });
  expect(awaiting.find((step: { label: string }) => step.label === '等待确认')).toMatchObject({ status: 'current' });
  expect(awaiting.find((step: { label: string }) => step.label === '执行')).toMatchObject({ status: 'skipped' });
  expect(awaiting.find((step: { label: string }) => step.label === '验证')).toMatchObject({ status: 'skipped' });
  const running = view.taskProgress({ state: 'cancelled', plan: null, processes: [{ pid: 1 }] });
  expect(running.find((step: { label: string }) => step.label === '执行')).toMatchObject({ status: 'current' });
  expect(running.find((step: { label: string }) => step.label === '验证')).toMatchObject({ status: 'skipped' });
  const failed = view.taskProgress({ state: 'failed', processes: [] });
  expect(failed.find((step: { label: string }) => step.label === '验证')).toMatchObject({ status: 'current' });
  const succeeded = view.taskProgress({ state: 'succeeded', receipt: { exitCode: 0 } });
  expect(succeeded.every((step: { status: string }) => step.status === 'complete')).toBe(true);
});

it('separates proposed plan changes from applied changes', async () => {
  const view = await presentation();
  expect(view.resultProjection).toBeTypeOf('function');
  if (!view.resultProjection) { return; }
  const plan = { planId: 'plan-1', review: { files: [
    { path: 'a.ts', operation: 'replace', oldHash: 'old', newHash: 'new', diff: '--- a\n+++ b' },
  ] } };
  const cancelled = view.resultProjection({ toolId: 'workspace.patch', state: 'cancelled', plan,
    receipt: { exitCode: 130, data: { code: 'TASK_CANCELLED' }, provenance: { adapter: 'native' } } });
  expect(cancelled.changes).toEqual([]);
  expect(cancelled.appliedChanges).toEqual([]);
  expect(cancelled.planChanges).toHaveLength(1);
  expect(cancelled.planStatus).toBe('cancelled');
  const applied = view.resultProjection({ toolId: 'workspace.patch', state: 'succeeded', plan,
    receipt: { exitCode: 0, data: { code: 'PATCH_APPLIED', phase: 'applied' }, provenance: { adapter: 'native' } } });
  expect(applied.appliedChanges).toHaveLength(1);
  expect(applied.planStatus).toBe('applied');
});

it('exposes stdout and stderr text from task events', async () => {
  const view = await presentation();
  expect(view.logEntry).toBeTypeOf('function');
  if (!view.logEntry) { return; }
  expect(view.logEntry({ sequence: 2, type: 'tool.stdout', payload: { text: 'hello\n' } }))
    .toMatchObject({ channel: 'stdout', text: 'hello\n' });
  expect(view.logEntry({ sequence: 3, type: 'tool.stderr', payload: { text: 'bad' } }))
    .toMatchObject({ channel: 'stderr', text: 'bad' });
  expect(view.logEntry({ sequence: 4, type: 'process.started', payload: { pid: 42 } }).text).toContain('42');
  expect(view.logEntry({ sequence: 5, type: 'task.state', payload: { state: 'running' } })).toBeNull();
});

it('keeps the rendered task stable while only log sequence changes', async () => {
  const view = await presentation();
  expect(view.taskSignature).toBeTypeOf('function');
  if (!view.taskSignature) { return; }
  const base = { id: 'task-1', state: 'running', plan: null, receipt: null, sessionId: null,
    cancelRequested: false, forceRequested: false };
  expect(view.taskSignature({ ...base, updatedAt: 'a', sequence: 1 }))
    .toBe(view.taskSignature({ ...base, updatedAt: 'b', sequence: 9 }));
  expect(view.taskSignature({ ...base, state: 'failed' })).not.toBe(view.taskSignature(base));
  expect(view.taskSignature({ ...base, cancelRequested: true })).not.toBe(view.taskSignature(base));
  expect(view.taskSignature(base, [{ id: 'pending', state: 'awaiting-approval' }]))
    .not.toBe(view.taskSignature(base, [{ id: 'pending', state: 'succeeded' }]));
});

it('filters history by title, project and state', async () => {
  const view = await presentation();
  expect(view.filterTasks).toBeTypeOf('function');
  if (!view.filterTasks) { return; }
  const tasks = [
    { id: '1', toolId: 'doctor', state: 'succeeded', projectRoot: '/workspace/App', input: {}, receipt: { status: 'passed' } },
    { id: '2', toolId: 'agent.run', state: 'failed', projectRoot: '/workspace/Other', input: { prompt: '修复构建' }, receipt: {} },
  ];
  expect(view.filterTasks(tasks, '构建')).toHaveLength(1);
  expect(view.filterTasks(tasks, '', 'failed')).toHaveLength(1);
  expect(view.filterTasks(tasks, 'Other')).toHaveLength(1);
  expect(view.filterTasks(tasks, '检查本地环境')).toHaveLength(1);
});
