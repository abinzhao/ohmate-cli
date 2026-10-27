/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compilerObserverSource } from './compiler-observer-source.js';
import { collectCompilerObservations } from './compiler-observations.js';
import { digest } from './evidence.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-checker-cache-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(name: string, mode = 'read') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const cachePath = join(project, '.cache/debug'), parent = mode === 'foreign' ? project : dirname(cachePath);
  const file = join(parent, name), frontend = join(sdk, 'ets-loader/node_modules/typescript/lib/typescript.js');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js'), preload = join(root, 'observer.cjs');
  for (const folder of [cachePath, directory, dirname(frontend), dirname(job)]) { await mkdir(folder, { recursive: true }); }
  if (mode !== 'absent') { await writeFile(file, 'before-cache'); }
  await writeFile(preload, compilerObserverSource);
  await writeFile(frontend, `
    exports.createCompilerHost = () => ({ readFile(file) {
      try { return require('node:fs').readFileSync(file).toString(); }
      catch(error) { if(error.code==='ENOENT') return undefined; throw error; }
    } });
  `);
  await writeFile(job, `
    const fs=require('node:fs'), ts=require(${JSON.stringify(frontend)});
    exports.run=async () => {
      ts.createCompilerHost().readFile(${JSON.stringify(file)});
      fs.writeFileSync(${JSON.stringify(file)},'after-cache');
    };
  `);
  const child = spawn(process.execPath, ['--require', preload, '-e',
    `require(${JSON.stringify(job)}).run({cachePath:${JSON.stringify(cachePath)}}).catch(error=>{console.error(error);process.exitCode=1;});`], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  expect({ ...exit, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  return collectCompilerObservations(directory, project, sdk);
}

it.each(['.tsbuildinfo', '.tsbuildinfo.linter', '.ts_checker_cache', '.ts_checker_cache_widget'])(
  'keeps the official %s read/write transition unverified instead of reporting source drift', async name => {
    const result = await observe(name);
    expect(result.invalid).toBe(false);
    expect(result.drift).toEqual([]);
    expect(result.files).toContainEqual(expect.objectContaining({
      path: `.cache/${name}`, role: 'compiler-cache-read', sha256: digest('before-cache'),
    }));
    expect(result.cacheTransitions).toContainEqual({
      path: `.cache/${name}`, readSha256: digest('before-cache'), afterSha256: digest('after-cache'), binding: 'cache-unverified',
    });
    expect(result.missing).toContain('compiler-cache-closure-unverified');
  });

it.each(['.ts_checker_cache', '.ts_checker_cache_widget'])(
  'records creation after an absent %s Host probe as an unverified cache transition', async name => {
    const result = await observe(name, 'absent');
    expect(result.invalid).toBe(false);
    expect(result.drift).toEqual([]);
    expect(result.cacheTransitions).toContainEqual({
      path: `.cache/${name}`, readSha256: null, afterSha256: digest('after-cache'), binding: 'cache-unverified',
    });
    expect(result.missing).toContain('compiler-cache-closure-unverified');
  });

it.each(['.ts_checker_cache', '.ts_checker_cache_widget'])(
  'still rejects same-named %s drift outside the configured compiler cache parent', async name => {
    const result = await observe(name, 'foreign');
    expect(result.invalid).toBe(false);
    expect(result.drift).toEqual([name]);
    expect(result.cacheTransitions).toEqual([]);
    expect(result.files).toContainEqual(expect.objectContaining({ path: name, role: 'compiler-host-read' }));
  });
