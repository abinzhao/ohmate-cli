/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

interface FormEvent { preventDefault(): void }
class NodeProbe {
  children: unknown[];
  disabled = false;
  submit?: (event: FormEvent) => Promise<void>;
  constructor(readonly tag: string, children: unknown[] = []) { this.children = children; }
  append(...children: unknown[]): void { this.children.push(...children); }
  addEventListener(_name: string, action: (event: FormEvent) => Promise<void>): void { this.submit = action; }
}
async function setup(receipt: unknown, discovery = 'discoverTrae') {
  const nodes: NodeProbe[] = [], titles: string[] = [], toast = vi.fn();
  const request = vi.fn(async () => ({ data: { state: 'succeeded', receipt } }));
  const execute = vi.fn(async (id: string) => {
    if (id !== 'model.list') { throw new Error('Discovery must use a persistent task'); }
    return { data: { models: [], selected: null } };
  });
  const source = await readFile(new URL('../../../../apps/web/panels.js', import.meta.url), 'utf8');
  const discover = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
    `\n${discovery};`, {
    execute, request, toast, guarded: (action: unknown) => action,
    field: () => ({ view: new NodeProbe('field'), input: { value: discovery === 'discoverTrae' ? 'http://127.0.0.1:3456/v1' : '/fixture/trae-cli' } }),
    node: (tag: string, _attributes: unknown, children: unknown[] = []) => {
      const node = new NodeProbe(tag, children); nodes.push(node); return node;
    },
    button: () => new NodeProbe('button'), modal: (title: string) => titles.push(title),
  }) as (state: unknown, changed: () => void) => void;
  discover({ projectRoot: '/fixture/project', modelId: null }, () => {});
  const form = nodes.find(node => node.tag === 'form')!, submit = nodes.find(node => node.tag === 'button')!;
  return { request, execute, toast, titles, submit, send: () => form.submit!({ preventDefault() {} }) };
}

it('discovers through a persistent task and displays models only after its successful receipt', async () => {
  const view = await setup({ exitCode: 0, data: { models: [{ id: 'fixture-model' }] } });
  await view.send();
  expect(view.request).toHaveBeenCalledWith('tasks', {
    toolId: 'model.trae', input: { endpoint: 'http://127.0.0.1:3456/v1' }, projectRoot: '/fixture/project', wait: true,
  });
  expect(view.execute.mock.calls.map(call => call[0])).toEqual(['model.list']);
  expect(view.titles).toEqual(['发现 TRAE 模型', '模型连接']);
  expect(view.toast).toHaveBeenCalledWith('发现 1 个公开模型。请选择模型后使用。');
  expect(view.submit.disabled).toBe(false);
});

it('keeps the discovery form retryable after a blocked task without reporting success', async () => {
  const view = await setup({ exitCode: 5, data: { code: 'MODEL_CREDENTIAL_MISSING' } });
  await expect(view.send()).rejects.toThrow('MODEL_CREDENTIAL_MISSING');
  expect(view.execute).not.toHaveBeenCalled();
  expect(view.toast).not.toHaveBeenCalled();
  expect(view.titles).toEqual(['发现 TRAE 模型']);
  expect(view.submit.disabled).toBe(false);
});

it('keeps the selected application scope when checking a model connection', async () => {
  const actions = new Map<string, () => Promise<void>>();
  const projectRoot = '/fixture/selected-app', task = { projectRoot }, openTask = vi.fn();
  const request = vi.fn(async () => ({ data: task }));
  const source = await readFile(new URL('../../../../apps/web/panels.js', import.meta.url), 'utf8');
  const models = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nmodels;', {
    request, execute: async () => ({ data: { models: [{ id: 'fixture', model: 'fixture', endpoint: 'http://127.0.0.1:3456/v1' }] } }),
    node: (tag: string, _attributes: unknown, children: unknown[] = []) => new NodeProbe(tag, children),
    button: (label: string, action: () => Promise<void>) => { actions.set(label, action); return new NodeProbe('button'); },
    modal: () => {}, $: () => ({ close() {} }),
  }) as (state: unknown, changed: () => void) => Promise<void>;
  await models({ projectRoot, openTask }, () => {});
  await actions.get('检查连接')!();
  expect(request).toHaveBeenCalledWith('tasks', { toolId: 'model.check', input: { id: 'fixture' }, projectRoot });
  expect(openTask).toHaveBeenCalledWith(task);
});

it('discovers installed CLI models through a scoped persistent task without asking for a bridge key', async () => {
  const view = await setup({ exitCode: 0, data: { models: [{ id: 'fixture-model' }] } }, 'discoverTraeCli');
  await view.send();
  expect(view.request).toHaveBeenCalledWith('tasks', { toolId: 'model.trae-cli', input: { executable: '/fixture/trae-cli' },
    projectRoot: '/fixture/project', wait: true });
  expect(view.titles).toEqual(['发现 TRAE CLI 模型', '模型连接']);
  expect(view.submit.disabled).toBe(false);
});
