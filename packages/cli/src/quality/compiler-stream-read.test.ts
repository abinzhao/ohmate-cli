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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-stream-read-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode: string, instrumented = true) {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js'), source = join(project, 'Input.ets');
  for (const path of [project, sdk, directory, dirname(job)]) { await mkdir(path, { recursive: true }); }
  const bytes = mode === 'budget' ? Buffer.alloc(8 * 1024 * 1024 + 1, 65) :
    mode === 'empty' || mode === 'manual-empty' ? Buffer.alloc(0) :
    Buffer.concat([Buffer.from([255, 254]), Buffer.from('original'.repeat(4096), 'utf16le')]);
  await writeFile(source, bytes);
  if (mode === 'hardlink') { await link(source, join(project, 'Alias.ets')); }
  if (mode === 'sensitive') {
    await rm(source); await writeFile(join(project, '.env'), 'PRIVATE_STREAM_SENTINEL');
    await symlink(join(project, '.env'), source);
  }
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  await writeFile(job, `
    const fs = require('node:fs'), fsp = require('node:fs/promises'), assert = require('node:assert/strict');
    const { once } = require('node:events'), { pipeline } = require('node:stream/promises');
    const { Writable } = require('node:stream');
    const file = ${JSON.stringify(source)}, mode = ${JSON.stringify(mode)};
    exports.run = async config => {
      if (mode === 'late' && config.entryModuleName === 'second') {
        for await (const chunk of globalThis.heldStream) assert(Buffer.isBuffer(chunk));
        return;
      }
      if (mode === 'constructor-error') {
        assert.throws(() => fs.createReadStream(file, { start: -1 }), error => error.code === 'ERR_OUT_OF_RANGE');
        return;
      }
      let handle;
      if (mode.includes('handle')) handle = await fsp.open(file, 'r');
      if (mode === 'partial-handle') {
        const part = Buffer.alloc(2);
        assert.equal((await handle.read(part, 0, 2, null)).bytesRead, 2);
      }
      const options = { highWaterMark: 4096 };
      if (mode.startsWith('encoded')) options.encoding = 'utf16le';
      if (mode === 'range') { options.start = 2; options.end = 9; }
      if (mode === 'whole-range') { options.start = 0; options.end = ${bytes.length - 1}; }
      if (mode === 'no-close-event') options.emitClose = false;
      if (mode === 'keep-handle') options.autoClose = false;
      if (mode === 'unknown-fd') { options.fd = fs.openSync(file, 'r'); }
      if (mode === 'fd-handle') options.fd = handle;
      if (mode === 'custom-fs') {
        options.fs = { open: fs.open, read: fs.read, close: fs.close };
      }
      if (mode === 'option-getter') {
        let reads = 0;
        Object.defineProperty(options, 'fs', { enumerable: true, get() {
          reads++; assert.equal(reads, 1); return { open: fs.open, read: fs.read, close: fs.close };
        } });
      }
      if (mode === 'aborted') {
        const controller = new AbortController(); controller.abort(); options.signal = controller.signal;
      }
      const target = mode === 'fd-handle' ? undefined : mode === 'missing' ? file + '.absent' : mode === 'relative' ? './Input.ets' :
        mode === 'url' ? require('node:url').pathToFileURL(file) : file;
      const stream = handle && mode !== 'fd-handle' ? handle.createReadStream(options) : fs.createReadStream(target, options);
      const trace = [];
      stream.on('open', () => trace.push('open'));
      stream.on('end', () => trace.push('end'));
      stream.on('close', () => trace.push('close'));
      if (mode === 'late') { globalThis.heldStream = stream; return; }
      try {
        if (mode === 'missing' || mode === 'aborted') {
          await assert.rejects(pipeline(stream, new Writable({ write(chunk, encoding, done) { done(); } })),
            error => mode === 'missing' ? error.code === 'ENOENT' : error.name === 'AbortError');
          return;
        }
        if (mode === 'paused') {
          await once(stream, 'ready');
          assert.equal(stream.readableFlowing, null); assert.equal(stream.bytesRead, 0);
          assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('readable'), 0);
        }
        if (mode === 'replaced') {
          await once(stream, 'ready');
          await fsp.rename(file, file + '.old');
          await fsp.writeFile(file, Buffer.alloc(${bytes.length}, 65));
        }
        if (mode === 'cancelled') {
          await once(stream, 'ready');
          stream.destroy(); await once(stream, 'close');
          return;
        }
        if (mode === 'manual-eof' || mode === 'manual-chunk' || mode === 'manual-empty') {
          await once(stream, 'ready');
          if (mode === 'manual-chunk') stream.push(Buffer.alloc(${bytes.length}, 65));
          stream.push(null); stream.resume(); await once(stream, 'close');
          return;
        }
        const chunks = [];
        if (mode === 'pipe') {
          await pipeline(stream, new Writable({ highWaterMark: 1, write(chunk, encoding, done) {
            chunks.push(Buffer.from(chunk)); setImmediate(done);
          } }));
        } else if (mode === 'readable') {
          await new Promise((done, reject) => {
            stream.on('error', reject);
            stream.on('readable', () => {
              let chunk; while ((chunk = stream.read()) !== null) chunks.push(chunk);
            });
            stream.on('end', done);
          });
        } else if (mode === 'encoded-data' || mode === 'mutate' || mode === 'changed-during-read') {
          await new Promise((done, reject) => {
            stream.on('error', reject);
            stream.on('data', chunk => {
              chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
              if (mode === 'mutate') chunk.fill(0);
              if (mode === 'changed-during-read' && chunks.length === 1) {
                stream.pause();
                (async () => {
                  const writer = await fsp.open(file, 'r+');
                  try { await writer.writeFile(Buffer.alloc(${bytes.length}, 66)); }
                  finally { await writer.close(); }
                })().then(() => stream.resume(), reject);
              }
            });
            stream.on('end', done);
          });
        } else {
          for await (const chunk of stream) chunks.push(chunk);
        }
        const value = mode.startsWith('encoded') ? chunks.join('') : Buffer.concat(chunks);
        if (mode.startsWith('encoded')) assert.equal(value, '\\uFEFF' + 'original'.repeat(4096));
        else if (mode === 'range') assert.deepEqual(value, Buffer.from(${JSON.stringify([...bytes.subarray(2, 10)])}));
        else if (mode === 'partial-handle') assert.equal(value.length, ${bytes.length - 2});
        else if (mode === 'sensitive') assert.deepEqual(value, Buffer.from('PRIVATE_STREAM_SENTINEL'));
        else assert.equal(value.length, ${bytes.length});
        if (mode === 'drift') await fsp.writeFile(file, Buffer.alloc(${bytes.length}, 66));
        if (mode === 'keep-handle') {
          assert.equal(stream.fd, handle.fd); await handle.close();
        } else if (options.emitClose !== false && !stream.closed) await once(stream, 'close');
        globalThis.lastTrace = trace;
      } finally {
        if (!stream.destroyed) stream.destroy();
        if (handle) await handle.close();
      }
    };
  `);
  await writeFile(join(root, 'driver.cjs'), `
    const fs = require('node:fs');
    const fsp = require('node:fs/promises');
    (async () => {
      if (${JSON.stringify(mode)} === 'unwrappable-stream') {
        const original = fs.createReadStream;
        fs.createReadStream = function(...args) {
          const stream = original.apply(this, args);
          Object.defineProperty(stream, 'push', { value: stream.push, configurable: false, writable: false });
          return stream;
        };
      }
      if (${JSON.stringify(mode)} === 'unwrappable-handle') {
        const original = fsp.open;
        fsp.open = function(...args) {
          return original.apply(this, args).then(handle => {
            Object.defineProperty(handle, 'createReadStream', {
              value: handle.createReadStream, configurable: false, writable: false,
            });
            return handle;
          });
        };
      }
      ${instrumented ? `require(${JSON.stringify(join(root, 'observer.cjs'))});` : ''}
      const job = require(${JSON.stringify(job)});
      await job.run({ entryModuleName: 'first' });
      if (${JSON.stringify(mode)} === 'late') await job.run({ entryModuleName: 'second' });
      console.log(JSON.stringify({ trace: globalThis.lastTrace || [] }));
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
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally { clearTimeout(deadline); }
  expect({ ...exit, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  const raw = await Promise.all((await readdir(directory)).map(async name =>
    (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))));
  return { result: await collectCompilerObservations(directory, project, sdk), raw, bytes,
    trace: JSON.parse(stdout).trace };
}
it.each(['path', 'handle', 'mutate', 'relative', 'url', 'pipe', 'paused', 'whole-range', 'empty',
  'encoded-data', 'encoded-handle', 'no-close-event', 'keep-handle'])('binds actual complete %s stream bytes without adding consumers', async mode => {
  const { result, bytes } = await observe(mode);
  expect(result.invalid).toBe(false);
  expect(result.drift).toEqual([]);
  expect(result.files).toContainEqual(expect.objectContaining({
    path: 'Input.ets', role: 'runtime-read', sha256: digest(bytes), size: bytes.length,
    readMethods: [mode.includes('handle') ? 'FileHandle.createReadStream' : 'fs.createReadStream'],
  }));
  expect(result.textReads).toEqual([]);
});
it.each(['range', 'partial-handle', 'cancelled'])('keeps %s streams out of whole-file fingerprints', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain(mode === 'cancelled' ? 'compiler-stream-incomplete' : 'compiler-read-size');
});
it.each(['unknown-fd', 'custom-fs', 'option-getter', 'unwrappable-handle'])('leaves %s stream origins unavailable without changing the original read', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('compiler-stream-origin-unavailable');
});
it('rejects pathname replacement while preserving bytes from the opened stream', async () => {
  const { result } = await observe('replaced');
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('compiler-filehandle-identity-unavailable');
});
it('keeps post-stream input drift separate from original consumed bytes', async () => {
  const { result } = await observe('drift');
  expect(result.drift).toEqual(['Input.ets']);
});
it('preserves a missing stream open as an absent probe', async () => {
  const { result, raw } = await observe('missing');
  expect(result.invalid).toBe(false);
  expect(result.files).toEqual([]);
  expect(raw[0][1].probes).toContainEqual(expect.objectContaining({ exists: false }));
});
it.each(['aborted', 'constructor-error'])('preserves %s stream errors without whole-file admission', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('compiler-input-unreadable');
});
it('seals pending stream attribution before consumption in a later invocation', async () => {
  const { result, raw } = await observe('late');
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('pending-compiler-reads-at-close');
  expect(raw).toHaveLength(2);
  expect(raw.find(records => records[1].configuration.entryModuleName === 'second')?.[1].files).toEqual([]);
});
it.skipIf(process.platform === 'win32').each(['hardlink', 'sensitive'])('rejects %s stream bytes before hashing', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.textReads).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(digest('PRIVATE_STREAM_SENTINEL'));
});
it.each(['paused', 'pipe', 'handle', 'encoded-data', 'no-close-event', 'keep-handle'])('preserves native %s stream lifecycle and consumption', async mode => {
  const native = await observe(mode, false);
  const observed = await observe(mode);
  expect(observed.trace).toEqual(native.trace);
});
it.each(['readable', 'fd-handle'])('binds %s bytes to the actual opened input', async mode => {
  const { result, bytes } = await observe(mode);
  expect(result.invalid).toBe(false);
  expect(result.files).toContainEqual(expect.objectContaining({
    path: 'Input.ets', sha256: digest(bytes), readMethods: ['fs.createReadStream'],
  }));
});
it.each(['manual-eof', 'manual-chunk', 'manual-empty', 'budget', 'changed-during-read', 'unwrappable-stream'])('does not admit %s stream evidence', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.files).toEqual([]);
});
