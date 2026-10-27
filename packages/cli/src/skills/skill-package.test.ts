/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractSkill } from './skill-package.js';
import { SkillInstaller } from './installation/skill-installer.js';

describe('skill ZIP installation with real adm-zip', () => {
  let root: string;

  function install(buffer: Buffer) {
    return new SkillInstaller().installArchiveSkill('test-skill', buffer, {
      agents: [],
      projectAgents: [],
      customPath: root,
    });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-skill-zip-'));
    vi.stubEnv('DEVECO_CLI_DATA_DIR', path.join(root, 'data'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('extracts nested UTF-8 names, binary files and empty directories', async () => {
    const zip = new AdmZip();
    const files = new Map([
      ['SKILL.md', Buffer.from('# Test skill\n中文说明')],
      ['references/中文.md', Buffer.from('Nested documentation')],
      ['assets/data.bin', Buffer.from([0, 255, 128, 1])],
      ['empty.txt', Buffer.alloc(0)],
    ]);
    for (const [name, content] of files) {
      zip.addFile(name, content);
    }
    zip.addFile('empty-dir/', Buffer.alloc(0));

    expect(
      (await install(zip.toBuffer())).every((result) => result.success)
    ).toBe(true);

    for (const [name, content] of files) {
      expect(await fs.readFile(path.join(root, 'test-skill', name))).toEqual(
        content
      );
    }
    expect(
      (await fs.stat(path.join(root, 'test-skill/empty-dir'))).isDirectory()
    ).toBe(true);
  });

  it('rejects extraction through a destination directory symlink (CVE-2026-76845)', async () => {
    const outside = path.join(root, 'outside');
    const destination = path.join(root, 'skills/test-skill');
    await fs.mkdir(outside);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'original');
    await fs.symlink(
      outside,
      path.join(destination, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const zip = new AdmZip();
    zip.addFile('linked/keep.txt', Buffer.from('overwritten'));

    await expect(
      extractSkill(zip.toBuffer(), path.join(root, 'skills'), 'test-skill')
    ).rejects.toThrow(/file in the way/i);
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe(
      'original'
    );
  });

  it.each([0, 8])(
    'does not allocate a forged 4 GiB size with compression method %i (CVE-2026-39244)',
    async (method) => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from('small content'));
      zip.getEntry('SKILL.md')!.header.method = method;
      const buffer = zip.toBuffer();
      const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      buffer.writeUInt32LE(0xfffffff0, central + 24);
      buffer.writeUInt32LE(0xfffffff0, 22);
      const alloc = Buffer.alloc;
      const allocation = vi
        .spyOn(Buffer, 'alloc')
        .mockImplementation((size) => {
          // 限制单次内存分配，保护测试进程。
          if (size > 1024 * 1024) {
            throw new Error('Unsafe allocation attempted');
          }
          return alloc(size);
        });

      try {
        await extractSkill(buffer, root, 'test-skill');
        expect(
          await fs.readFile(path.join(root, 'test-skill/SKILL.md'), 'utf8')
        ).toBe('small content');
      } finally {
        expect(
          allocation.mock.calls.every(([size]) => size <= 1024 * 1024)
        ).toBe(true);
      }
    }
  );
});
