/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ModelStore } from './models.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); } vi.unstubAllEnvs(); });
async function setup(data: unknown[], marker = 'vscode-lm-v1', status = 200) {
  const root = await mkdtemp(join(tmpdir(), 'ohmate-trae-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer EXAMPLE_BRIDGE_TEST_KEY');
    response.writeHead(status, { 'x-ohmate-model-bridge': marker });
    response.end(JSON.stringify({ object: 'list', data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  vi.stubEnv('OHMATE_TRAE_BRIDGE_KEY', 'EXAMPLE_BRIDGE_TEST_KEY');
  const context = await createExecutionContext({ cwd: root, dataDir: root });
  return { context, runtime: await createRuntime(), store: new ModelStore(root),
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}
const model = { id: 'TRAE/Example', object: 'model', name: 'Example', owned_by: 'trae', context_window: 32768 };
it('discovers exposed models idempotently without selecting or storing credentials', async () => {
  const { context, runtime, endpoint, store } = await setup([model]);
  const first = await runtime.execute('model.trae', { endpoint }, context);
  expect(first.exitCode).toBe(0);
  expect((first.data as { models: unknown[] }).models).toHaveLength(1);
  expect((await runtime.execute('model.trae', { endpoint }, context)).exitCode).toBe(0);
  expect(await store.list()).toHaveLength(1);
  expect(await store.selected()).toBeNull();
  const config = (await store.list())[0];
  expect(config).toMatchObject({ api: 'openai-completions', model: model.id, endpoint,
    credentialEnv: 'OHMATE_TRAE_BRIDGE_KEY' });
  expect(await readFile(join(context.dataDir, 'state/models.json'), 'utf8'))
    .not.toContain('EXAMPLE_BRIDGE_TEST_KEY');
  await store.select(config.id);
  await runtime.execute('model.trae', { endpoint }, context);
  expect((await store.selected())?.id).toBe(config.id);
});
it('rejects non-loopback endpoints and unverified HTTP services', async () => {
  const { context, runtime, endpoint, store } = await setup([model], 'wrong');
  expect((await runtime.execute('model.trae', { endpoint }, context)).exitCode).not.toBe(0);
  for (const value of ['https://example.test/v1', 'http://127.0.0.1.example.test/v1',
    'http://localhost:42/v1', 'http://127.0.0.1/v1?secret=x']) {
    expect((await runtime.execute('model.trae', { endpoint: value }, context)).exitCode).not.toBe(0);
  }
  expect(await store.list()).toEqual([]);
});
it('returns explicit unavailable status for empty list and missing credentials', async () => {
  const { context, runtime, endpoint, store } = await setup([]);
  expect((await runtime.execute('model.trae', { endpoint }, context)).data).toMatchObject({ code: 'TRAE_MODELS_NOT_EXPOSED' });
  vi.stubEnv('OHMATE_TRAE_BRIDGE_KEY', '');
  expect((await runtime.execute('model.trae', { endpoint }, context)).data).toMatchObject({ code: 'MODEL_CREDENTIAL_MISSING' });
  expect(await store.list()).toEqual([]);
});
it('rejects malformed model lists before writing any config', async () => {
  const { context, runtime, endpoint, store } = await setup([model, { ...model, id: 'other', context_window: 0 }]);
  expect((await runtime.execute('model.trae', { endpoint }, context)).exitCode).not.toBe(0);
  expect(await store.list()).toEqual([]);
});
