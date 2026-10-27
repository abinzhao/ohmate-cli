/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compilerObserverSource } from './compiler-observer-source.js';
import { collectCompilerObservations } from './compiler-observations.js';
import { digest } from './evidence.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-host-text-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode: string, bytes: Uint8Array = Buffer.from('original')) {
  const sdk = join(root, 'sdk'), project = join(root, 'project'), directory = join(root, 'observations');
  const frontend = join(sdk, 'ets-loader/node_modules/typescript/lib/typescript.js');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js'), source = join(project, 'Input.ets');
  for (const path of [project, directory, dirname(frontend), dirname(job)]) { await mkdir(path, { recursive: true }); }
  await writeFile(source, bytes);
  if (mode === 'sensitive-alias') {
    await writeFile(join(project, '.env'), 'PRIVATE_TEST_SENTINEL');
    await rm(source);
    await symlink(join(project, '.env'), source);
  }
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  await writeFile(frontend, `
    exports.createLanguageService = host => host.getScriptSnapshot(${JSON.stringify(source)});
    exports.createWatchCompilerHost = () => ({ readFile: file => require('node:fs').readFileSync(file).toString() });
    exports.createWatchProgram = host => host.readFile(${JSON.stringify(source)});
  `);
  await writeFile(job, `
    const fs = require('node:fs'), ts = require(${JSON.stringify(frontend)}), file = ${JSON.stringify(source)};
    exports.run = async () => {
      const read = () => {
        if (${JSON.stringify(mode)} === 'cached') return 'cached-before-this-invocation';
        if (${JSON.stringify(mode)} === 'encoded') return fs.readFileSync(file, 'utf16le').slice(1);
        const bytes = fs.readFileSync(file);
        if (${JSON.stringify(mode)} === 'utf16') return bytes.toString('utf16le', 2);
        if (${JSON.stringify(mode)} === 'bom') return bytes.toString('utf8', 3);
        return bytes.toString().replace('original', 'modified');
      };
      if (['snapshot', 'cached', 'throw-snapshot', 'oversized-snapshot'].includes(${JSON.stringify(mode)})) {
        ts.createLanguageService({ getScriptSnapshot: () => {
          const text = read(); return { getLength: () => {
            if (${JSON.stringify(mode)} === 'throw-snapshot') throw new Error('snapshot inspection failure');
            return ${JSON.stringify(mode)} === 'oversized-snapshot' ? 8 * 1024 * 1024 + 1 : text.length;
          }, getText: () => text };
        } });
      } else {
        const host = ts.createWatchCompilerHost();
        host.readFile = read;
        ts.createWatchProgram(host);
      }
    };
  `);
  const child = spawn(process.execPath, ['--require', join(root, 'observer.cjs'), '-e',
    `require(${JSON.stringify(job)}).run({ entryModuleName:'entry' }).catch(e => { console.error(e); process.exitCode=1; });`], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  expect({ ...exit, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  return collectCompilerObservations(directory, project, sdk);
}
it.each(['bom', 'utf16'])('keeps %s Host text distinct from actual read bytes after SDK replaces the watch Host', async (mode) => {
  const text = 'original', bytes = mode === 'bom' ? Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)]) :
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
  const result = await observe(mode, bytes);
  expect(result.invalid).toBe(false);
  expect(result.drift).toEqual([]);
  expect(result.files).toContainEqual(expect.objectContaining({
    path: 'Input.ets', sha256: digest(bytes), size: bytes.length, role: 'compiler-host-read',
  }));
  expect(result).toMatchObject({ textReads: [expect.objectContaining({
    path: 'Input.ets', method: 'readFile', textSha256: digest(text), utf8Size: Buffer.byteLength(text),
    binding: 'host-text-only', readObserved: true,
  })] });
});
it('records SDK preprocessing without replacing the source byte hash or manufacturing source drift', async () => {
  const result = await observe('transformed');
  expect(result.invalid).toBe(false);
  expect(result.drift).toEqual([]);
  expect(result.files).toContainEqual(expect.objectContaining({ path: 'Input.ets', sha256: digest('original') }));
  expect(result).toMatchObject({ textReads: [expect.objectContaining({ method: 'readFile', textSha256: digest('modified') })] });
});
it('records the actual ScriptSnapshot text separately from the raw filesystem read', async () => {
  const result = await observe('snapshot');
  expect(result.invalid).toBe(false);
  expect(result).toMatchObject({ textReads: [expect.objectContaining({
    path: 'Input.ets', method: 'getScriptSnapshot', textSha256: digest('modified'), readObserved: true,
  })] });
  expect(result.files).toContainEqual(expect.objectContaining({ path: 'Input.ets', sha256: digest('original') }));
});
it('does not manufacture actual read evidence for a cached snapshot returned without a filesystem read', async () => {
  const result = await observe('cached');
  expect(result.invalid).toBe(false);
  expect(result.files).toEqual([]);
  expect(result).toMatchObject({ textReads: [expect.objectContaining({
    path: 'Input.ets', textSha256: digest('cached-before-this-invocation'), readObserved: false,
  })] });
  expect(result.missing).toContain('host-text-without-observed-read');
});
it('does not present encoded filesystem text as original file bytes or source drift', async () => {
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from('original', 'utf16le')]);
  const result = await observe('encoded', bytes);
  expect(result.invalid).toBe(false);
  expect(result.drift).toEqual([]);
  expect(result.files).toEqual([]);
  expect(result).toMatchObject({ textReads: expect.arrayContaining([expect.objectContaining({
    method: 'readFileSync', textSha256: digest('\uFEFForiginal'), binding: 'decoded-filesystem-text', readObserved: false,
  })]) });
  expect(result.missing).toContain('decoded-filesystem-read-without-raw-bytes');
});
it.each(['throw-snapshot', 'oversized-snapshot'])('retains the official return and degrades %s observation', async (mode) => {
  const result = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-host-text-unreadable');
});
it.skipIf(process.platform === 'win32')('rejects Host text through a sensitive file alias before hashing its content', async () => {
  const result = await observe('sensitive-alias');
  expect(result.invalid).toBe(true);
  expect(result.textReads).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(digest('PRIVATE_TEST_SENTINEL'));
});
