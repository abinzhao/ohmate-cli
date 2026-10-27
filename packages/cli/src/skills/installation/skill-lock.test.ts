/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debugLog } from '../../utils/logger.js';
import { SkillInstaller } from './skill-installer.js';
import { getSkillStoreEntry } from './skill-store.js';

const workspace = fileURLToPath(new URL('../../../../../', import.meta.url));
const tempParent = path.join(workspace, 'dist/skill-lock-tests');
const installerUrl = new URL('./skill-installer.ts', import.meta.url).href;

function message(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Missing child signal: ${expected}`)),
      10000
    );
    const onExit = () => finish(new Error(`Child exited before ${expected}`));
    const onMessage = (value: unknown) => {
      if (value === expected) {
        finish();
      }
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

describe('Skill installation and removal across real processes', () => {
  let root: string;
  let scriptPath: string;
  const children: Array<{ child: ChildProcess; done: Promise<void> }> = [];
  const zip = (content: string) => {
    const archive = new AdmZip();
    archive.addFile('SKILL.md', Buffer.from(content));
    return archive.toBuffer();
  };

  beforeEach(async () => {
    await fs.mkdir(tempParent, { recursive: true });
    root = await fs.mkdtemp(path.join(tempParent, 'case-'));
    vi.stubEnv('DEVECO_CLI_DATA_DIR', path.join(root, 'data'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('USERPROFILE', path.join(root, 'home'));
    scriptPath = path.join(root, 'worker.mjs');
    await fs.writeFile(
      scriptPath,
      `
      import fs from 'node:fs/promises';
      import { createRequire } from 'node:module';
      import path from 'node:path';
      const [mode, root, archive] = process.argv.slice(2);
      const require = createRequire(import.meta.url);
      const graceful = require('graceful-fs');
      const mkdir = graceful.mkdir;
      let notified = false;
      graceful.mkdir = (target, callback) => mkdir(target, (error, ...values) => {
        if (mode === 'remove' && error?.code === 'EEXIST' && String(target).endsWith('x.lock') && !notified) {
          notified = true;
          process.send('waiting');
        }
        callback(error, ...values);
      });
      const { SkillInstaller } = await import(${JSON.stringify(installerUrl)});
      const installer = new SkillInstaller();
      const targets = { agents: [], projectAgents: [{ project: root, agent: 'claude-code' }] };
      if (mode === 'add') {
        const rename = fs.rename;
        fs.rename = async (from, to) => {
          if (String(from) === path.join(root, '.deveco-cli/skills/store/x') && String(to).includes('.backup-')) {
            const released = new Promise(resolve => process.once('message', resolve));
            process.send('publishing');
            await released;
          }
          return rename(from, to);
        };
      }
      const results = mode === 'add'
        ? await installer.installArchiveSkill('x', Buffer.from(archive, 'base64'), targets, true)
        : await installer.removeSkill('x', targets);
      if (results.some(result => !result.success)) throw new Error(JSON.stringify(results));
      process.disconnect();
    `
    );
  });

  afterEach(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    await Promise.allSettled(children.map(({ done }) => done));
    children.length = 0;
    vi.unstubAllEnvs();
    expect(path.dirname(root)).toBe(tempParent);
    await fs.rm(root, { recursive: true, force: true });
  });

  function start(mode: string) {
    const args = [scriptPath, mode, root, zip('updated').toString('base64')];
    debugLog(`Executing: ${process.execPath} --import tsx ${args.join(' ')}`);
    const child = fork(scriptPath, args.slice(1), {
      cwd: workspace,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, DEVECO_CLI_DATA_DIR: path.join(root, 'data') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`Skill child failed (${code ?? signal}): ${output}`)
          );
        }
      });
    });
    void done.catch(() => {});
    children.push({ child, done });
    return { child, done };
  }

  it('waits for entity publication before removing the last links and source', async () => {
    const targets = {
      agents: [],
      projectAgents: [{ project: root, agent: 'claude-code' }],
    };
    await new SkillInstaller().installArchiveSkill(
      'x',
      zip('original'),
      targets
    );
    const publishing = start('add');
    await message(publishing.child, 'publishing');
    const removing = start('remove');
    await message(removing.child, 'waiting');
    expect(removing.child.exitCode).toBeNull();
    expect(
      await fs.readFile(
        path.join(getSkillStoreEntry('x', root), 'SKILL.md'),
        'utf8'
      )
    ).toBe('original');
    publishing.child.send('continue');
    await Promise.all([publishing.done, removing.done]);
    for (const entry of [
      getSkillStoreEntry('x', root),
      path.join(root, '.agents/skills/x'),
      path.join(root, '.claude/skills/x'),
    ]) {
      await expect(fs.lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 30000);
});
