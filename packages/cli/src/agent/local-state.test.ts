/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ModelStore } from './models.js';
import { SessionStore } from './sessions.js';
import { ContextService } from './context-service.js';
import { createExecutionContext } from '../runtime/context.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-agent-state-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('stores explicit model references, defaults to disabled, and clears a removed selection', async () => {
  const store = new ModelStore(root);
  expect(await store.selected()).toBeNull();
  await store.add({ id: 'demo', api: 'openai-completions', model: 'example', endpoint: 'https://example.test/v1', credentialEnv: 'OHMATE_TEST_KEY' });
  expect(await store.selected()).toBeNull();
  await store.select('demo');
  expect(await store.selected()).toMatchObject({ credentialEnv: 'OHMATE_TEST_KEY' });
  await store.remove('demo');
  expect(await store.selected()).toBeNull();
});

it('rejects embedded credentials and unsafe endpoints before persisting', async () => {
  const store = new ModelStore(root);
  const model = { id: 'demo', api: 'openai-completions', model: 'example', endpoint: 'https://example.test/v1', credentialEnv: 'EXAMPLE_ENV' };
  await expect(store.add({ ...model, apiKey: 'EXAMPLE_SECRET' })).rejects.toThrow();
  await expect(store.add({ ...model, endpoint: 'https://user:pass@example.test/v1' })).rejects.toThrow();
  await expect(store.add({ ...model, endpoint: 'http://example.test/v1' })).rejects.toThrow();
  await expect(store.add({ ...model, credentialEnv: 'a=b' })).rejects.toThrow();
});

it('isolates session transcripts, guards ids, and keeps concurrent entries', async () => {
  const store = new SessionStore(root);
  const a = await store.create('/project/a'), b = await store.create('/project/b');
  for (const text of ['one', 'two']) { await store.append(a.id, 'message', { role: 'user', content: text }); }
  expect((await store.show(a.id)).entries.map((entry) => entry.sequence)).toEqual([1, 2]);
  expect((await store.show(b.id)).entries).toEqual([]);
  await expect(store.show('../models')).rejects.toThrow();
  await store.append(a.id, 'message', { role: 'user', content: 'password="EXAMPLE SECRET"' });
  expect(JSON.stringify(await store.show(a.id))).not.toContain('EXAMPLE SECRET');
});

it('previews selected material with hashes and rejects escape, secrets, binary and budget overflow', async () => {
  await writeFile(join(root, 'main.ts'), 'export const value = 1;');
  await writeFile(join(root, 'AGENTS.md'), 'Use short functions.');
  await writeFile(join(root, '.env'), 'EXAMPLE_KEY=EXAMPLE_SECRET');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  await symlink('/etc/hosts', join(root, 'outside'));
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'data') });
  const service = new ContextService(context);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'private.txt'), 'Private product state.');
  await symlink(join(root, 'data', 'private.txt'), join(root, 'leak.ts'));
  const preview = await service.preview({ prompt: 'Inspect', files: ['main.ts'] });
  expect(preview.materials.map((file) => file.path)).toContain('AGENTS.md');
  expect(preview.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.text).toContain('export const value');
  await writeFile(join(root, 'main.ts'), 'export const value = 2;');
  expect((await service.preview({ prompt: 'Inspect', files: ['main.ts'] })).hash).not.toBe(preview.hash);
  for (const file of ['../outside', '.env', 'outside', 'binary.bin', 'leak.ts']) {
    await expect(service.preview({ prompt: 'Inspect', files: [file] })).rejects.toThrow();
  }
  await expect(service.preview({ prompt: 'Inspect', files: ['main.ts'], maxBytes: 5 })).rejects.toThrow();
});

it('requires an explicit action for approved memory and blocks executable extension loading', async () => {
  const context = await createExecutionContext({ cwd: root, dataDir: join(root, 'data') });
  const service = new ContextService(context);
  await service.addMemory('Keep public identifiers stable.');
  expect((await service.preview({ prompt: 'Inspect', files: [] })).text).toContain('Keep public identifiers stable.');
  await expect(service.addMemory('token=EXAMPLE_SECRET')).rejects.toThrow();
  await service.setExtension('example', false);
  await expect(service.setExtension('example', true)).rejects.toThrow('not verified');
  expect(await service.extensions()).toEqual([{ id: 'example', enabled: false, status: 'unverified' }]);
});

it('refuses linked or corrupted state instead of silently resetting models', async () => {
  const store = new ModelStore(root);
  await store.add({ id: 'demo', api: 'openai-completions', model: 'example', endpoint: 'https://example.test/v1', credentialEnv: 'EXAMPLE_ENV' });
  const file = join(root, 'state', 'models.json');
  expect(await readFile(file, 'utf8')).toContain('EXAMPLE_ENV');
  await writeFile(file, '{broken');
  await expect(store.list()).rejects.toThrow();
  await rm(file);
  await symlink('/etc/hosts', file);
  await expect(store.list()).rejects.toThrow();
});
