/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { acquireDataLock } from '../runtime/execution-lock.js';
import { assertPublicValue } from '../tasks/task-state.js';

export class LocalState {
  readonly root: string;
  constructor(private readonly dataDir: string) { this.root = resolve(dataDir, 'state'); }

  private file(name: string): string {
    if (!/^[a-z0-9-]{1,100}$/.test(name)) { throw new Error('Invalid state name'); }
    return join(this.root, `${name}.json`);
  }

  private async directory(create = false): Promise<void> {
    if (create) { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Unsafe state directory'); }
  }

  async read<T>(name: string, schema: ZodType<T>, fallback?: T): Promise<T> {
    const file = this.file(name);
    try {
      await this.directory();
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink > 1 || info.size > 16 * 1024 * 1024) { throw new Error('Unsafe or oversized state file'); }
        return schema.parse(JSON.parse(await handle.readFile('utf8')));
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) { return structuredClone(fallback); }
      throw error;
    }
  }

  async update<T>(name: string, schema: ZodType<T>, fallback: T | undefined, mutate: (value: T) => T): Promise<T> {
    await this.directory(true);
    const release = await acquireDataLock(this.dataDir, `state:${name}`);
    try {
      const next = schema.parse(mutate(await this.read(name, schema, fallback)));
      assertPublicValue(next);
      await this.write(name, next);
      return next;
    } finally { await release(); }
  }

  private async write(name: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) { throw new Error('State size limit exceeded'); }
    const temporary = join(this.root, `${name}-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file(name));
    } finally { await rm(temporary, { force: true }); }
  }

  async names(prefix: string): Promise<string[]> {
    try { await this.directory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
    return (await readdir(this.root)).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).map((name) => name.slice(0, -5));
  }
}
