/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as files from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readJournalFile, writeJournalCheckpoint } from './journal-files.js';

vi.mock('node:fs/promises', async (actual) => ({ ...await actual<typeof import('node:fs/promises')>() }));
let root: string;
beforeEach(async () => { root = await files.mkdtemp(join(tmpdir(), 'ohmate-journal-read-')); });
afterEach(async () => { vi.restoreAllMocks(); await files.rm(root, { recursive: true, force: true }); });

it('reads the entire bounded file when the filesystem returns short reads', async () => {
  const file = join(root, 'record.json'), bytes = Buffer.from('{"summary":"测试完整短读取"}');
  await files.writeFile(file, bytes, { mode: 0o600 });
  const open = files.open;
  vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === file && typeof args[1] === 'number' && (args[1] & constants.O_NONBLOCK) !== 0) {
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.min(length, 3), position)) as typeof handle.read;
    }
    return handle;
  });
  expect(await readJournalFile(file, 1024)).toEqual(bytes);
});

it('refuses growth after the initial file identity was captured', async () => {
  const file = join(root, 'record.json');
  await files.writeFile(file, 'first', { mode: 0o600 });
  const open = files.open;
  vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === file && typeof args[1] === 'number') {
      const read = handle.read.bind(handle);
      let first = true;
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (first) { first = false; await files.appendFile(file, '-changed'); }
        return read(buffer, offset, length, position);
      }) as typeof handle.read;
    }
    return handle;
  });
  await expect(readJournalFile(file, 1024)).rejects.toThrow('JOURNAL_UNSAFE');
});
it('refuses an oversized checkpoint before replacing the durable commit or creating a temporary file', async () => {
  const file = join(root, 'checkpoint.json');
  await files.writeFile(file, '{"committed":true}', { mode: 0o600 });
  await expect(writeJournalCheckpoint(root, { oversized: 'x'.repeat(4096) })).rejects.toThrow('JOURNAL_LIMIT');
  expect(await files.readFile(file, 'utf8')).toBe('{"committed":true}');
  expect(await files.readdir(root)).toEqual(['checkpoint.json']);
});
