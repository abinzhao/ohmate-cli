/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDirectory, removeDirectory } from './directory-installation.js';

describe('transactional Skill directory installation', () => {
  let root: string;
  let source: string;
  let destination: string;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-directory-'));
    source = path.join(root, 'source', 'skill');
    destination = path.join(root, 'agent', 'skill');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), 'new');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function oldInstall() {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'SKILL.md'), 'old');
  }

  it('preserves an ordinary directory unless force is set and skips a correct link', async () => {
    await oldInstall();
    expect(await installDirectory(source, destination)).toMatchObject({
      skipped: true,
      reason: 'already-exists',
    });
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      'old'
    );
    await fs.writeFile(path.join(destination, 'local.txt'), 'local edits');
    expect(await installDirectory(source, destination, true)).toMatchObject({
      mode: 'symlink',
    });
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      'new'
    );
    await expect(
      fs.lstat(path.join(destination, 'local.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await installDirectory(source, destination)).toMatchObject({
      skipped: true,
      reason: 'correct-link',
    });
    const original = await fs.lstat(destination);
    expect(await installDirectory(source, destination, true)).toMatchObject({
      reason: 'correct-link',
    });
    expect((await fs.lstat(destination)).ino).toBe(original.ino);
  });

  it('preserves an ordinary file unless force is set', async () => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'local file');
    expect(await installDirectory(source, destination)).toMatchObject({
      reason: 'already-exists',
      skipped: true,
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('local file');
    expect(await installDirectory(source, destination, true)).toMatchObject({
      mode: 'symlink',
    });
    expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      'new'
    );
  });

  it.each(['working', 'broken'])(
    'preserves an incorrect %s link until force is set',
    async (kind) => {
      const other = path.join(root, 'other');
      if (kind === 'working') {
        await fs.mkdir(other);
        await fs.writeFile(path.join(other, 'local.txt'), 'unrelated');
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.symlink(other, destination, linkType);
      const original = await fs.readlink(destination);
      expect(await installDirectory(source, destination)).toMatchObject({
        skipped: true,
        reason: 'already-exists',
      });
      expect(await fs.readlink(destination)).toBe(original);
      expect(await installDirectory(source, destination, true)).toMatchObject({
        mode: 'symlink',
      });
      expect(await fs.realpath(destination)).toBe(await fs.realpath(source));
      if (kind === 'working') {
        expect(await fs.readFile(path.join(other, 'local.txt'), 'utf8')).toBe(
          'unrelated'
        );
      }
    }
  );

  it('falls back to a complete copy and reports the link failure', async () => {
    vi.spyOn(fs, 'symlink').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EPERM' })
    );
    expect(await installDirectory(source, destination)).toMatchObject({
      mode: 'copy',
      fallbackReason: 'EPERM',
    });
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      'new'
    );
  });

  it('preserves the old directory when both preparation methods fail', async () => {
    await oldInstall();
    vi.spyOn(fs, 'symlink').mockRejectedValue(new Error('link unavailable'));
    vi.spyOn(fs, 'cp').mockRejectedValue(new Error('copy unavailable'));
    await expect(installDirectory(source, destination, true)).rejects.toThrow(
      'copy unavailable'
    );
    expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      'old'
    );
    expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(
      'new'
    );
  });

  it('rolls back if publishing the prepared replacement fails', async () => {
    await oldInstall();
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.install-') && String(to) === destination) {
        throw new Error('publication failed');
      }
      return rename(from, to);
    });
    await expect(installDirectory(source, destination, true)).rejects.toThrow(
      'publication failed'
    );
    expect(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      'old'
    );
    expect(await fs.readdir(path.dirname(destination))).toEqual(['skill']);
  });

  it('skips the same directory even through a parent alias', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(path.dirname(source), alias, linkType);
    expect(
      await installDirectory(source, path.join(alias, 'skill'))
    ).toMatchObject({ reason: 'same-source' });
    expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(
      'new'
    );
  });

  it('creates a working link beneath a parent directory alias', async () => {
    const realParent = path.join(root, 'real-agent');
    await fs.mkdir(realParent);
    await fs.symlink(realParent, path.dirname(destination), linkType);
    await installDirectory(source, destination);
    expect(await fs.realpath(destination)).toBe(await fs.realpath(source));
    expect(await installDirectory(source, destination)).toMatchObject({
      skipped: true,
      reason: 'correct-link',
    });
  });

  it('refuses overlapping directories before deleting any content', async () => {
    await expect(
      installDirectory(source, path.join(source, 'nested'))
    ).rejects.toThrow('overlap');
    await expect(
      installDirectory(source, path.dirname(source), true)
    ).rejects.toThrow('overlap');
    expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(
      'new'
    );
  });

  it('removes a broken link using lstat', async () => {
    await installDirectory(source, destination);
    await fs.rm(source, { recursive: true });
    expect(await removeDirectory(destination)).toMatchObject({
      success: true,
    });
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'uses relative links that survive moving the tree',
    async () => {
      await installDirectory(source, destination);
      expect(path.isAbsolute(await fs.readlink(destination))).toBe(false);
      const moved = `${root}-moved`;
      await fs.rename(root, moved);
      root = moved;
      expect(
        await fs.readFile(path.join(root, 'agent/skill/SKILL.md'), 'utf8')
      ).toBe('new');
    }
  );
});
