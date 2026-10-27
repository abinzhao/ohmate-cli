/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { access } from 'node:fs/promises';
import { expect, it } from 'vitest';

async function uiModel() {
  const url = new URL('../../../../apps/web/ui-model.js', import.meta.url);
  try { await access(url); return await import(url.href); } catch { return null; }
}

it('merges the startup project with saved applications without duplicating it', async () => {
  const model = await uiModel();
  expect(model).not.toBeNull();
  if (!model) { return; }
  expect(model.mergeApplications('/workspace/current', null, [
    { root: '/workspace/saved', name: 'SavedApp', workspaceId: 'saved' },
    { root: '/workspace/current', name: 'CurrentApp', workspaceId: 'current' },
  ])).toEqual([
    { root: '/workspace/current', name: 'CurrentApp', workspaceId: 'current', current: true, saved: true },
    { root: '/workspace/saved', name: 'SavedApp', workspaceId: 'saved', current: false, saved: true },
  ]);
  expect(model.mergeApplications('/workspace/only', null, [])).toEqual([
    { root: '/workspace/only', name: 'only', workspaceId: null, current: true, saved: false },
  ]);
});

it('describes unavailable extensions without turning them into active controls', async () => {
  const model = await uiModel();
  expect(model).not.toBeNull();
  if (!model) { return; }
  expect(model.extensionState({ enabled: false, status: 'unverified' })).toEqual({
    label: '未验证', tone: 'warning', actionable: false,
  });
});

it('keeps advanced scope text and saved paths on the same source of truth', async () => {
  const model = await uiModel();
  expect(model).not.toBeNull();
  if (!model) { return; }
  expect(model.splitScopePaths(' a.ts \n\n b.ts \n a.ts ')).toEqual(['a.ts', 'b.ts']);
  expect(model.appendScopePath('a.ts\nmanual.ts', 'b.ts')).toBe('a.ts\nmanual.ts\nb.ts');
  expect(model.appendScopePath('a.ts\nb.ts', 'b.ts')).toBe('a.ts\nb.ts');
  expect(model.removeScopePath('a.ts\nb.ts\nmanual.ts', 'b.ts')).toBe('a.ts\nmanual.ts');
  expect(model.splitScopePaths(model.removeScopePath('build-profile.json5', 'build-profile.json5'))).toEqual([]);
});

it('routes task pages without losing the task identity', async () => {
  const model = await uiModel();
  expect(model).not.toBeNull();
  if (!model) { return; }
  expect(model.parseRoute('#task/8f0a7f2e-1f5e-4d0e-9f6a-2b7c8d9e0f12'))
    .toEqual({ page: 'task', id: '8f0a7f2e-1f5e-4d0e-9f6a-2b7c8d9e0f12' });
  expect(model.parseRoute('#apps')).toEqual({ page: 'apps' });
  expect(model.parseRoute('#library')).toEqual({ page: 'library' });
  expect(model.parseRoute('#debug')).toEqual({ page: 'debug' });
  expect(model.parseRoute('#task/not-a-uuid')).toEqual({ page: 'home' });
  expect(model.parseRoute('')).toEqual({ page: 'home' });
});

it('matches Chinese tool intent words against registered metadata', async () => {
  const model = await uiModel();
  expect(model).not.toBeNull();
  if (!model) { return; }
  const build = { id: 'build.run', command: ['build', 'run'], description: 'Build through bundled DevEco adapters' };
  const doctor = { id: 'doctor', command: ['doctor'], description: 'Check local Node.js, platform and toolchain' };
  expect(model.toolMatches(build, '构建')).toBe(true);
  expect(model.toolMatches(doctor, '构建')).toBe(false);
  expect(model.toolMatches(build, 'build')).toBe(true);
  expect(model.toolMatches(build, '')).toBe(true);
  expect(model.toolMatches({ id: 'deveco.device.list', command: ['device', 'list'], description: 'List devices' }, '设备')).toBe(true);
});

it('clears project-bound file and conversation scope when the project root changes', async () => {
  const model = await uiModel();
  expect(model).not.toBeNull();
  if (!model) { return; }
  const state = { projectRoot: '/workspace/a', projectName: 'A', files: ['a.ts'], writePaths: ['a.ts'],
    allowedTools: ['build'], sessionId: 'session-1', command: { toolId: 'build', input: {} } };
  expect(model.bindProject(state, '/workspace/a', 'A')).toBe(false);
  expect(state).toMatchObject({ files: ['a.ts'], writePaths: ['a.ts'], allowedTools: ['build'], sessionId: 'session-1' });
  expect(model.bindProject(state, '/workspace/b', 'B')).toBe(true);
  expect(state).toMatchObject({ projectRoot: '/workspace/b', projectName: 'B', files: [], writePaths: [],
    sessionId: undefined, command: null, allowedTools: model.DEFAULT_ALLOWED_TOOLS });
  expect(state.allowedTools).not.toBe(model.DEFAULT_ALLOWED_TOOLS);
});
