/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { processModuleTasks, validateProjectConfig } from './build.js';
import type { Project } from '../utils/project.js';

function mockProject(getModuleTypeFn: (name: string) => string): Project {
  return { getModuleType: getModuleTypeFn } as unknown as Project;
}

function mockProjectWithSigningConfigs(configNames: string[]): Project {
  return {
    profile: {
      app: {
        signingConfigs: configNames.map((name) => ({ name })),
        buildModeSet: [{ name: 'debug' }, { name: 'release' }],
      },
      modules: [{ name: 'entry' }],
    },
    validateProduct: () => {},
    getModuleType: () => 'entry',
  } as unknown as Project;
}

describe('processModuleTasks', () => {
  it('auto-detects assembleHap for entry module', () => {
    const project = mockProject(() => 'entry');
    const tasks = processModuleTasks(project, ['entry@default']);
    expect([...tasks]).toEqual(['assembleHap']);
  });

  it('auto-detects assembleHsp for shared module', () => {
    const project = mockProject(() => 'shared');
    const tasks = processModuleTasks(project, ['shared_mod@default']);
    expect([...tasks]).toEqual(['assembleHsp']);
  });

  it('auto-detects assembleHar for har module', () => {
    const project = mockProject(() => 'har');
    const tasks = processModuleTasks(project, ['lib@default']);
    expect([...tasks]).toEqual(['assembleHar']);
  });

  it('uses user-specified assembleType when provided', () => {
    const project = mockProject(() => 'entry');
    const tasks = processModuleTasks(project, ['entry@default'], 'assembleHsp');
    expect([...tasks]).toEqual(['assembleHsp']);
  });

  it('deduplicates tasks across modules with same type', () => {
    const project = mockProject(() => 'entry');
    const tasks = processModuleTasks(project, [
      'entry@default',
      'feature@default',
    ]);
    expect(tasks.size).toBe(1);
    expect([...tasks]).toEqual(['assembleHap']);
  });

  it('uses user-specified assembleType for all modules', () => {
    const project = mockProject(() => 'entry');
    const tasks = processModuleTasks(
      project,
      ['entry@default', 'feature@default'],
      'assembleHar'
    );
    expect(tasks.size).toBe(1);
    expect([...tasks]).toEqual(['assembleHar']);
  });
});

describe('validateProjectConfig — assemble type', () => {
  const project = mockProjectWithSigningConfigs(['default']);

  it('accepts valid assemble types', () => {
    expect(() =>
      validateProjectConfig(project, { assembleType: 'assembleHap' })
    ).not.toThrow();
    expect(() =>
      validateProjectConfig(project, { assembleType: 'assembleApp' })
    ).not.toThrow();
    expect(() =>
      validateProjectConfig(project, { assembleType: 'assembleHsp' })
    ).not.toThrow();
    expect(() =>
      validateProjectConfig(project, { assembleType: 'assembleHar' })
    ).not.toThrow();
  });

  it('rejects invalid assemble type', () => {
    expect(() =>
      validateProjectConfig(project, { assembleType: 'abc' })
    ).toThrow(/Invalid assemble type 'abc'/);
  });

  it('accepts undefined assembleType (no validation)', () => {
    expect(() => validateProjectConfig(project, {})).not.toThrow();
  });
});

describe('validateProjectConfig — signing config', () => {
  it('accepts existing signing config name', () => {
    const project = mockProjectWithSigningConfigs([
      'default',
      'default_release',
    ]);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'default' })
    ).not.toThrow();
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'default_release' })
    ).not.toThrow();
  });

  it('rejects nonexistent signing config name with hint', () => {
    const project = mockProjectWithSigningConfigs(['default']);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'nonexistent' })
    ).toThrow(/not found.*Available configs: default/);
  });

  it('shows "No signing configs found" when none exist', () => {
    const project = mockProjectWithSigningConfigs([]);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'any' })
    ).toThrow(/No signing configs found/);
  });

  it('suggests --type release for _release suffix names', () => {
    const project = mockProjectWithSigningConfigs(['default']);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'default_release' })
    ).toThrow(/devecocli signature generate --type release/);
  });

  it('suggests plain generate for non-release names', () => {
    const project = mockProjectWithSigningConfigs(['default']);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'my_config' })
    ).toThrow(/devecocli signature generate`/);
  });

  it('rejects signing config with invalid characters', () => {
    const project = mockProjectWithSigningConfigs(['default']);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'config with spaces' })
    ).toThrow(
      /Invalid signing config name.*Only letters, digits, hyphens and underscores/
    );
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'config=name' })
    ).toThrow(/Invalid signing config name/);
    expect(() =>
      validateProjectConfig(project, { signingConfig: 'config/path' })
    ).toThrow(/Invalid signing config name/);
  });

  it('accepts undefined signingConfig (no validation)', () => {
    const project = mockProjectWithSigningConfigs([]);
    expect(() => validateProjectConfig(project, {})).not.toThrow();
  });
});
