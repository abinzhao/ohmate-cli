/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext } from '../runtime/context.js';
import { digest } from './evidence.js';
import { installedInputDrift, snapshotInstalledInputs } from './installed-inputs.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-installed-inputs-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(path: string, text = 'test-owned installed input') {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
async function collect() {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private-data') });
  return snapshotInstalledInputs({ root, modules: [{ path: join(root, 'products/phone') }] }, context);
}
it('captures root and declared nested module installations with defensive byte hashes', async () => {
  await put('oh_modules/.ohpm/library/Index.ets');
  await put('products/phone/oh_modules/helper/sourceMaps.map', '{"version":3}');
  const inventory = await collect();
  expect(inventory.missing).toEqual([]);
  expect(inventory.files).toEqual(expect.arrayContaining([
    { path: 'oh_modules/.ohpm/library/Index.ets', sha256: digest('test-owned installed input'), size: 26 },
    { path: 'products/phone/oh_modules/helper/sourceMaps.map', sha256: digest('{"version":3}'), size: 13 },
  ]));
  const same = await collect();
  inventory.files[0].sha256 = 'changed only in caller';
  expect(same.files[0].sha256).not.toBe(inventory.files[0].sha256);
});
it.skipIf(process.platform === 'win32')('binds in-scope OHPM aliases and their hidden installed target bytes', async () => {
  await put('oh_modules/.ohpm/library/Index.ets', 'version one');
  await symlink('.ohpm/library', join(root, 'oh_modules/library'));
  const before = await collect();
  expect(before.missing).toEqual([]);
  expect(before.links).toEqual([{ path: 'oh_modules/library', targetPath: 'oh_modules/.ohpm/library', sha256: digest('.ohpm/library') }]);
  expect(before.files).toHaveLength(1);
  await put('oh_modules/.ohpm/library/Index.ets', 'version two');
  expect(installedInputDrift(before, await collect())).toEqual(['oh_modules/.ohpm/library/Index.ets']);
});
it.each(['added', 'removed', 'changed'])('detects %s installed content after a snapshot', async (mode) => {
  await put('oh_modules/library/Index.ets');
  const before = await collect();
  const path = 'oh_modules/library/Index.ets';
  if (mode === 'removed') { await rm(join(root, path)); }
  else { await put(mode === 'added' ? 'oh_modules/library/New.ets' : path, 'new installed bytes'); }
  expect(installedInputDrift(before, await collect())).toEqual([mode === 'added' ? 'oh_modules/library/New.ets' : path]);
});
it('keeps absent installations distinct from a newly introduced empty installed root', async () => {
  const before = await collect();
  await mkdir(join(root, 'oh_modules'));
  expect(installedInputDrift(before, await collect())).toEqual(['oh_modules']);
});
it.skipIf(process.platform === 'win32')('marks a dangling installed root unreadable rather than absent', async () => {
  await symlink('missing', join(root, 'oh_modules'));
  expect(await collect()).toMatchObject({
    roots: expect.arrayContaining([{ path: 'oh_modules', status: 'unreadable' }]), missing: ['oh_modules'],
  });
});
it.skipIf(process.platform === 'win32')('refuses an installed alias outside registered roots and does not hash its target', async () => {
  await put('other/Index.ets', 'test-owned outside installed scope');
  await mkdir(join(root, 'oh_modules'));
  await symlink('../other', join(root, 'oh_modules/library'));
  const inventory = await collect();
  expect(inventory.missing).toEqual(['oh_modules/library']);
  expect(inventory.files).toEqual([]);
  expect(inventory.links).toEqual([]);
});
it('omits sensitive installed content without retaining its name or digest', async () => {
  await put('oh_modules/library/.env', 'test-owned private marker');
  const inventory = await collect();
  expect(inventory.missing).toEqual(['installed-sensitive-input']);
  expect(JSON.stringify(inventory)).not.toContain('.env');
  expect(JSON.stringify(inventory)).not.toContain(digest('test-owned private marker'));
});
it.skipIf(process.platform === 'win32')('records unreadable files and restores test-owned permissions before cleanup', async () => {
  const file = await put('oh_modules/library/Index.ets');
  await chmod(file, 0);
  try {
    expect(await collect()).toMatchObject({ files: [], missing: ['oh_modules/library/Index.ets'] });
  } finally { await chmod(file, 0o600); }
});
it('shares the content budget between root and module dependency stores', async () => {
  for (let index = 0; index < 9; index++) {
    const path = `${index < 4 ? 'oh_modules' : 'products/phone/oh_modules'}/library${index}.abc`;
    const file = await put(path);
    await truncate(file, 8 * 1024 * 1024);
  }
  const inventory = await collect();
  expect(inventory.files).toHaveLength(8);
  expect(inventory.missing).toHaveLength(1);
  expect(inventory.files.reduce((total, file) => total + file.size, 0)).toBe(64 * 1024 * 1024);
});
it.skipIf(process.platform === 'win32')('rejects FIFO input without opening or waiting for a writer', async () => {
  await mkdir(join(root, 'oh_modules'));
  const made = spawnSync('mkfifo', [join(root, 'oh_modules/input.fifo')], { cwd: root, encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  expect(await collect()).toMatchObject({ files: [], missing: ['oh_modules/input.fifo'] });
});
