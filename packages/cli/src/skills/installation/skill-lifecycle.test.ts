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
import { getAgentNames } from '../agent-registry.js';
import type { InstallationTargets } from '../../types/skills.js';

describe('shared Skill lifecycle and legacy cleanup', () => {
  let root: string;
  let home: string;
  let project: string;
  let source: string;
  const installer = new SkillInstaller();
  const zip = () => {
    const archive = new AdmZip();
    archive.addFile('SKILL.md', Buffer.from('archive'));
    return archive.toBuffer();
  };
  const exists = async (entry: string) =>
    !!(await fs.lstat(entry).catch(() => undefined));
  const copy = async (entry: string, text = 'old') => {
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'SKILL.md'), text);
  };
  const targets = (agents: string[], local = false): InstallationTargets =>
    local
      ? {
          agents: [],
          projectAgents: agents.map((agent) => ({ agent, project })),
        }
      : { agents, projectAgents: [] };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lifecycle-'));
    vi.stubEnv('DEVECO_CLI_DATA_DIR', path.join(root, 'data'));
    home = path.join(root, 'home');
    project = path.join(root, 'project');
    source = path.join(root, 'package/skills/deveco-cli');
    await fs.mkdir(home);
    await fs.mkdir(project);
    await copy(source, 'bundled');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    for (const variable of [
      'XDG_CONFIG_HOME',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'GROK_HOME',
      'HERMES_HOME',
      'VIBE_HOME',
      'APPDATA',
      'FLATPAK_XDG_CONFIG_HOME',
    ]) {
      vi.stubEnv(variable, '');
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    'removes all archive entries including the shared entity (project=%s)',
    async (local) => {
      const base = local ? project : home;
      await installer.installArchiveSkill(
        'x',
        zip(),
        targets(['codex', 'claude-code'], local)
      );
      await installer.removeSkill('x', targets(getAgentNames(), local));
      expect(await exists(path.join(base, '.agents/skills/x'))).toBe(false);
      expect(await exists(path.join(base, '.claude/skills/x'))).toBe(false);
    }
  );

  it.each([false, true])(
    'removes all bundled links while preserving the package (project=%s)',
    async (local) => {
      const base = local ? project : home;
      await installer.installBundledSkill(
        source,
        targets(['codex', 'claude-code'], local)
      );
      await installer.removeSkill(
        'deveco-cli',
        targets(getAgentNames(), local)
      );
      expect(await exists(path.join(base, '.agents/skills/deveco-cli'))).toBe(
        false
      );
      expect(await exists(path.join(base, '.claude/skills/deveco-cli'))).toBe(
        false
      );
      expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(
        'bundled'
      );
    }
  );

  it('removes the shared entity for Codex when no other agent uses it', async () => {
    await installer.installArchiveSkill('x', zip(), targets(['codex']));
    await installer.removeSkill('x', targets(['codex']));
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(false);
  });

  it('names a remaining global shared user without reporting not found', async () => {
    await fs.mkdir(path.join(home, '.pi/agent'), { recursive: true });
    await installer.installArchiveSkill('x', zip(), targets(['codex']));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await installer.removeSkill('x', targets(['codex']));
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain(
      'is kept: still used by Pi'
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('not found');
  });

  it('retains a shared entity used by an independent agent link', async () => {
    await installer.installArchiveSkill(
      'x',
      zip(),
      targets(['codex', 'claude-code'])
    );
    await installer.removeSkill('x', targets(['codex']));
    expect(
      await fs.readFile(path.join(home, '.claude/skills/x/SKILL.md'), 'utf8')
    ).toBe('archive');
    await installer.removeSkill('x', targets(['claude-code']));
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(false);
  });

  it('does not retain the shared entity for an unrelated agent copy', async () => {
    await installer.installArchiveSkill('x', zip(), targets(['codex']));
    await copy(path.join(home, '.claude/skills/x'), 'independent');
    await installer.removeSkill('x', targets(['codex']));
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(false);
    expect(
      await fs.readFile(path.join(home, '.claude/skills/x/SKILL.md'), 'utf8')
    ).toBe('independent');
  });

  it('reports not found only if neither current nor legacy entries exist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await installer.removeSkill('x', targets(['codex']));
    expect(log.mock.calls.flat().join('\n')).toContain('not found');
  });

  it.each([
    ['cursor', '.cursor/skills'],
    ['opencode', '.config/opencode/skills'],
    ['amp', '.config/agents/skills'],
  ])(
    'refreshes %s global entrance during add and remove',
    async (agent, relative) => {
      const native = path.join(home, relative, 'x');
      const canonical = path.join(home, '.agents/skills/x');
      await copy(native, 'existing independent copy');
      await installer.installArchiveSkill('x', zip(), targets([agent]));
      expect(await fs.readFile(path.join(native, 'SKILL.md'), 'utf8')).toBe(
        'existing independent copy'
      );
      await installer.installArchiveSkill('x', zip(), targets([agent]), true);
      expect(await fs.readFile(path.join(native, 'SKILL.md'), 'utf8')).toBe(
        'archive'
      );
      expect(await fs.realpath(native)).toBe(await fs.realpath(canonical));
      expect((await fs.lstat(native)).isSymbolicLink()).toBe(true);
      await installer.removeSkill('x', targets([agent]));
      expect(await exists(native)).toBe(false);
      expect(await exists(canonical)).toBe(false);
    }
  );

  it.each([
    ['cursor', '.cursor/skills'],
    ['opencode', '.config/opencode/skills'],
    ['amp', '.config/agents/skills'],
  ])(
    'preserves %s global entrance during init and migration',
    async (agent, relative) => {
      const native = path.join(home, relative, 'deveco-cli');
      await copy(native);
      await installer.migrateBundledSkill(source, { agents: [agent] });
      expect(await fs.readFile(path.join(native, 'SKILL.md'), 'utf8')).toBe(
        'old'
      );
      await installer.installBundledSkill(source, targets([agent]));
      expect(await fs.readFile(path.join(native, 'SKILL.md'), 'utf8')).toBe(
        'old'
      );
      await installer.installBundledSkill(source, targets([agent]), true);
      expect(await fs.realpath(native)).toBe(await fs.realpath(source));
      expect(
        await fs.realpath(path.join(home, '.agents/skills/deveco-cli'))
      ).toBe(await fs.realpath(source));
      await installer.removeSkill('deveco-cli', targets([agent]));
      expect(await exists(native)).toBe(false);
      expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe(
        'bundled'
      );
    }
  );

  it('requires a global Cursor link before retaining shared content for it', async () => {
    await fs.mkdir(path.join(home, '.cursor'));
    await installer.installArchiveSkill('x', zip(), targets(['codex']));
    await installer.removeSkill('x', targets(['codex']));
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(false);
    await installer.installArchiveSkill(
      'x',
      zip(),
      targets(['codex', 'cursor'])
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await installer.removeSkill('x', targets(['codex']));
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain('still used by Cursor');
  });

  it('retains project shared content for an installed Cursor', async () => {
    await fs.mkdir(path.join(home, '.cursor'));
    await installer.installArchiveSkill('x', zip(), targets(['codex'], true));
    await installer.removeSkill('x', targets(['codex'], true));
    expect(await exists(path.join(project, '.agents/skills/x'))).toBe(true);
  });

  it('does not treat DevEco project .config as legacy', async () => {
    const unrelated = path.join(project, '.config/deveco/skills/deveco-cli');
    await copy(unrelated, 'unrelated');
    await installer.installBundledSkill(source, targets(['deveco'], true));
    expect(await fs.readFile(path.join(unrelated, 'SKILL.md'), 'utf8')).toBe(
      'unrelated'
    );
    expect(
      await fs.realpath(path.join(project, '.deveco/skills/deveco-cli'))
    ).toBe(await fs.realpath(source));
  });

  const legacyCases = [
    ['codex', '.codex/skills', false],
    ['pi', '.pi/agent/skills', false],
    ['codex', '.codex/skills', true],
    ['pi', '.pi/skills', true],
    ['opencode', '.opencode/skills', true],
    ['cursor', '.cursor/skills', true],
    ['trae-cn', '.trae-cn/skills', true],
  ] as const;

  it.each(legacyCases)(
    'replaces %s legacy archive at %s only with force (project=%s)',
    async (agent, relative, local) => {
      const base = local ? project : home;
      const legacy = path.join(base, relative, 'x');
      const canonical = path.join(base, '.agents/skills/x');
      await copy(legacy);
      await installer.installArchiveSkill('x', zip(), targets([agent], local));
      expect(await fs.readFile(path.join(legacy, 'SKILL.md'), 'utf8')).toBe(
        'old'
      );
      await installer.installArchiveSkill(
        'x',
        zip(),
        targets([agent], local),
        true
      );
      expect(await exists(legacy)).toBe(false);
      expect(await fs.readFile(path.join(canonical, 'SKILL.md'), 'utf8')).toBe(
        'archive'
      );
    }
  );

  it.each(legacyCases)(
    'cleans %s legacy bundled entry at %s only with force (project=%s)',
    async (agent, relative, local) => {
      const base = local ? project : home;
      const legacy = path.join(base, relative, 'deveco-cli');
      await copy(legacy);
      await installer.installBundledSkill(source, targets([agent], local));
      expect(await fs.readFile(path.join(legacy, 'SKILL.md'), 'utf8')).toBe(
        'old'
      );
      await installer.installBundledSkill(
        source,
        targets([agent], local),
        true
      );
      expect(await exists(legacy)).toBe(false);
      expect(
        await fs.realpath(path.join(base, '.agents/skills/deveco-cli'))
      ).toBe(await fs.realpath(source));
    }
  );

  it('keeps a legacy archive until its replacement is successfully installed', async () => {
    const legacy = path.join(home, '.trae-cn/skills/x');
    await copy(legacy, 'local edits');
    vi.spyOn(fs, 'symlink').mockRejectedValue(new Error('link denied'));
    vi.spyOn(fs, 'cp').mockRejectedValue(new Error('copy denied'));
    const results = await installer.installArchiveSkill(
      'x',
      zip(),
      targets(['trae-cn']),
      true
    );
    expect(results.some((result) => !result.success)).toBe(true);
    expect(await fs.readFile(path.join(legacy, 'SKILL.md'), 'utf8')).toBe(
      'local edits'
    );
  });

  it('preserves a legacy global bundled copy during automatic migration', async () => {
    const legacy = path.join(home, '.codex/skills/deveco-cli');
    await copy(legacy);
    await installer.migrateBundledSkill(source, { agents: getAgentNames() });
    expect(await fs.readFile(path.join(legacy, 'SKILL.md'), 'utf8')).toBe(
      'old'
    );
    expect(
      await fs.realpath(path.join(home, '.agents/skills/deveco-cli'))
    ).toBe(await fs.realpath(source));
  });

  it('removes selected legacy entries but retains a shared entry used by Pi', async () => {
    await fs.mkdir(path.join(home, '.pi/agent'), { recursive: true });
    const legacy = path.join(home, '.codex/skills/x');
    await copy(legacy);
    await copy(path.join(home, '.agents/skills/x'));
    await installer.removeSkill('x', targets(['codex']));
    expect(await exists(legacy)).toBe(false);
    expect(await exists(path.join(home, '.agents/skills/x'))).toBe(true);
  });

  it('never cleans the shared entry through a legacy parent alias', async () => {
    await fs.mkdir(path.join(home, '.pi/agent'), { recursive: true });
    const shared = path.join(home, '.agents/skills/x');
    const legacyDir = path.join(home, '.codex/skills');
    await copy(shared, 'shared');
    await fs.mkdir(path.dirname(legacyDir));
    await fs.symlink(
      path.dirname(shared),
      legacyDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await installer.removeSkill('x', targets(['codex']));
    expect(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8')).toBe(
      'shared'
    );
    await installer.installArchiveSkill('x', zip(), targets(['codex']));
    expect(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8')).toBe(
      'shared'
    );
    await installer.installArchiveSkill('x', zip(), targets(['codex']), true);
    expect(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8')).toBe(
      'archive'
    );
  });

  it('preserves old entries when bundled link and copy preparation both fail', async () => {
    const shared = path.join(home, '.agents/skills/deveco-cli');
    const legacy = path.join(home, '.codex/skills/deveco-cli');
    await copy(shared);
    await copy(legacy);
    vi.spyOn(fs, 'symlink').mockRejectedValue(new Error('link denied'));
    vi.spyOn(fs, 'cp').mockRejectedValue(new Error('copy denied'));
    const results = await installer.installBundledSkill(
      source,
      targets(['codex']),
      true
    );
    expect(results.some((r) => !r.success)).toBe(true);
    expect(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8')).toBe(
      'old'
    );
    expect(await fs.readFile(path.join(legacy, 'SKILL.md'), 'utf8')).toBe(
      'old'
    );
  });
});
