/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, truncate, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createExecutionContext } from '../runtime/context.js';
import { collectLoaderInputs } from './loader-inputs.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-loader-evidence-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function loader(name: string, paths: string[]) {
  const file = join(root, name, 'build/default/intermediates/loader/default/loader.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ compileEntry: paths }));
}
async function collect() {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'data') });
  return collectLoaderInputs({
    product: 'default', buildMode: 'debug', modules: ['entry@default', 'library@default'],
    model: { root, modules: ['entry', 'library'].map((name) => ({ name, path: join(root, name) })) },
  }, new Map(), context);
}
it('shares the byte budget across selected loader files', async () => {
  for (const name of ['entry', 'library']) {
    const input = join(root, `${name}.abc`);
    await writeFile(input, 'private test-owned sparse fixture'); await truncate(input, 40 * 1024 * 1024);
    await loader(name, [input]);
  }
  const result = await collect();
  expect(result.invalidInputs).toBe(true);
  expect(result.loaders.flatMap((item) => item.missing)).toContain('loader-byte-budget');
});
it('shares the declaration budget across selected loader files', async () => {
  const input = join(root, 'shared.ets');
  await writeFile(input, 'test-owned input');
  for (const name of ['entry', 'library']) { await loader(name, Array(2049).fill(input)); }
  const result = await collect();
  expect(result.invalidInputs).toBe(true);
  expect(result.loaders.flatMap((item) => item.missing)).toContain('loader-input-budget');
}, 15_000);

it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
  const fifo = join(root, 'input.fifo');
  const made = spawnSync('mkfifo', [fifo], { cwd: root, encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  const script = `
    import { evidenceFile } from ${JSON.stringify(new URL('./evidence.ts', import.meta.url).href)};
    process.stdout.write('ready\\n');
    try {
      await evidenceFile(${JSON.stringify(root)},${JSON.stringify(fifo)});
      process.exitCode=41;
    } catch(error) {
      process.stdout.write(error.message);
    }
  `;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script],
    { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', ready = false;
  let watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdout.setEncoding('utf8').on('data', (value: string) => {
    stdout += value;
    if (!ready && stdout.includes('ready\n')) {
      ready = true; clearTimeout(watchdog);
      watchdog = setTimeout(() => child.kill('SIGKILL'), 1000);
    }
  });
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  clearTimeout(watchdog);
  expect(ready).toBe(true);
  expect(code).toBe(0);
  expect(stdout).toMatch(/regular|bounded/);
}, 10_000);
