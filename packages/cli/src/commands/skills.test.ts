/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import skillsCommand from './skills.js';
import { fetchTagIds, fetchAllSkills } from '../skills/api.js';
import { downloadSkill } from '../skills/skill-package.js';
import { telemetry } from '../trace/index.js';

vi.mock('../skills/api.js', async (original) => ({
  ...(await original<typeof import('../skills/api.js')>()),
  fetchTagIds: vi.fn(),
  fetchAllSkills: vi.fn(),
}));
vi.mock('../skills/skill-package.js', async (original) => ({
  ...(await original<typeof import('../skills/skill-package.js')>()),
  downloadSkill: vi.fn(),
}));
vi.mock('../auth/utils/token-storage.js', () => ({
  isDevecoCodeAuth: () => false,
}));
vi.mock('../trace/index.js', () => ({
  telemetry: { track: vi.fn() },
  EventType: { SkillOperation: 'SkillOperation' },
}));

describe('skills command installation failures and project selection', () => {
  let root: string;
  let log: ReturnType<typeof vi.spyOn>;
  let exitCode: typeof process.exitCode;
  const archive = (entry = 'SKILL.md') => {
    const zip = new AdmZip();
    zip.addFile(entry, Buffer.from('skill content'));
    return zip.toBuffer();
  };
  const mockInstallFailure = (failure: string) => {
    vi.mocked(downloadSkill).mockImplementation(async (name) =>
      name === 'broken' && failure === 'invalid zip'
        ? Buffer.from('invalid zip')
        : archive(
            name === 'broken' && failure === 'missing guide'
              ? 'README.md'
              : 'SKILL.md'
          )
    );
    if (failure === 'permission denied') {
      const mkdir = fs.mkdir.bind(fs);
      vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
        if (String(args[0]).includes('broken.extract-')) {
          throw Object.assign(new Error('EACCES: extraction denied'), {
            code: 'EACCES',
          });
        }
        return mkdir(...args);
      });
    }
  };
  const assertBatchCompletion = async ({
    scope,
    destination,
    entity,
    opSuccess,
  }: {
    scope: string;
    destination: string;
    entity: string;
    opSuccess: number;
  }) => {
    expect(
      await fs.readFile(path.join(destination, 'working/SKILL.md'), 'utf8')
    ).toBe('skill content');
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain(`Success: ${opSuccess}`);
    expect(output).toContain('Failed: 1');
    expect(output).toContain(`updated: ${entity}`);
    if (scope === 'project') {
      expect(await fs.realpath(path.join(destination, 'working'))).toBe(
        await fs.realpath(entity)
      );
    }
    expect(output).not.toContain('removed:');
    expect(process.exitCode).toBe(1);
    expect(telemetry.track).toHaveBeenCalledWith(
      expect.objectContaining({
        opSuccess,
        opFailed: 1,
        opTotal: opSuccess + 1,
      }),
      expect.anything()
    );
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-command-'));
    vi.stubEnv('DEVECO_CLI_DATA_DIR', path.join(root, 'data'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('USERPROFILE', path.join(root, 'home'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitCode = process.exitCode;
    process.exitCode = undefined;
    for (const command of skillsCommand.commands) {
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), undefined);
      }
    }
    vi.mocked(fetchTagIds).mockResolvedValue(['hmos']);
    vi.mocked(fetchAllSkills).mockResolvedValue([
      { enName: 'broken' },
      { enName: 'working' },
    ] as Awaited<ReturnType<typeof fetchAllSkills>>);
  });
  afterEach(async () => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ['invalid zip', 'custom'],
    ['missing guide', 'custom'],
    ['permission denied', 'custom'],
    ['invalid zip', 'project'],
    ['missing guide', 'project'],
    ['permission denied', 'project'],
  ])(
    'continues the batch and reports counts after %s (%s)',
    async (failure, scope) => {
      mockInstallFailure(failure);
      const isCustom = scope === 'custom';
      const destination = isCustom ? root : path.join(root, '.agents/skills');
      const entity = isCustom
        ? path.join(root, 'working')
        : path.join(root, '.deveco-cli/skills/store/working');
      const args = isCustom
        ? ['--path', root]
        : ['--project', root, '--agent', 'codex'];
      await skillsCommand.parseAsync(['add', '--all', ...args], {
        from: 'user',
      });
      await assertBatchCompletion({
        scope,
        destination,
        entity,
        opSuccess: isCustom ? 1 : 2,
      });
    }
  );

  it('keeps ordinary project directories on automatic removal', async () => {
    const entries = ['skills', 'data/skills'];
    for (const entry of entries) {
      await fs.mkdir(path.join(root, entry, 'example'), { recursive: true });
      await fs.writeFile(
        path.join(root, entry, 'example/local.txt'),
        'user data'
      );
    }
    await skillsCommand.parseAsync(
      ['remove', '--skill', 'example', '--project', root],
      { from: 'user' }
    );
    for (const entry of entries) {
      expect(
        await fs.readFile(path.join(root, entry, 'example/local.txt'), 'utf8')
      ).toBe('user data');
    }
    expect(process.exitCode).toBeUndefined();
  });

  it('allows explicit selection of an agent using an ordinary project path', async () => {
    const entry = path.join(root, 'skills/example');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'local.txt'), 'selected agent');
    await skillsCommand.parseAsync(
      [
        'remove',
        '--skill',
        'example',
        '--project',
        root,
        '--agent',
        'openclaw',
      ],
      { from: 'user' }
    );
    await expect(fs.lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.exitCode).toBeUndefined();
  });
});
