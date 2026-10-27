/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expandPathTemplate,
  getAgentEntry,
  getSharedAgentSkillsDir,
  getNativeSkillsDir,
  getGlobalSkillsDir,
  getStaleSkillsDirs,
  isAgentInstalled,
  isUniversalAgent,
} from './agent-registry.js';

describe('agent registry', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'deveco-registry-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([
    ['amp', '.config/agents/skills'],
    ['antigravity', '.gemini/antigravity/skills'],
    ['antigravity-cli', '.gemini/antigravity-cli/skills'],
    ['cursor', '.cursor/skills'],
    ['deepagents', '.deepagents/agent/skills'],
    ['droid', '.factory/skills'],
    ['gemini-cli', '.gemini/skills'],
    ['github-copilot', '.copilot/skills'],
    ['kilo', '.kilo/skills'],
    ['opencode', '.config/opencode/skills'],
    ['replit', '.config/agents/skills'],
    ['universal', '.config/agents/skills'],
  ])(
    'preserves %s global entrance independently of its project path',
    (agent, relative) => {
      expect(getGlobalSkillsDir(agent)).toBe(path.join(home, relative));
      expect(getNativeSkillsDir(agent)).toBe(path.join(home, relative));
      expect(getNativeSkillsDir(agent, '/p')).toBe(
        path.normalize('/p/.agents/skills')
      );
      expect(getStaleSkillsDirs(agent)).toEqual([]);
    }
  );

  it('distinguishes global sharing from project sharing', () => {
    expect(isUniversalAgent('cursor')).toBe(false);
    expect(isUniversalAgent('cursor', '/p')).toBe(true);
    expect(isUniversalAgent('codex')).toBe(true);
    expect(isUniversalAgent('claude-code', '/p')).toBe(false);
    expect(getNativeSkillsDir('codex')).toBe(getSharedAgentSkillsDir());
  });

  it('keeps DevEco paths unchanged without adding legacy', () => {
    expect(getNativeSkillsDir('deveco')).toBe(
      path.join(home, '.config/deveco/skills')
    );
    expect(getNativeSkillsDir('deveco', '/p')).toBe(
      path.normalize('/p/.deveco/skills')
    );
    expect(getStaleSkillsDirs('deveco')).toEqual([]);
    expect(getStaleSkillsDirs('deveco', '/p')).toEqual([]);
  });

  it('uses only the documented paths despite alternate roots or environment variables', async () => {
    await fs.mkdir(path.join(home, '.clawdbot'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'alternate'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'custom-claude'));
    expect(getGlobalSkillsDir('openclaw')).toBe(
      path.join(home, '.openclaw/skills')
    );
    expect(getGlobalSkillsDir('opencode')).toBe(
      path.join(home, '.config/opencode/skills')
    );
    expect(getGlobalSkillsDir('claude-code')).toBe(
      path.join(home, '.claude/skills')
    );
  });

  it('retains only distinct develop legacy paths', () => {
    expect(getStaleSkillsDirs('codex')).toEqual([
      path.join(home, '.codex/skills'),
    ]);
    expect(getStaleSkillsDirs('pi')).toEqual([
      path.join(home, '.pi/agent/skills'),
    ]);
    expect(getStaleSkillsDirs('cursor', '/p')).toEqual([
      path.normalize('/p/.cursor/skills'),
    ]);
    expect(getStaleSkillsDirs('opencode', '/p')).toEqual([
      path.normalize('/p/.opencode/skills'),
    ]);
    expect(getStaleSkillsDirs('trae-cn', '/p')).toEqual([
      path.normalize('/p/.trae-cn/skills'),
    ]);
  });

  it('detects develop agents and independent roots without treating shared data as an installed agent', async () => {
    await fs.mkdir(path.join(home, '.agents/skills'), { recursive: true });
    await fs.mkdir(path.join(home, '.config/agents/skills'), {
      recursive: true,
    });
    expect(isAgentInstalled('cline')).toBe(false);
    expect(isAgentInstalled('universal')).toBe(false);
    expect(isAgentInstalled('codex')).toBe(false);
    await fs.mkdir(path.join(home, '.codex'));
    expect(isAgentInstalled('codex')).toBe(true);
    expect(isAgentInstalled('kilo')).toBe(false);
    await fs.mkdir(path.join(home, '.kilo'));
    expect(isAgentInstalled('kilo')).toBe(true);
    const project = path.join(home, 'project');
    await fs.mkdir(path.join(project, '.continue'), { recursive: true });
    expect(isAgentInstalled('continue', project)).toBe(true);
  });

  it('preserves literal characters when expanding the user directory', () => {
    vi.stubEnv('HOME', path.join(home, '$&'));
    vi.stubEnv('USERPROFILE', path.join(home, '$&'));
    expect(expandPathTemplate('~/.claude/skills')).toBe(
      path.join(home, '$&/.claude/skills')
    );
  });

  it.each([
    ['openclaw', 'skills'],
    ['astrbot', 'data'],
  ])(
    'does not detect %s from an ordinary project directory',
    async (agent, dir) => {
      const project = path.join(home, 'project');
      await fs.mkdir(path.join(project, dir), { recursive: true });
      expect(isAgentInstalled(agent, project)).toBe(false);
    }
  );

  it.each(['agents', '.agents', 'toString', 'unknown'])(
    'rejects the unsupported ID %s',
    (agent) => {
      expect(() => getAgentEntry(agent)).toThrow('Invalid agent');
    }
  );
});
