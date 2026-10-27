/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectCompilerObservations } from './compiler-observations.js';
import { compilerObserverSource } from './compiler-observer-source.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-cache-description-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode = 'normal') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const module = join(sdk, 'ets-loader/lib/fast_build/ark_compiler/module/module_mode.js'), modeText = JSON.stringify(mode);
  for (const folder of [project, directory, dirname(job), dirname(module), join(project, 'cache')]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(module, `
    const fs = require('node:fs'), path = require('node:path');
    class ModuleMode {
      generateNpmEntriesInfo() {
        if (${modeText} === 'retry-no-write' && globalThis.generated) return globalThis.marker;
        if (${modeText} === 'no-write') return globalThis.marker;
        let body = 'PRIVATE_NPM_ENTRY_SENTINEL:PRIVATE_NPM_BUILD_SENTINEL\\n';
        if (${modeText} === 'buffer') body = Buffer.from(body);
        fs.writeFileSync(this.npmEntriesInfoPath, body, globalThis.unknownWrite ? 'utf16le' : 'utf8');
        if (${modeText} === 'duplicate') fs.writeFileSync(this.npmEntriesInfoPath, body, 'utf8');
        if (${modeText} === 'unobserved-write' || globalThis.unknownWrite) fs.writeFileSync(this.npmEntriesInfoPath, body, 'utf16le');
        if (${modeText} === 'throw' || ${modeText} === 'retry-failed' && globalThis.generated) throw globalThis.originalError;
        if (${modeText} === 'nested' && !globalThis.generated) {
          globalThis.generated = true; this.generateNpmEntriesInfo();
        }
        globalThis.generated = true; return globalThis.marker;
      }
      generateAbcCacheFilesInfo() {
        fs.writeFileSync(this.cacheFilePath, this.input + ';' + this.input.replace(/\\.[^.]+$/, '.protoBin') + '\\n', 'utf8');
      }
      generateCompileFilesInfo() {
        fs.writeFileSync(this.filesInfoPath, this.input + ';record;esm;source;package;false;ets\\n', 'utf8');
      }
    }
    if (${modeText} === 'locked') Object.defineProperty(ModuleMode.prototype, 'generateNpmEntriesInfo',
      { writable: false, configurable: false });
    exports.ModuleMode = ModuleMode;
  `);
  const utils = join(dirname(dirname(module)), 'utils.js');
  await writeFile(utils, `exports.writeFileContentToTempDir = (source, content, config) =>
    require('node:fs').writeFileSync(config.destination, content, 'utf8');`);
  await writeFile(job, `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'),
      { ModuleMode } = require(${JSON.stringify(module)}), utils = require(${JSON.stringify(utils)});
    const make = config => {
      const owner = new ModuleMode(), cache = path.join(config.projectTopDir, 'cache');
      const prefix = ${modeText} === 'overlap' ? config.entryModuleName : '';
      owner.npmEntriesInfoPath = path.join(cache, prefix + 'npmEntries.txt');
      owner.cacheFilePath = path.join(cache, prefix + 'modules.cache');
      owner.filesInfoPath = path.join(cache, prefix + 'filesInfo.txt');
      owner.input = owner.npmEntriesInfoPath; return owner;
    };
    exports.run = async config => {
      globalThis.marker = {}; globalThis.originalError = new Error('PRIVATE_ERROR_SENTINEL'); globalThis.generated = false;
      if (${modeText} === 'cross-job' && config.entryModuleName === 'second') {
        globalThis.oldOwner.generateAbcCacheFilesInfo(); return;
      }
      const owner = make(config);
      if (${modeText} === 'accessor') {
        let calls = 0; const file = owner.npmEntriesInfoPath;
        Object.defineProperty(owner, 'npmEntriesInfoPath', { get() { calls++; return file; } });
        assert.equal(owner.generateNpmEntriesInfo(), globalThis.marker); assert.equal(calls, 1);
      } else if (${modeText} === 'throw') {
        assert.throws(() => owner.generateNpmEntriesInfo(), error => error === globalThis.originalError);
      } else assert.equal(owner.generateNpmEntriesInfo(), globalThis.marker);
      if (${modeText} === 'retry-failed') assert.throws(() => owner.generateNpmEntriesInfo(), error => error === globalThis.originalError);
      if (${modeText} === 'retry-no-write' || ${modeText} === 'latest') owner.generateNpmEntriesInfo();
      if (${modeText} === 'other-owner-rewrite' || ${modeText} === 'other-owner-unknown') {
        globalThis.unknownWrite = ${modeText} === 'other-owner-unknown';
        make(config).generateNpmEntriesInfo();
      }
      if (${modeText} === 'other-owner-accessor') {
        const other = make(config), file = other.npmEntriesInfoPath; let calls = 0;
        Object.defineProperty(other, 'npmEntriesInfoPath', { get() { calls++; return file; } });
        other.generateNpmEntriesInfo(); assert.equal(calls, 1);
      }
      if (['source-replacement', 'source-unknown', 'source-unsafe'].includes(${modeText})) {
        const content = ${modeText} === 'source-unknown' ? 'x'.repeat(8 * 1024 * 1024 + 1) : 'PRIVATE_SOURCE_SENTINEL';
        const source = ${modeText} === 'source-unsafe' ? ${JSON.stringify(join(root, 'outside.ets'))} :
          path.join(config.projectTopDir, 'source.ets');
        utils.writeFileContentToTempDir(source, content, { destination: owner.input });
      }
      if (${modeText} === 'different-path') owner.input = path.join(config.projectTopDir, 'cache/other.txt');
      if (${modeText} === 'rewrite') fs.writeFileSync(owner.input, 'PRIVATE_REWRITE_SENTINEL');
      if (${modeText} === 'cross-job') globalThis.oldOwner = owner;
      const selected = ${modeText} === 'different-owner' ? make(config) : owner;
      selected.generateCompileFilesInfo(); selected.generateAbcCacheFilesInfo();
    };
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const driver = `const job = require(${JSON.stringify(job)}), config = entryModuleName =>
    ({ projectTopDir: ${JSON.stringify(project)}, entryModuleName });
    (${modeText} === 'overlap' ? Promise.all([job.run(config('first')), job.run(config('second'))]) :
      ${modeText} === 'cross-job' ? job.run(config('first')).then(() => job.run(config('second'))) : job.run(config('entry')))
      .catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['--require', join(root, 'observer.cjs'), '-e', driver], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
  let exit;
  try {
    exit = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally { clearTimeout(deadline); }
  expect({ exit, stdout, stderr }).toEqual({ exit: { code: 0, signal: null }, stdout: '', stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  const raw = await Promise.all((await readdir(directory)).map(async name =>
    (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))));
  return { result: await collectCompilerObservations(directory, project, sdk), raw, project, sdk, directory };
}
it.each(['normal', 'buffer', 'rewrite', 'latest'])('links %s cache input to its completed npm description write only', async mode => {
  const { result, raw } = await observe(mode), document = raw[0]![1];
  const origin = document.nativeDescriptions.filter((item: { role: string }) => item.role === 'npm-entries').at(-1);
  const cache = document.nativeDescriptions.find((item: { role: string }) => item.role === 'cache-info');
  expect(cache).toHaveProperty('inputReferences.0.sourceDescriptionSequence', origin.sequence);
  expect(cache.inputReferences[0].sourceWriteSequence).toBeUndefined();
  expect(document.nativeDescriptions.find((item: { role: string }) => item.role === 'files-info')
    .inputReferences[0].sourceDescriptionSequence).toBeUndefined();
  expect(result.nativeInputWrites).toEqual([]); expect(result.files).toEqual([]);
  expect(result.invalid).toBe(false); expect(result.missing).toContain('native-compiler-inputs-unverified');
  expect(JSON.stringify(raw)).not.toMatch(/PRIVATE_(?:NPM_ENTRY|NPM_BUILD|ERROR|REWRITE)_SENTINEL/);
});
it.each(['duplicate', 'throw', 'retry-failed', 'retry-no-write', 'no-write', 'unobserved-write',
  'different-owner', 'different-path', 'other-owner-rewrite', 'other-owner-unknown', 'source-unknown',
  'other-owner-accessor', 'source-unsafe', 'accessor', 'locked', 'nested'])(
  'does not restore a cache description source after %s', async mode => {
    const { raw } = await observe(mode);
    for (const records of raw) {
      for (const description of records[1].nativeDescriptions) {
        for (const reference of description.inputReferences) { expect(reference.sourceDescriptionSequence).toBeUndefined(); }
      }
    }
  });
it('uses a later observed source writer instead of an earlier npm description', async () => {
  const { result, raw } = await observe('source-replacement');
  expect(raw[0]![1].nativeDescriptions.at(-1)).toHaveProperty('inputReferences.0.sourceWriteSequence', 1);
  expect(raw[0]![1].nativeDescriptions.at(-1).inputReferences[0].sourceDescriptionSequence).toBeUndefined();
  expect(result.invalid).toBe(false);
});
it('does not reuse the first job npm owner in a later job', async () => {
  const { raw } = await observe('cross-job');
  expect(raw).toHaveLength(2);
  const first = raw.find(records => records[0].configuration.entryModuleName === 'first')!;
  const second = raw.find(records => records[0].configuration.entryModuleName === 'second')!;
  expect(first[1].nativeDescriptions.at(-1)).toHaveProperty('inputReferences.0.sourceDescriptionSequence', 1);
  expect(second[1].nativeDescriptions).toEqual([]);
  expect(second[1].missing).toContain('native-description-owner-mismatch');
});
it('keeps concurrent npm description origins within the initiating job', async () => {
  const { result, raw } = await observe('overlap');
  expect(raw).toHaveLength(2); expect(result.invalid).toBe(false);
  for (const records of raw) {
    const cache = records[1].nativeDescriptions.find((item: { role: string }) => item.role === 'cache-info');
    expect(cache).toHaveProperty('inputReferences.0.sourceDescriptionSequence', 1);
    expect(cache.inputReferences[0].input.path).toContain(records[0].configuration.entryModuleName + 'npmEntries.txt');
  }
});
it.each(['sequence', 'owner', 'path', 'order', 'generation', 'write', 'role', 'format', 'double-source', 'replaced'])(
  'rejects forged cache description source %s evidence', async mode => {
    const { raw, directory, project, sdk } = await observe(), records = raw[0]!, document = records[1];
    const origin = document.nativeDescriptions[0], cache = document.nativeDescriptions.at(-1), reference = cache.inputReferences[0];
    reference.sourceDescriptionSequence = 1;
    if (mode === 'sequence') { reference.sourceDescriptionSequence = 64; }
    if (mode === 'owner') { origin.ownerId = 'a'.repeat(8) + '-aaaa-4aaa-aaaa-' + 'a'.repeat(12); }
    if (mode === 'path') { origin.path = join(project, 'other.txt'); }
    if (mode === 'order') { origin.observationOrder = cache.observationOrder + 1; }
    if (mode === 'generation') { origin.generation = 'threw'; }
    if (mode === 'write') { origin.write = 'threw'; }
    if (mode === 'role') { origin.role = 'compile-context'; origin.operation = 'generateCompileContextInfo'; }
    if (mode === 'format') {
      document.nativeDescriptions[1].inputReferences[0].sourceDescriptionSequence = 1;
      delete reference.sourceDescriptionSequence;
    }
    if (mode === 'double-source') { reference.sourceWriteSequence = 1; }
    if (mode === 'replaced') {
      const later = { ...origin, sequence: 2, observationOrder: origin.observationOrder + 1 };
      for (const item of document.nativeDescriptions.slice(1)) { item.observationOrder++; }
      document.nativeDescriptions.splice(1, 0, later);
      document.nativeDescriptions.forEach((item: { sequence: number }, index: number) => item.sequence = index + 1);
    }
    await writeFile(join(directory, (await readdir(directory))[0]!),
      records.map(record => JSON.stringify(record)).join('\n') + '\n');
    expect((await collectCompilerObservations(directory, project, sdk)).invalid).toBe(true);
  });
