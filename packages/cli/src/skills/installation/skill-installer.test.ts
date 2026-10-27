/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillInstaller } from './skill-installer.js';
import { getSkillStoreEntry } from './skill-store.js';
import type { InstallationTargets } from '../../types/skills.js';

describe('shared archive and bundled Skill installation', () => {
  let root: string;
  let targets: InstallationTargets;
  const installer = new SkillInstaller();
  const archive = (content: string) => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from(content));
    zip.addFile('references/example.md', Buffer.from(content));
    return zip.toBuffer();
  };
  const read = (entry: string) =>
    fs.readFile(path.join(root, entry, 'SKILL.md'), 'utf8');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-install-'));
    vi.stubEnv('DEVECO_CLI_DATA_DIR', path.join(root, 'data'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('USERPROFILE', path.join(root, 'home'));
    for (const key of [
      'CODEX_HOME',
      'XDG_CONFIG_HOME',
      'CLAUDE_CONFIG_DIR',
      'APPDATA',
      'FLATPAK_XDG_CONFIG_HOME',
    ]) {
      vi.stubEnv(key, '');
    }
    targets = {
      agents: [],
      projectAgents: [
        'claude-code',
        'qoder',
        'codex',
        'cursor',
        'universal',
      ].map((agent) => ({ project: root, agent })),
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('extracts shared content and deduplicates shared Agent destinations', async () => {
    const results = await installer.installArchiveSkill(
      'example',
      archive('first'),
      targets
    );
    expect(results).toHaveLength(4);
    for (const entry of [
      '.agents/skills/example',
      '.claude/skills/example',
      '.qoder/skills/example',
    ]) {
      expect(await read(entry)).toBe('first');
    }
    expect(
      (
        await fs.lstat(path.join(root, '.agents/skills/example'))
      ).isSymbolicLink()
    ).toBe(true);
    expect(await fs.realpath(path.join(root, '.agents/skills/example'))).toBe(
      await fs.realpath(getSkillStoreEntry('example', root))
    );
    expect(
      (
        await fs.lstat(path.join(root, '.claude/skills/example'))
      ).isSymbolicLink()
    ).toBe(true);
  });

  it('preserves shared content by default and refreshes every linked Agent only with force', async () => {
    await installer.installArchiveSkill('example', archive('first'), targets);
    await fs.writeFile(
      path.join(root, '.agents/skills/example/stale.txt'),
      'old'
    );
    const selected = {
      agents: [],
      projectAgents: [{ project: root, agent: 'codex' }],
    };
    const preserved = await installer.installArchiveSkill(
      'example',
      archive('ignored'),
      selected
    );
    expect(preserved).toMatchObject([
      { skipped: true, reason: 'correct-link' },
    ]);
    expect(await read('.qoder/skills/example')).toBe('first');
    expect(await read('.claude/skills/example')).toBe('first');
    expect(
      await fs.readFile(
        path.join(root, '.agents/skills/example/stale.txt'),
        'utf8'
      )
    ).toBe('old');
    const updated = await installer.installArchiveSkill(
      'example',
      archive('updated'),
      selected,
      true
    );
    expect(
      updated.some((result) => result.reason === 'shared-entity-updated')
    ).toBe(true);
    expect(await read('.qoder/skills/example')).toBe('updated');
    expect(await read('.claude/skills/example')).toBe('updated');
    await expect(
      fs.lstat(path.join(root, '.agents/skills/example/stale.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves custom-path content until force replaces it and removes stale files', async () => {
    const customTargets = {
      agents: [],
      projectAgents: [],
      customPath: path.join(root, 'custom'),
    };
    const results = await installer.installArchiveSkill(
      'example',
      archive('first'),
      customTargets
    );
    expect(results).toMatchObject([
      { success: true, reason: 'shared-entity-updated' },
    ]);
    const stale = path.join(customTargets.customPath, 'example/stale.txt');
    await fs.writeFile(stale, 'old');
    expect(
      await installer.installArchiveSkill(
        'example',
        archive('ignored'),
        customTargets
      )
    ).toMatchObject([{ skipped: true, reason: 'already-exists' }]);
    expect(await read('custom/example')).toBe('first');
    expect(await fs.readFile(stale, 'utf8')).toBe('old');
    await installer.installArchiveSkill(
      'example',
      archive('updated'),
      customTargets,
      true
    );
    expect(await read('custom/example')).toBe('updated');
    await expect(fs.lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps fallback copies independent while retaining the shared entity', async () => {
    vi.spyOn(fs, 'symlink').mockRejectedValue(new Error('link unavailable'));
    await installer.installArchiveSkill('example', archive('first'), targets);
    expect(
      (
        await fs.lstat(path.join(root, '.claude/skills/example'))
      ).isSymbolicLink()
    ).toBe(false);
    await fs.writeFile(
      path.join(getSkillStoreEntry('example', root), 'SKILL.md'),
      'updated'
    );
    expect(await read('.claude/skills/example')).toBe('first');
    await installer.installArchiveSkill(
      'example',
      archive('refreshed'),
      targets,
      true
    );
    expect(await read('.claude/skills/example')).toBe('refreshed');
    vi.restoreAllMocks();
    await installer.installArchiveSkill(
      'example',
      archive('linked'),
      targets,
      true
    );
    expect(
      (
        await fs.lstat(path.join(root, '.claude/skills/example'))
      ).isSymbolicLink()
    ).toBe(true);
    expect(await read('.claude/skills/example')).toBe('linked');
  });

  it('removes only the selected Agent entry and retains the shared entity', async () => {
    await installer.installArchiveSkill('example', archive('first'), targets);
    await installer.removeSkill('example', {
      agents: [],
      projectAgents: [{ project: root, agent: 'claude-code' }],
    });
    await expect(
      fs.lstat(path.join(root, '.claude/skills/example'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await read('.qoder/skills/example')).toBe('first');
    const removedShared = await installer.removeSkill('example', {
      agents: [],
      projectAgents: [{ project: root, agent: 'codex' }],
    });
    expect(removedShared[0]).toMatchObject({
      reason: expect.stringContaining('still used by'),
    });
    expect(await read('.agents/skills/example')).toBe('first');
  });

  it('retains a working shared entity if the new archive is invalid', async () => {
    await installer.installArchiveSkill('example', archive('first'), targets);
    const results = await installer.installArchiveSkill(
      'example',
      Buffer.from('invalid zip'),
      targets,
      true
    );
    expect(results).toHaveLength(3);
    expect(results.every((result) => !result.success && result.error)).toBe(
      true
    );
    expect(await read('.qoder/skills/example')).toBe('first');
  });

  it('continues to another scope when archive preparation fails', async () => {
    const blocked = path.join(root, 'blocked');
    await fs.writeFile(blocked, 'file instead of directory');
    const results = await installer.installArchiveSkill(
      'example',
      archive('ok'),
      {
        agents: [],
        projectAgents: [
          { project: blocked, agent: 'codex' },
          { project: root, agent: 'codex' },
        ],
      }
    );
    expect(results.map((result) => result.success)).toEqual([
      false,
      true,
      true,
    ]);
    expect(await read('.agents/skills/example')).toBe('ok');
  });

  it('does not create shared content when all bundled destinations are skipped', async () => {
    const source = path.join(root, 'package/skills/deveco-cli');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), 'bundled');
    const results = await installer.installBundledSkill(source, {
      agents: [],
      projectAgents: [{ project: root, agent: 'claude-code' }],
      explicitAgents: false,
    });
    expect(results).toMatchObject([{ skipped: true }]);
    await expect(fs.lstat(path.join(root, '.agents'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retains a shared bundled link when other Agent links reference that path', async () => {
    const shared = path.join(root, '.agents/skills/deveco-cli');
    const agent = path.join(root, '.qoder/skills/deveco-cli');
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, 'SKILL.md'), 'old bundled');
    await fs.mkdir(path.dirname(agent), { recursive: true });
    await fs.symlink(
      shared,
      agent,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const source = path.join(root, 'package/skills/deveco-cli');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), 'bundled');
    const sharedTarget = {
      agents: [],
      projectAgents: [{ project: root, agent: 'codex' }],
    };
    const skipped = await installer.installBundledSkill(source, sharedTarget);
    expect(skipped).toMatchObject([
      { skipped: true, reason: 'already-exists' },
    ]);
    expect(await read('.qoder/skills/deveco-cli')).toBe('old bundled');
    await installer.installBundledSkill(source, sharedTarget, true);
    expect(await read('.qoder/skills/deveco-cli')).toBe('bundled');
    expect(
      await installer.removeSkill('deveco-cli', sharedTarget)
    ).toMatchObject([{ reason: expect.stringContaining('still used by') }]);
    expect(await read('.qoder/skills/deveco-cli')).toBe('bundled');
    expect(
      (
        await fs.lstat(path.join(root, '.agents/skills/deveco-cli'))
      ).isSymbolicLink()
    ).toBe(true);
  });

  it('preserves an existing Agent copy and its legacy entries until force is set', async () => {
    const source = path.join(root, 'package/skills/deveco-cli');
    const installed = path.join(root, '.trae/skills/deveco-cli');
    const legacy = path.join(root, '.trae-cn/skills/deveco-cli');
    for (const entry of [source, installed, legacy]) {
      await fs.mkdir(entry, { recursive: true });
      await fs.writeFile(
        path.join(entry, 'SKILL.md'),
        entry === source ? 'bundled' : 'local edits'
      );
    }
    const selected = {
      agents: [],
      projectAgents: [{ project: root, agent: 'trae-cn' }],
    };
    const results = await installer.installBundledSkill(source, selected);
    expect(results).toContainEqual(
      expect.objectContaining({
        path: installed,
        skipped: true,
        reason: 'already-exists',
      })
    );
    expect(await read('.trae/skills/deveco-cli')).toBe('local edits');
    expect(await read('.trae-cn/skills/deveco-cli')).toBe('local edits');
    await installer.installBundledSkill(source, selected, true);
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await read('.trae/skills/deveco-cli')).toBe('bundled');
    await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses stored content to add a new Agent without force', async () => {
    const selected = (agent: string) => ({
      agents: [],
      projectAgents: [{ project: root, agent }],
    });
    await installer.installArchiveSkill(
      'example',
      archive('original'),
      selected('codex')
    );
    const store = getSkillStoreEntry('example', root);
    const original = await fs.lstat(store);
    const results = await installer.installArchiveSkill(
      'example',
      archive('ignored'),
      selected('qoder')
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(await read('.qoder/skills/example')).toBe('original');
    expect(await fs.realpath(path.join(root, '.qoder/skills/example'))).toBe(
      await fs.realpath(store)
    );
    expect((await fs.lstat(store)).ino).toBe(original.ino);
  });

  it('preserves all ordinary copies without creating an unused entity, then upgrades with force', async () => {
    const paths = ['.agents/skills/example', '.claude/skills/example'];
    for (const entry of paths) {
      await fs.mkdir(path.join(root, entry), { recursive: true });
      await fs.writeFile(path.join(root, entry, 'SKILL.md'), 'local edits');
    }
    const selected = {
      agents: [],
      projectAgents: [{ project: root, agent: 'claude-code' }],
    };
    const skipped = await installer.installArchiveSkill(
      'example',
      archive('new'),
      selected
    );
    expect(skipped).toHaveLength(2);
    expect(skipped.every((result) => result.reason === 'already-exists')).toBe(
      true
    );
    await expect(
      fs.lstat(getSkillStoreEntry('example', root))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    for (const entry of paths) {
      expect(await read(entry)).toBe('local edits');
    }
    await installer.installArchiveSkill(
      'example',
      archive('new'),
      selected,
      true
    );
    for (const entry of paths) {
      expect((await fs.lstat(path.join(root, entry))).isSymbolicLink()).toBe(
        true
      );
      expect(await read(entry)).toBe('new');
    }
  });

  it('isolates global content and two project stores', async () => {
    const other = path.join(root, 'other-project');
    const selected = (project: string) => ({
      agents: [],
      projectAgents: [{ project, agent: 'codex' }],
    });
    await installer.installArchiveSkill(
      'example',
      archive('one'),
      selected(root)
    );
    await installer.installArchiveSkill(
      'example',
      archive('two'),
      selected(other)
    );
    await installer.installArchiveSkill('example', archive('global'), {
      agents: ['codex'],
      projectAgents: [],
    });
    await installer.installArchiveSkill(
      'example',
      archive('changed'),
      selected(root),
      true
    );
    expect(
      await fs.readFile(
        path.join(getSkillStoreEntry('example', root), 'SKILL.md'),
        'utf8'
      )
    ).toBe('changed');
    expect(
      await fs.readFile(
        path.join(getSkillStoreEntry('example', other), 'SKILL.md'),
        'utf8'
      )
    ).toBe('two');
    expect(
      await fs.readFile(
        path.join(getSkillStoreEntry('example'), 'SKILL.md'),
        'utf8'
      )
    ).toBe('global');
  });

  it('rejects an invalid entity until force replaces it without touching its external target', async () => {
    const store = getSkillStoreEntry('example', root);
    const external = path.join(root, 'external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'SKILL.md'), 'external');
    await fs.mkdir(path.dirname(store), { recursive: true });
    await fs.symlink(
      external,
      store,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const results = await installer.installArchiveSkill(
      'example',
      archive('new'),
      targets
    );
    expect(
      results.every(
        (result) => !result.success && result.error?.includes('--force')
      )
    ).toBe(true);
    await expect(
      fs.lstat(path.join(root, '.agents/skills/example'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await installer.installArchiveSkill(
      'example',
      archive('new'),
      targets,
      true
    );
    expect((await fs.lstat(store)).isSymbolicLink()).toBe(false);
    expect(await read('.agents/skills/example')).toBe('new');
    expect(await fs.readFile(path.join(external, 'SKILL.md'), 'utf8')).toBe(
      'external'
    );
  });

  it('rejects source overlap before replacing the entity', async () => {
    const store = getSkillStoreEntry('example', root);
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), 'keep');
    await fs.mkdir(path.join(root, '.agents'));
    await fs.symlink(
      path.dirname(store),
      path.join(root, '.agents/skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const results = await installer.installArchiveSkill(
      'example',
      archive('new'),
      targets,
      true
    );
    expect(
      results.every(
        (result) => !result.success && result.error?.includes('overlap')
      )
    ).toBe(true);
    expect(await fs.readFile(path.join(store, 'SKILL.md'), 'utf8')).toBe(
      'keep'
    );
  });

  it('rolls back a failed entity publication before changing Agent content', async () => {
    await installer.installArchiveSkill('example', archive('keep'), targets);
    const store = getSkillStoreEntry('example', root);
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.extract-') && String(to) === store) {
        throw new Error('publication denied');
      }
      await rename(from, to);
    });
    const results = await installer.installArchiveSkill(
      'example',
      archive('new'),
      targets,
      true
    );
    expect(results.every((result) => !result.success)).toBe(true);
    expect(await read('.agents/skills/example')).toBe('keep');
    expect(await read('.qoder/skills/example')).toBe('keep');
  });

  it('refuses redirected store parents during force updates and removal', async () => {
    const external = path.join(root, 'outside-store');
    const storeRoot = path.dirname(getSkillStoreEntry('example', root));
    await fs.mkdir(path.join(external, 'example'), { recursive: true });
    await fs.writeFile(path.join(external, 'example/SKILL.md'), 'outside');
    await fs.mkdir(path.dirname(storeRoot), { recursive: true });
    await fs.symlink(
      external,
      storeRoot,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const installed = await installer.installArchiveSkill(
      'example',
      archive('new'),
      targets,
      true
    );
    expect(
      installed.every(
        (result) => !result.success && result.error?.includes('redirects')
      )
    ).toBe(true);
    const removed = await installer.removeSkill('example', targets);
    expect(
      removed.some(
        (result) => !result.success && result.error?.includes('redirects')
      )
    ).toBe(true);
    expect(
      await fs.readFile(path.join(external, 'example/SKILL.md'), 'utf8')
    ).toBe('outside');
  });
});
