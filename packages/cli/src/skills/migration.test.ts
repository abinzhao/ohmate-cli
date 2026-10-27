/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { debugLog } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const tempParent = path.join(workspace, 'dist/skill-migration-tests');
const agentsUrl = new URL('./agents.ts', import.meta.url).href;

describe('global Skill migration with real directory links', () => {
  let root: string;

  beforeEach(async () => {
    await fs.mkdir(tempParent, { recursive: true });
    root = await fs.mkdtemp(path.join(tempParent, 'case-'));
  });

  afterEach(async () => {
    expect(path.dirname(root)).toBe(tempParent);
    await fs.rm(path.join(root, 'home/.augment'), { force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function migrate() {
    const profile = path.join(root, 'home');
    const excludedKeys = new Set([
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'GROK_HOME',
      'HERMES_HOME',
      'VIBE_HOME',
      'DEVECO_CLI_WRAPPER_VERSION',
    ]);
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key.toLowerCase() !== 'npm_package_version' &&
            !excludedKeys.has(key)
        )
      ),
      HOME: profile,
      USERPROFILE: profile,
      XDG_CONFIG_HOME: path.join(profile, '.config'),
      DEVECO_CLI_DATA_DIR: path.join(root, 'data'),
      npm_package_version: '1.0.0-test',
    };
    const script =
      `const { migrateSkillSymlinkIfVersionChanged } = await import(${JSON.stringify(agentsUrl)});` +
      'await migrateSkillSymlinkIfVersionChanged();';
    const args = ['--import', 'tsx', '--input-type=module', '-e', script];
    debugLog(`Executing: ${process.execPath} ${args.join(' ')}`);
    return execFileAsync(process.execPath, args, {
      cwd: workspace,
      env,
      timeout: 10000,
    });
  }

  it('preserves global copies and retries after a root cannot be resolved', async () => {
    const loop = path.join(root, 'home/.augment');
    const installed = path.join(root, 'home/.qoder/skills/deveco-cli');
    const marker = path.join(root, 'data/skills/migration-version');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'SKILL.md'), '# Installed Skill');
    await fs.symlink(
      loop,
      loop,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const first = await migrate();
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(false);
    expect(first.stderr).toContain(loop);
    expect(first.stderr).toContain('devecocli init --force');
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(loop, { force: true });
    await migrate();
    expect(await fs.readFile(marker, 'utf8')).toBe('1.0.0-test');
    expect(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8')).toBe(
      '# Installed Skill'
    );
  }, 30000);
});
