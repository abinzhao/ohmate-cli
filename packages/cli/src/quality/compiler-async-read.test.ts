/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compilerObserverSource } from './compiler-observer-source.js';
import { collectCompilerObservations } from './compiler-observations.js';
import { digest } from './evidence.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-async-read-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode: string) {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js'), source = join(project, 'Input.ets');
  for (const path of [project, sdk, directory, dirname(job)]) { await mkdir(path, { recursive: true }); }
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from('original', 'utf16le')]);
  await writeFile(source, bytes);
  if (mode === 'hardlink') { await link(source, join(project, 'Alias.ets')); }
  if (mode === 'sensitive') {
    await rm(source);
    await writeFile(join(project, '.env'), 'PRIVATE_ASYNC_SENTINEL');
    await symlink(join(project, '.env'), source);
  }
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  // A held original callback makes the close/next-invocation boundary deterministic.
  const driver = `
    const fs = require('node:fs'), fsp = require('node:fs/promises');
    let release;
    if (${JSON.stringify(mode)} === 'late') {
      const original = fs.readFile;
      fs.readFile = function(file, ...args) {
        const callback = args.pop();
        return original.call(this, file, ...args, (...result) => { release = () => callback(...result); });
      };
    }
    require(${JSON.stringify(join(root, 'observer.cjs'))});
    const job = require(${JSON.stringify(job)});
    (async () => {
      if (${JSON.stringify(mode)} === 'overlap') {
        await Promise.all([job.run({entryModuleName:'first'}), job.run({entryModuleName:'second'})]);
      } else if (${JSON.stringify(mode)} === 'late') {
        await job.run({entryModuleName:'first'});
        while (!release) await new Promise(done => setImmediate(done));
        await job.run({entryModuleName:'second'});
      } else {
        await job.run({entryModuleName:'entry'});
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await writeFile(job, `
    const fs = require('node:fs'), fsp = require('node:fs/promises'), assert = require('node:assert/strict');
    const file = ${JSON.stringify(source)}, mode = ${JSON.stringify(mode)};
    exports.run = async config => {
      if (mode === 'late' && config.entryModuleName === 'first') {
        fs.readFile(file, error => { assert.equal(error, null); });
        return;
      }
      if (mode === 'late') { globalThis.releaseHeldRead(); return; }
      if (mode === 'overlap') {
        const target = file + '.' + config.entryModuleName;
        await fsp.writeFile(target, config.entryModuleName);
        await fsp.readFile(target);
        return;
      }
      const target = mode.startsWith('missing-') ? file + '.absent' : mode.startsWith('url-') ?
        require('node:url').pathToFileURL(file) : mode.startsWith('relative-') ? './Input.ets' : file;
      const encoding = mode.startsWith('encoded-') ? 'utf16le' : undefined;
      const callback = mode.endsWith('callback');
      const read = () => callback ? new Promise((done, reject) => {
        const result = fs.readFile(target, encoding, function(error, value) {
          if (error) { assert.equal(arguments.length, 1); reject(error); return; }
          done(value);
        });
        assert.equal(result, undefined);
      }) : fsp.readFile(target, encoding);
      if (mode.startsWith('missing-')) {
        await assert.rejects(read(), error => error.code === 'ENOENT' && error.path === target);
        return;
      }
      const value = await read();
      if (encoding) assert.equal(value, '\\uFEFForiginal');
      else if (mode.startsWith('mutate-')) value.fill(0);
      if (mode === 'drift') await fsp.writeFile(file, Buffer.alloc(value.length, 65));
      return value;
    };
  `);
  await writeFile(join(root, 'driver.cjs'), driver.replace('const job = require',
    'globalThis.releaseHeldRead = () => release(); const job = require'));
  const child = spawn(process.execPath, [join(root, 'driver.cjs')], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
  let exit;
  try {
    exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally { clearTimeout(deadline); }
  expect({ ...exit, stdout, stderr }).toEqual({ code: 0, signal: null, stdout: '', stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  const raw = await Promise.all((await readdir(directory)).map(async name =>
    (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))));
  return { result: await collectCompilerObservations(directory, project, sdk), raw, bytes };
}
it.each(['promise', 'callback', 'mutate-promise', 'mutate-callback'])('hashes actual %s bytes before caller mutation', async mode => {
  const { result, bytes } = await observe(mode);
  expect(result.invalid).toBe(false);
  expect(result.drift).toEqual([]);
  expect(result.files).toContainEqual(expect.objectContaining({
    path: 'Input.ets', role: 'runtime-read', sha256: digest(bytes), size: bytes.length,
    readMethods: [mode.endsWith('callback') ? 'fs.readFile' : 'fs.promises.readFile'],
  }));
});
it.each(['url-promise', 'url-callback', 'relative-promise', 'relative-callback'])('binds %s to the actual file path', async mode => {
  const { result, bytes } = await observe(mode);
  expect(result.invalid).toBe(false);
  expect(result.files).toContainEqual(expect.objectContaining({ path: 'Input.ets', sha256: digest(bytes) }));
});
it.each(['promise', 'callback'])('keeps encoded %s returns separate from raw bytes', async api => {
  const { result } = await observe(`encoded-${api}`);
  expect(result.invalid).toBe(false);
  expect(result.files).toEqual([]);
  expect(result.textReads).toContainEqual(expect.objectContaining({
    path: 'Input.ets', method: api === 'callback' ? 'fs.readFile' : 'fs.promises.readFile',
    binding: 'decoded-filesystem-text', textSha256: digest('\uFEFForiginal'), readObserved: false,
  }));
  expect(result.missing).toContain('decoded-filesystem-read-without-raw-bytes');
});
it.each(['promise', 'callback'])('records %s ENOENT without changing the original error', async api => {
  const { result, raw } = await observe(`missing-${api}`);
  expect(result.invalid).toBe(false);
  expect(result.files).toEqual([]);
  expect(raw[0][1].probes).toContainEqual(expect.objectContaining({ exists: false }));
});
it('retains separate actual reads for overlapping invocations in one process', async () => {
  const { result, raw } = await observe('overlap');
  expect(result.invalid).toBe(false);
  expect(result.configurations.map(item => item.entryModuleName).sort()).toEqual(['first', 'second']);
  expect(raw).toHaveLength(2);
  for (const records of raw) {
    expect(records[1].files.map((file: { path: string }) => file.path)).toEqual([
      join(root, 'project', `Input.ets.${records[1].configuration.entryModuleName}`),
    ]);
  }
});
it('marks pending reads at close and excludes the late result from the next invocation', async () => {
  const { result, raw } = await observe('late');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('pending-compiler-reads-at-close');
  expect(result.files).toEqual([]);
  expect(raw).toHaveLength(2);
  expect(raw.find(records => records[1].configuration.entryModuleName === 'first')?.[1].missing)
    .toContain('pending-compiler-reads-at-close');
});
it('detects post-read drift even when the async input size is unchanged', async () => {
  const { result } = await observe('drift');
  expect(result.drift).toEqual(['Input.ets']);
});
it.skipIf(process.platform === 'win32').each(['hardlink', 'sensitive'])('rejects %s async input before hashing', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.textReads).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(digest('PRIVATE_ASYNC_SENTINEL'));
});
