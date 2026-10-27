/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { SkillsApiConstants, AGENT_SKILLS_CONFIG } from './skills.js';

const API_BASE_URL = new URL(SkillsApiConstants.SKILL_API_BASE).origin;

describe('SkillsApiConstants', () => {
  it('composes the tags and skills endpoints from the shared base path', () => {
    expect(
      SkillsApiConstants.SKILLS_API_URL.startsWith(
        SkillsApiConstants.SKILL_API_BASE
      )
    ).toBe(true);
    expect(SkillsApiConstants.TAGS_API_URL).toBe(
      `${API_BASE_URL}/api/model_base/model/tags?serviceType=skill`
    );
    expect(SkillsApiConstants.SKILL_API_BASE).toBe(
      `${API_BASE_URL}/api/registry/skill`
    );
  });
});

describe('AGENT_SKILLS_CONFIG', () => {
  it('has no unsupported shared target, directory extensions or duplicate legacy', () => {
    expect(AGENT_SKILLS_CONFIG.agents).toBeUndefined();
    for (const entry of Object.values(AGENT_SKILLS_CONFIG)) {
      expect(typeof entry.globalSkillsDir).toBe('string');
      expect(entry.globalSkillsDir).not.toContain('{');
      expect(entry.legacySkillsDirs ?? []).not.toContain(entry.skillsDir);
      expect(entry.legacyGlobalSkillsDirs ?? []).not.toContain(
        entry.globalSkillsDir
      );
    }
    expect(AGENT_SKILLS_CONFIG.deveco.legacySkillsDirs).toBeUndefined();
    expect(AGENT_SKILLS_CONFIG.deveco.legacyGlobalSkillsDirs).toBeUndefined();
  });
  it('includes the expected agent configurations', () => {
    for (const agent of [
      'codex',
      'universal',
      'zed',
      'deveco',
      'atomcode',
      'dsh',
    ]) {
      expect(AGENT_SKILLS_CONFIG[agent]).toBeDefined();
    }
  });
  it('uses shared project paths and preserves independent global paths', () => {
    for (const agent of ['codex', 'cursor', 'opencode', 'pi']) {
      expect(AGENT_SKILLS_CONFIG[agent].skillsDir).toBe('.agents/skills');
    }
    expect(AGENT_SKILLS_CONFIG.codex.globalSkillsDir).toBe('~/.agents/skills');
    expect(AGENT_SKILLS_CONFIG['trae-cn'].skillsDir).toBe('.trae/skills');
    expect(AGENT_SKILLS_CONFIG.windsurf.globalSkillsDir).toBe(
      '~/.codeium/windsurf/skills'
    );
  });
});
