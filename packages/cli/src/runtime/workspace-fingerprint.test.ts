/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceFingerprint } from './workspace-fingerprint.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'ohmate-fingerprint-')); });
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); });

it('reads in bounded groups while preserving the ordered content hash and closing every handle', async () => {
  const names = Array.from({ length: 8 }, (_, index) => `file-${index}.txt`);
  for (const name of names) { await fs.writeFile(join(root, name), name); }
  const open = fs.open.bind(fs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, closed = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), read = handle.readFile.bind(handle), close = handle.close.bind(handle);
    handle.readFile = (async (...input: Parameters<typeof handle.readFile>) => {
      active++; peak = Math.max(peak, active);
      try { await gate; return await read(...input); } finally { active--; }
    }) as typeof handle.readFile;
    handle.close = async () => { await close(); closed++; };
    return handle;
  });
  syncBuiltinESMExports();
  const work = workspaceFingerprint(root, join(root, 'data'));
  try { await vi.waitFor(() => expect(active).toBe(4), { timeout: 500, interval: 10 }); }
  finally { release(); await work; }
  const expected = createHash('sha256');
  for (const name of names) { expected.update(`${name}\0`).update(name).update('\0'); }
  expect(await work).toBe(expected.digest('hex'));
  expect(peak).toBe(4);
  expect(closed).toBe(8);
});

it('waits for sibling reads and closes before reporting a read failure', async () => {
  for (const name of ['a', 'b', 'c', 'd']) { await fs.writeFile(join(root, name), name); }
  const open = fs.open.bind(fs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0, closed = 0, settled = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), read = handle.readFile.bind(handle), close = handle.close.bind(handle);
    handle.readFile = (async (...input: Parameters<typeof handle.readFile>) => {
      entered++;
      if (String(args[0]).endsWith('/a')) { throw new Error('READ_FAILED'); }
      await gate;
      return read(...input);
    }) as typeof handle.readFile;
    handle.close = async () => { await close(); closed++; };
    return handle;
  });
  syncBuiltinESMExports();
  const work = workspaceFingerprint(root, join(root, 'data'));
  const result = work.then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await vi.waitFor(() => expect(entered).toBe(4), { timeout: 500, interval: 10 });
    expect(settled).toBe(false);
  } finally { release(); await result; }
  expect((await result)?.message).toBe('READ_FAILED');
  expect(closed).toBe(4);
});

it('rehashes changed bytes and symbolic link targets while excluding private and generated paths', async () => {
  await fs.writeFile(join(root, 'source.ts'), 'first');
  for (const name of ['.env', '.npmrc', 'key.pem']) { await fs.writeFile(join(root, name), 'excluded'); }
  await fs.mkdir(join(root, 'node_modules'));
  await fs.writeFile(join(root, 'node_modules', 'ignored'), 'excluded');
  const first = await workspaceFingerprint(root, join(root, 'data'));
  await fs.writeFile(join(root, '.env'), 'changed-secret');
  expect(await workspaceFingerprint(root, join(root, 'data'))).toBe(first);
  await fs.writeFile(join(root, 'source.ts'), 'other');
  const other = await workspaceFingerprint(root, join(root, 'data'));
  expect(other).not.toBe(first);
  if (process.platform !== 'win32') {
    await fs.symlink('source.ts', join(root, 'link'));
    const linked = await workspaceFingerprint(root, join(root, 'data'));
    await fs.unlink(join(root, 'link'));
    await fs.symlink('absent', join(root, 'link'));
    expect(await workspaceFingerprint(root, join(root, 'data'))).not.toBe(linked);
  }
});
