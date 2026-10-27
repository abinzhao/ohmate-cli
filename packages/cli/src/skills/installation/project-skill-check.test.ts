/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSkillChecker } from './project-skill-check.js';
import * as skillPackage from '../skill-package.js';

describe('read-only project bundled Skill checks', () => {
  let root: string;
  let source: string;
  let checker: ProjectSkillChecker;
  let warn: ReturnType<typeof vi.spyOn>;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const entry = (relative: string) => path.join(root, relative, 'deveco-cli');
  const output = () => warn.mock.calls.flat().join('\n');
  async function link(relative: string, target: string) {
    const destination = entry(relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.symlink(target, destination, linkType);
    return destination;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-skill-'));
    source = await fs.realpath(skillPackage.resolveBundledSkillDir());
    checker = new ProjectSkillChecker();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('silently preserves absent entries, ordinary files/copies and correct links', async () => {
    await fs.mkdir(entry('.agents/skills'), { recursive: true });
    await fs.writeFile(path.join(entry('.agents/skills'), 'SKILL.md'), 'local');
    await fs.mkdir(path.dirname(entry('.claude/skills')), { recursive: true });
    await fs.writeFile(entry('.claude/skills'), 'file');
    const correct = await link('.qoder/skills', source);
    const original = await fs.lstat(correct);
    await checker.warnInvalidBundledLinks(root);
    expect(warn).not.toHaveBeenCalled();
    expect(
      await fs.readFile(path.join(entry('.agents/skills'), 'SKILL.md'), 'utf8')
    ).toBe('local');
    expect((await fs.lstat(correct)).ino).toBe(original.ino);
    await expect(
      fs.lstat(path.join(root, '.deveco-cli'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports broken and stale links once with the actual project repair command, without changing them', async () => {
    const old = path.join(root, 'old-package');
    await fs.mkdir(old);
    await fs.writeFile(path.join(old, 'SKILL.md'), 'old');
    const broken = await link('.agents/skills', path.join(root, 'missing'));
    const stale = await link('.claude/skills', old);
    const original = await Promise.all([
      fs.readlink(broken),
      fs.readlink(stale),
    ]);
    await checker.warnInvalidBundledLinks(root);
    expect(output()).toContain(broken);
    expect(output()).toContain('broken link');
    expect(output()).toContain(`points to ${await fs.realpath(old)}`);
    expect(output()).toContain(
      `devecocli init --project '${await fs.realpath(root)}' -f`
    );
    expect(output().match(/Run:/g)).toHaveLength(1);
    expect(output()).toContain('local edits');
    expect(
      await Promise.all([fs.readlink(broken), fs.readlink(stale)])
    ).toEqual(original);
    await expect(
      fs.lstat(path.join(root, '.deveco-cli'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks known entrances even without globally detected Agents and ignores market Skills', async () => {
    const destination = await link('data/skills', path.join(root, 'missing'));
    const market = path.join(root, '.agents/skills/other');
    await fs.mkdir(path.dirname(market), { recursive: true });
    await fs.symlink(path.join(root, 'missing-market'), market, linkType);
    await checker.warnInvalidBundledLinks(root);
    expect(output()).toContain(destination);
    expect(output()).not.toContain(market);
  });

  it('deduplicates physical aliases and repeated checks only within the same checker process', async () => {
    const broken = await link('.agents/skills', path.join(root, 'missing'));
    await fs.mkdir(path.join(root, '.claude'));
    await fs.symlink(
      path.dirname(broken),
      path.join(root, '.claude/skills'),
      linkType
    );
    await checker.warnInvalidBundledLinks(root);
    const first = output();
    expect(first.split(broken).length - 1).toBe(1);
    await checker.warnInvalidBundledLinks(root);
    expect(output()).toBe(first);
    warn.mockClear();
    await new ProjectSkillChecker().warnInvalidBundledLinks(root);
    expect(output()).toContain(broken);
  });

  it('reports permission errors as failed checks without suggesting replacement', async () => {
    const destination = await link('.agents/skills', source);
    const realpath = fs.realpath;
    vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...options) => {
      if (String(target) === destination) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realpath(target, ...options);
    });
    await checker.warnInvalidBundledLinks(root);
    expect(output()).toContain('cannot check: permission denied');
    expect(output()).not.toContain('broken link');
    expect(output()).not.toContain('Run:');
  });

  it('reports unavailable package sources without throwing or installing anything', async () => {
    vi.spyOn(skillPackage, 'resolveBundledSkillDir').mockReturnValue(
      path.join(root, 'unavailable')
    );
    await expect(
      checker.warnInvalidBundledLinks(root)
    ).resolves.toBeUndefined();
    expect(output()).toContain('Cannot check project Skill links');
    expect(output()).not.toContain('Run:');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('reports a real link cycle and preserves the link', async () => {
    const destination = entry('.agents/skills');
    await link('.agents/skills', destination);
    const original = await fs.readlink(destination);
    await checker.warnInvalidBundledLinks(root);
    expect(output()).toContain('broken link');
    expect(await fs.readlink(destination)).toBe(original);
  });
});
