/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSkillScopes, resolveSkillDestinations } from './agent-paths.js';
import { parseAgentList, resolveInstallationTargets } from '../agents.js';

describe('Skill installation scopes and physical paths', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-paths-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('CODEX_HOME', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deduplicates valid IDs and rejects unsupported agents', async () => {
    expect(await parseAgentList('claude-code,codex,codex')).toEqual([
      'claude-code',
      'codex',
    ]);
    await expect(parseAgentList('unknown-agent')).rejects.toThrow(
      'Invalid agent'
    );
    await fs.mkdir(path.join(root, '.codex'));
    const targets = await resolveInstallationTargets({}, undefined, root);
    expect(targets.projectAgents.some(({ agent }) => agent === 'codex')).toBe(
      true
    );
    expect(targets.explicitAgents).toBe(false);
  });

  it('groups independent project scopes and shares universal destinations', async () => {
    const scopes = getSkillScopes({
      agents: ['codex'],
      projectAgents: [
        { project: root, agent: 'cursor' },
        { project: root, agent: 'opencode' },
        { project: root + '-other', agent: 'codex' },
      ],
    });
    expect(scopes).toHaveLength(3);
    const destinations = await resolveSkillDestinations(scopes[1], 'x');
    expect(destinations.map((d) => d.path)).toEqual([
      path.join(root, '.agents/skills/x'),
    ]);
  });

  it('skips missing project agent roots only for automatic selections', async () => {
    const scope = { project: root, agents: ['windsurf', 'claude-code'] };
    expect(
      (await resolveSkillDestinations(scope, 'x', false)).map((d) => d.skipped)
    ).toEqual([true, true]);
    expect(
      (await resolveSkillDestinations(scope, 'x', true)).map((d) => d.skipped)
    ).toEqual([false, false]);
  });

  it('enumerates an existing legacy copy but never a shared entry through a parent alias', async () => {
    const legacy = path.join(root, '.codex/skills');
    await fs.mkdir(path.join(legacy, 'x'), { recursive: true });
    const scope = { agents: ['codex'] };
    expect((await resolveSkillDestinations(scope, 'x'))[0].legacy).toEqual([
      path.join(legacy, 'x'),
    ]);
    await fs.rm(legacy, { recursive: true });
    const shared = path.join(root, '.agents/skills');
    await fs.mkdir(path.join(shared, 'x'), { recursive: true });
    await fs.symlink(
      shared,
      legacy,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect((await resolveSkillDestinations(scope, 'x'))[0].legacy).toEqual([]);
  });

  it('skips ordinary project paths even if the global agent is detected', async () => {
    const project = path.join(root, 'project');
    await fs.mkdir(path.join(root, '.openclaw'), { recursive: true });
    await fs.mkdir(path.join(project, 'skills'), { recursive: true });
    await fs.mkdir(path.join(project, 'data'), { recursive: true });
    const scope = { project, agents: ['openclaw', 'astrbot'] };
    expect(
      (await resolveSkillDestinations(scope, 'example', false)).map(
        (d) => d.skipped
      )
    ).toEqual([true, true]);
    expect(
      (await resolveSkillDestinations(scope, 'example', true)).map(
        (d) => d.skipped
      )
    ).toEqual([false, false]);
  });
});
