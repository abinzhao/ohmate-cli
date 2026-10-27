/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syncBundledSkillToExistingAgents,
  migrateSkillSymlinkIfVersionChanged,
  summarizeOperationResults,
} from './agents.js';

vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// 将包内 Skill 和 Agent 路径指定到测试专用目录。
vi.mock('./skill-package.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skill-package.js')>();
  return { ...actual, resolveBundledSkillDir: vi.fn() };
});
vi.mock('./agent-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-registry.js')>();
  return { ...actual, getNativeSkillsDir: vi.fn() };
});

vi.mock('../utils/cli-data-dir.js', () => ({
  getCliDataDir: vi.fn(),
}));

import { resolveBundledSkillDir } from './skill-package.js';
import { getNativeSkillsDir, getAgentEntry } from './agent-registry.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { SkillInstaller } from './installation/skill-installer.js';

const linkType = () => (process.platform === 'win32' ? 'junction' : 'dir');

describe('syncBundledSkillToExistingAgents', () => {
  let root: string;
  let sourceDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-sync-'));
    vi.mocked(os.homedir).mockReturnValue(path.join(root, 'home'));
    vi.mocked(getCliDataDir).mockReturnValue(path.join(root, 'data'));
    vi.mocked(getNativeSkillsDir).mockImplementation(
      (agent: string, project?: string) =>
        project
          ? path.join(project, getAgentEntry(agent).skillsDir)
          : path.join(root, agent, 'skills')
    );
    sourceDir = path.join(root, 'source', 'deveco-cli');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# bundled');
    vi.mocked(resolveBundledSkillDir).mockReturnValue(sourceDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves an old copy and its local edits during automatic migration', async () => {
    const agentSkillsDir = path.join(root, 'opencode', 'skills');
    const linkPath = path.join(agentSkillsDir, 'deveco-cli');
    await fs.mkdir(path.join(linkPath, 'stale'), { recursive: true });
    await fs.writeFile(path.join(linkPath, 'SKILL.md'), '# old version');
    vi.mocked(getNativeSkillsDir).mockReturnValue(agentSkillsDir);

    await syncBundledSkillToExistingAgents();
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(linkPath, 'SKILL.md'), 'utf8')).toBe(
      '# old version'
    );
  });

  it('skips an already-correct link', async () => {
    const agentSkillsDir = path.join(root, 'opencode', 'skills');
    const linkPath = path.join(agentSkillsDir, 'deveco-cli');
    await fs.mkdir(agentSkillsDir, { recursive: true });
    await fs.symlink(sourceDir, linkPath, linkType());
    const original = await fs.lstat(linkPath);
    vi.mocked(getNativeSkillsDir).mockReturnValue(agentSkillsDir);

    await syncBundledSkillToExistingAgents();
    expect(await fs.lstat(linkPath)).toMatchObject({
      ino: original.ino,
      ctimeMs: original.ctimeMs,
    });
    expect(await fs.realpath(linkPath)).toBe(await fs.realpath(sourceDir));
  });

  it('skips when deveco-cli is not installed (no entry)', async () => {
    const agentSkillsDir = path.join(root, 'opencode', 'skills'); // 不创建
    vi.mocked(getNativeSkillsDir).mockReturnValue(agentSkillsDir);

    await syncBundledSkillToExistingAgents();
    await expect(
      fs.lstat(path.join(agentSkillsDir, 'deveco-cli'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['project', 'custom'])(
    'keeps %s copies until explicit init',
    async (scope) => {
      const targets =
        scope === 'project'
          ? {
              agents: [],
              projectAgents: [{ project: root, agent: 'claude-code' }],
            }
          : {
              agents: [],
              projectAgents: [],
              customPath: path.join(root, 'custom'),
            };
      const installed =
        scope === 'project'
          ? path.join(root, '.claude/skills/deveco-cli')
          : path.join(root, 'custom/deveco-cli');
      const link = vi
        .spyOn(fs, 'symlink')
        .mockRejectedValue(new Error('link unavailable'));
      await new SkillInstaller().installBundledSkill(sourceDir, targets);
      link.mockRestore();
      await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# updated');
      await syncBundledSkillToExistingAgents();
      expect((await fs.lstat(installed)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8')).toBe(
        '# bundled'
      );
      await new SkillInstaller().installBundledSkill(sourceDir, targets, true);
      expect((await fs.lstat(installed)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8')).toBe(
        '# updated'
      );
    }
  );

  it('retains broken links and ordinary files during automatic migration', async () => {
    const skills = path.join(root, 'opencode/skills');
    const installed = path.join(skills, 'deveco-cli');
    await fs.mkdir(skills, { recursive: true });
    await fs.symlink(path.join(root, 'missing-source'), installed, linkType());
    const original = await fs.readlink(installed);
    vi.mocked(getNativeSkillsDir).mockReturnValue(skills);
    await syncBundledSkillToExistingAgents();
    expect(await fs.readlink(installed)).toBe(original);
    await fs.rm(installed);
    await fs.writeFile(installed, 'ordinary file');
    await syncBundledSkillToExistingAgents();
    expect(await fs.readFile(installed, 'utf8')).toBe('ordinary file');
  });
});

describe('migrateSkillSymlinkIfVersionChanged', () => {
  let root: string;
  let dataDir: string;
  let sourceDir: string;
  let agentSkillsDir: string;
  let markerPath: string;
  let origVersion: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-gate-'));
    vi.mocked(os.homedir).mockReturnValue(path.join(root, 'home'));
    dataDir = path.join(root, 'data');
    sourceDir = path.join(root, 'source', 'deveco-cli');
    agentSkillsDir = path.join(root, 'opencode', 'skills');
    markerPath = path.join(dataDir, 'skills', 'migration-version');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# bundled');
    vi.mocked(getCliDataDir).mockReturnValue(dataDir);
    origVersion = process.env.npm_package_version;
    process.env.npm_package_version = '1.0.0-test';
    vi.mocked(resolveBundledSkillDir).mockReturnValue(sourceDir);
    vi.mocked(getNativeSkillsDir).mockReturnValue(agentSkillsDir);
  });

  afterEach(async () => {
    if (origVersion === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = origVersion;
    }
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves an existing directory and writes the marker when missing', async () => {
    const migration = vi.spyOn(SkillInstaller.prototype, 'migrateBundledSkill');
    await fs.mkdir(path.join(agentSkillsDir, 'deveco-cli'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(agentSkillsDir, 'deveco-cli', 'SKILL.md'),
      '# bundled'
    );
    await migrateSkillSymlinkIfVersionChanged();
    expect(
      (await fs.lstat(path.join(agentSkillsDir, 'deveco-cli'))).isSymbolicLink()
    ).toBe(false);
    expect(migration).toHaveBeenCalledOnce();
    expect(await fs.readFile(markerPath, 'utf-8')).toBe('1.0.0-test');
  });

  it('skips when marker == current version (no migration)', async () => {
    const migration = vi.spyOn(SkillInstaller.prototype, 'migrateBundledSkill');
    await fs.mkdir(path.join(dataDir, 'skills'), { recursive: true });
    await fs.writeFile(markerPath, '1.0.0-test', 'utf-8');
    await fs.mkdir(path.join(agentSkillsDir, 'deveco-cli'), {
      recursive: true,
    });
    await migrateSkillSymlinkIfVersionChanged();
    expect(migration).not.toHaveBeenCalled();
    expect(
      (await fs.lstat(path.join(agentSkillsDir, 'deveco-cli'))).isSymbolicLink()
    ).toBe(false);
  });

  it('preserves old copies when the saved CLI version changes', async () => {
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, '0.9.0-test');
    const installed = path.join(agentSkillsDir, 'deveco-cli');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'SKILL.md'), '# old version');
    await migrateSkillSymlinkIfVersionChanged();
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8')).toBe(
      '# old version'
    );
    expect(await fs.readFile(markerPath, 'utf8')).toBe('1.0.0-test');
  });

  it('does not prepare replacements for existing copies and reports how to replace them', async () => {
    const installed = path.join(agentSkillsDir, 'deveco-cli');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'SKILL.md'), '# old version');
    const link = vi
      .spyOn(fs, 'symlink')
      .mockRejectedValue(new Error('link unavailable'));
    const copy = vi
      .spyOn(fs, 'cp')
      .mockRejectedValue(new Error('copy unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await migrateSkillSymlinkIfVersionChanged();
    expect(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8')).toBe(
      '# old version'
    );
    expect(link).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(warning.mock.calls.flat().join('\n')).toContain(
      'devecocli init --force'
    );
    expect(await fs.readFile(markerPath, 'utf8')).toBe('1.0.0-test');
    link.mockRestore();
    copy.mockRestore();
    await migrateSkillSymlinkIfVersionChanged();
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
    expect(await fs.readFile(markerPath, 'utf8')).toBe('1.0.0-test');
  });

  it('does not write marker when sync throws (retry next time)', async () => {
    // resolveBundledSkillDir 抛错 → syncBundledSkillToExistingAgents 抛错 → 门控吞掉、不写 marker
    vi.mocked(resolveBundledSkillDir).mockImplementation(() => {
      throw new Error('source not found');
    });
    await migrateSkillSymlinkIfVersionChanged();
    expect(await fs.lstat(markerPath).catch(() => null)).toBeNull();
  });
});

describe('Skill operation output', () => {
  it.each([
    [
      { success: true, skipped: true, path: 'target', reason: 'correct-link' },
      'skipped: target',
    ],
    [
      { success: true, path: 'target', reason: 'shared-entity-updated' },
      'updated: target',
    ],
    [
      {
        success: true,
        skipped: true,
        path: 'target',
        reason: 'already-exists',
      },
      'skipped: target (already exists; use --force to replace)',
    ],
  ])(
    'renders operation status independently of installation mode',
    (result, expected) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        summarizeOperationResults([result]);
        expect(log.mock.calls.flat().join('\n')).toContain(expected);
      } finally {
        log.mockRestore();
      }
    }
  );
});
