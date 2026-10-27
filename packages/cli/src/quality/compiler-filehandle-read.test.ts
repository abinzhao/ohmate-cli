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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-filehandle-read-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode: string) {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js'), source = join(project, 'Input.ets');
  for (const path of [project, sdk, directory, dirname(job)]) { await mkdir(path, { recursive: true }); }
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from('original', 'utf16le')]);
  await writeFile(source, bytes);
  if (mode === 'hardlink') { await link(source, join(project, 'Alias.ets')); }
  if (mode === 'sensitive') {
    await rm(source); await writeFile(join(project, '.env'), 'PRIVATE_HANDLE_SENTINEL');
    await symlink(join(project, '.env'), source);
  }
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  await writeFile(job, `
    const fs = require('node:fs'), fsp = require('node:fs/promises'), assert = require('node:assert/strict');
    const file = ${JSON.stringify(source)}, mode = ${JSON.stringify(mode)};
    exports.run = async config => {
      if (mode === 'late' && config.entryModuleName === 'second') {
        globalThis.releaseHeldRead();
        await globalThis.pendingRead;
        await globalThis.heldHandle.close();
        return;
      }
      if (mode === 'late-open') {
        if (config.entryModuleName === 'first') {
          globalThis.pendingOpen = fsp.open(file, 'r');
          return;
        }
        globalThis.releaseHeldOpen();
        const handle = await globalThis.pendingOpen;
        try { assert.deepEqual(await handle.readFile(), Buffer.from(${JSON.stringify([...bytes])})); }
        finally { await handle.close(); }
        return;
      }
      const target = mode.startsWith('missing-') ? file + '.absent' : mode.startsWith('url-') ?
        require('node:url').pathToFileURL(file) : mode.startsWith('relative-') ? './Input.ets' : file;
      if (mode.startsWith('missing-')) {
        await assert.rejects(fsp.open(target, 'r'), error => error.code === 'ENOENT' && error.path === target);
        return;
      }
      const handle = globalThis.preopened || await fsp.open(target, 'r');
      try {
        if (mode === 'closed') {
          await handle.close();
          await assert.rejects(handle.readFile(), error => error.code === 'EBADF');
          return;
        }
        if (mode === 'partial') {
          const part = Buffer.alloc(2);
          const result = await handle.read(part, 0, 2, null);
          assert.equal(result.bytesRead, 2);
        }
        if (mode === 'replaced') {
          await fsp.rename(file, file + '.old');
          await fsp.writeFile(file, Buffer.alloc(${bytes.length}, 65));
        }
        const read = () => mode.endsWith('promise') ? fsp.readFile(handle,
          mode.startsWith('encoded-') ? 'utf16le' : undefined) :
          handle.readFile(mode.startsWith('encoded-') ? 'utf16le' : undefined);
        if (mode === 'late') {
          globalThis.heldHandle = handle;
          globalThis.pendingRead = read();
          return;
        }
        if (mode === 'aborted') {
          const abort = new AbortController(); abort.abort();
          await assert.rejects(handle.readFile({ signal: abort.signal }), error => error.name === 'AbortError');
          return;
        }
        const value = await read();
        if (mode.startsWith('encoded-')) assert.equal(value, '\\uFEFForiginal');
        else if (mode === 'partial') assert.deepEqual(value, Buffer.from(${JSON.stringify([...bytes.subarray(2)])}));
        else if (mode === 'sensitive') assert.deepEqual(value, Buffer.from('PRIVATE_HANDLE_SENTINEL'));
        else assert.deepEqual(value, Buffer.from(${JSON.stringify([...bytes])}));
        if (mode.startsWith('mutate-')) value.fill(0);
        if (mode === 'drift') await fsp.writeFile(file, Buffer.alloc(${bytes.length}, 66));
      } finally {
        if (mode !== 'late') await handle.close();
      }
    };
  `);
  await writeFile(join(root, 'driver.cjs'), `
    const fsp = require('node:fs/promises'), assert = require('node:assert/strict');
    const mode = ${JSON.stringify(mode)}, file = ${JSON.stringify(source)};
    (async () => {
      if (mode === 'unknown-promise') globalThis.preopened = await fsp.open(file, 'r');
      if (mode.startsWith('unwrappable-') || mode === 'late-open') {
        const original = fsp.open;
        fsp.open = function(...args) {
          return original.apply(this, args).then(handle => {
            if (mode === 'late-open') return new Promise(done => {
              globalThis.releaseHeldOpen = () => done(handle);
            });
            Object.defineProperty(handle, 'readFile', {
              value: handle.readFile, configurable: false, writable: false,
            });
            return handle;
          });
        };
      }
      if (mode === 'late') {
        const original = fsp.open;
        fsp.open = function(...args) {
          return original.apply(this, args).then(handle => {
            const read = handle.readFile;
            handle.readFile = function(...options) {
              return read.apply(this, options).then(value => new Promise(done => {
                globalThis.releaseHeldRead = () => done(value);
              }));
            };
            return handle;
          });
        };
      }
      require(${JSON.stringify(join(root, 'observer.cjs'))});
      if (mode === 'preopened') globalThis.preopened = await fsp.open(file, 'r');
      const job = require(${JSON.stringify(job)});
      await job.run({ entryModuleName: 'first' });
      if (mode === 'late') {
        while (!globalThis.releaseHeldRead) await new Promise(done => setImmediate(done));
        await job.run({ entryModuleName: 'second' });
      }
      if (mode === 'late-open') {
        while (!globalThis.releaseHeldOpen) await new Promise(done => setImmediate(done));
        await job.run({ entryModuleName: 'second' });
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
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
it.each(['handle', 'promise', 'mutate-handle', 'mutate-promise', 'preopened'])('hashes actual %s FileHandle bytes before mutation', async mode => {
  const { result, bytes } = await observe(mode);
  expect(result.invalid).toBe(false);
  expect(result.drift).toEqual([]);
  expect(result.files).toContainEqual(expect.objectContaining({
    path: 'Input.ets', role: 'runtime-read', sha256: digest(bytes), size: bytes.length,
    readMethods: [mode.endsWith('promise') ? 'fs.promises.readFile' : 'FileHandle.readFile'],
  }));
});
it.each(['url-handle', 'url-promise', 'relative-handle', 'relative-promise'])('binds %s to its open-time path', async mode => {
  const { result, bytes } = await observe(mode);
  expect(result.invalid).toBe(false);
  expect(result.files).toContainEqual(expect.objectContaining({ path: 'Input.ets', sha256: digest(bytes) }));
});
it.each(['handle', 'promise'])('keeps encoded %s text separate from file bytes', async api => {
  const { result } = await observe(`encoded-${api}`);
  expect(result.invalid).toBe(false);
  expect(result.files).toEqual([]);
  expect(result.textReads).toContainEqual(expect.objectContaining({
    path: 'Input.ets', method: api === 'promise' ? 'fs.promises.readFile' : 'FileHandle.readFile',
    textSha256: digest('\uFEFForiginal'), binding: 'decoded-filesystem-text', readObserved: false,
  }));
  expect(result.missing).toContain('decoded-filesystem-read-without-raw-bytes');
});
it('keeps a partial FileHandle return out of whole-file fingerprints', async () => {
  const { result } = await observe('partial');
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('compiler-read-size');
});
it('does not substitute a replaced pathname for an open file descriptor', async () => {
  const { result, bytes } = await observe('replaced');
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(digest(bytes));
  expect(result.missing).toContain('compiler-filehandle-identity-unavailable');
});
it('does not infer the origin of a handle created before instrumentation', async () => {
  const { result } = await observe('unknown-promise');
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('compiler-filehandle-origin-unavailable');
});
it.each(['closed', 'aborted'])('preserves the original %s FileHandle failure', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('compiler-input-unreadable');
});
it('records a missing open without changing ENOENT', async () => {
  const { result, raw } = await observe('missing-handle');
  expect(result.invalid).toBe(false);
  expect(result.files).toEqual([]);
  expect(raw[0][1].probes).toContainEqual(expect.objectContaining({ exists: false }));
});
it('keeps post-read drift distinct from descriptor identity', async () => {
  const { result } = await observe('drift');
  expect(result.drift).toEqual(['Input.ets']);
});
it('ends pending handle attribution before the next invocation', async () => {
  const { result, raw } = await observe('late');
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('pending-compiler-reads-at-close');
  expect(raw).toHaveLength(2);
  expect(raw.find(records => records[1].configuration.entryModuleName === 'second')?.[1].files).toEqual([]);
});
it.each(['handle', 'promise'])('preserves an unwrappable %s read with an explicit observation gap', async api => {
  const { result, bytes } = await observe(`unwrappable-${api}`);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-filehandle-uninstrumentable');
  if (api === 'handle') { expect(result.files).toEqual([]); }
  else {
    expect(result.files).toContainEqual(expect.objectContaining({
      path: 'Input.ets', sha256: digest(bytes), readMethods: ['fs.promises.readFile'],
    }));
  }
});
it('keeps a late open gap in its origin invocation and attributes a later read to the current invocation', async () => {
  const { result, raw, bytes } = await observe('late-open');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('pending-compiler-reads-at-close');
  expect(raw).toHaveLength(2);
  const first = raw.find(records => records[1].configuration.entryModuleName === 'first')?.[1];
  const second = raw.find(records => records[1].configuration.entryModuleName === 'second')?.[1];
  expect(first.files).toEqual([]);
  expect(first.missing).toContain('pending-compiler-reads-at-close');
  expect(second.files).toContainEqual(expect.objectContaining({
    path: join(root, 'project/Input.ets'), sha256: digest(bytes), readMethods: ['FileHandle.readFile'],
  }));
  expect(second.missing).not.toContain('pending-compiler-reads-at-close');
  expect(second.missing).not.toContain('compiler-filehandle-origin-unavailable');
});
it.skipIf(process.platform === 'win32').each(['hardlink', 'sensitive'])('rejects %s handle bytes before hashing', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.textReads).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(digest('PRIVATE_HANDLE_SENTINEL'));
});
