/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectCompilerObservations } from './compiler-observations.js';
import { compilerObserverSource } from './compiler-observer-source.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-native-description-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function observe(mode = 'normal') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const module = join(sdk, 'ets-loader/lib/fast_build/ark_compiler/module/module_mode.js');
  for (const folder of [project, directory, dirname(job), dirname(module), join(project, 'cache')]) {
    await mkdir(folder, { recursive: true });
  }
  const modeText = JSON.stringify(mode), command = `"${process.execPath}" -e "process.stdout.write('native-result')"`;
  const bodies = ['\ufeffsource.ets;record;esm;src;package;false;ets\n', 'entry:path\n', 'input;output.proto\n',
    '{"compileEntries":["PRIVATE_BODY_SENTINEL"],"hspPkgNames":[]}'];
  await writeFile(module, `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    class ModuleMode {
      generateCompileContextInfo() {
        const file = path.join(this.projectConfig.cachePath, 'compileContextInfo.json');
        fs.writeFileSync(file, ${JSON.stringify(bodies[3])}, 'utf-8');
        return file;
      }
      generateCompileFilesInfo() {
        if (${modeText} === 'no-write') return globalThis.methodResult;
        let body = ${JSON.stringify(bodies[0])};
        if (${modeText} === 'buffer') body = Buffer.from(body);
        if (${modeText} === 'budget') body = 'x'.repeat(8 * 1024 * 1024 + 1);
        if (${modeText} === 'total-budget') body = 'x'.repeat(6 * 1024 * 1024);
        fs.writeFileSync(this.filesInfoPath, body, ${modeText} === 'encoding' ? 'utf16le' : 'utf8');
        if (${modeText} === 'duplicate-write') fs.writeFileSync(this.filesInfoPath, body, 'utf8');
        if (${modeText} === 'nested-budget' && !globalThis.nesting) {
          globalThis.nesting = true;
          for (let i = 0; i < 64; i++) this.generateCompileFilesInfo();
          globalThis.nesting = false;
        }
        if (${modeText} === 'retry-failed' && globalThis.generated) throw globalThis.officialError;
        globalThis.generated = true;
        if (${modeText} === 'throw-generation') throw globalThis.officialError;
        return globalThis.methodResult;
      }
      generateNpmEntriesInfo() { fs.writeFileSync(this.npmEntriesInfoPath, ${JSON.stringify(bodies[1])}, 'utf8'); }
      generateAbcCacheFilesInfo() { fs.writeFileSync(this.cacheFilePath, ${JSON.stringify(bodies[2])}, 'utf8'); }
      generateMergedAbcOfEs2Abc() {
        const child = cp.exec(this.cmdArgs.join(' '), { cwd: this.projectConfig.projectTopDir });
        globalThis.childResult = child; return child;
      }
    }
    if (${modeText} === 'locked') Object.defineProperty(ModuleMode.prototype, 'generateCompileFilesInfo',
      { writable: false, configurable: false });
    exports.ModuleMode = ModuleMode;
  `);
  await writeFile(job, `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'),
      { ModuleMode } = require(${JSON.stringify(module)});
    const make = config => {
      const owner = new ModuleMode();
      owner.projectConfig = { projectTopDir: config.projectTopDir, cachePath: path.join(config.projectTopDir, 'cache') };
      owner.arkConfig = { es2abcPath: ${JSON.stringify(process.execPath)} };
      owner.filesInfoPath = path.join(owner.projectConfig.cachePath, 'filesInfo.txt');
      owner.npmEntriesInfoPath = path.join(owner.projectConfig.cachePath, 'npmEntries.txt');
      owner.cacheFilePath = path.join(owner.projectConfig.cachePath, 'modules.cache');
      owner.cmdArgs = [${JSON.stringify(command)}]; return owner;
    };
    exports.run = async config => {
      globalThis.methodResult = {}; globalThis.officialError = new Error('PRIVATE_ERROR_SENTINEL');
      globalThis.generated = false;
      if (${modeText} === 'late' && config.entryModuleName === 'second') {
        globalThis.oldOwner.generateCompileFilesInfo(); return;
      }
      const owner = make(config);
      owner.compileContextInfoPath = owner.generateCompileContextInfo();
      if (${modeText} === 'unsafe') owner.filesInfoPath = ${JSON.stringify(join(root, 'outside.txt'))};
      if (${modeText} === 'sensitive') owner.filesInfoPath = path.join(config.projectTopDir, '.env');
      if (${modeText} === 'failed-write') owner.filesInfoPath = path.join(owner.projectConfig.cachePath, 'absent/filesInfo.txt');
      if (${modeText} === 'accessor') {
        let calls = 0; const file = owner.filesInfoPath;
        Object.defineProperty(owner, 'filesInfoPath', { get() { calls++; return file; } });
        owner.generateCompileFilesInfo(); assert.equal(calls, 1);
      } else if (${modeText} === 'failed-write' || ${modeText} === 'throw-generation') {
        assert.throws(() => owner.generateCompileFilesInfo(), error => ${modeText} === 'failed-write' ?
          error.code === 'ENOENT' : error === globalThis.officialError);
      } else { assert.equal(owner.generateCompileFilesInfo(), globalThis.methodResult); }
      owner.generateNpmEntriesInfo(); owner.generateAbcCacheFilesInfo();
      fs.writeFileSync(path.join(config.projectTopDir, 'unrelated.txt'), 'PRIVATE_UNRELATED_SENTINEL');
      if (${modeText} === 'late') {
        globalThis.oldOwner = owner; setImmediate(() => owner.generateCompileFilesInfo()); return;
      }
      if (${modeText} === 'total-budget' || ${modeText} === 'count-budget') {
        for (let i = 0; i < (${modeText} === 'count-budget' ? 64 : 3); i++) owner.generateCompileFilesInfo();
      }
      if (${modeText} === 'rewrite') {
        fs.writeFileSync(owner.filesInfoPath, 'changed-before-dispatch');
        owner.generateCompileFilesInfo(); fs.writeFileSync(owner.filesInfoPath, 'changed-after-generation');
      }
      if (${modeText} === 'retry-failed') {
        assert.throws(() => owner.generateCompileFilesInfo(), error => error === globalThis.officialError);
      }
      const selected = ${modeText} === 'different-owner' ? make(config) : owner;
      if (${modeText} === 'path-drift') selected.filesInfoPath = path.join(config.projectTopDir, 'changed.txt');
      const child = selected.generateMergedAbcOfEs2Abc();
      assert.equal(child, globalThis.childResult);
      let stdout = ''; child.stdout.on('data', bytes => stdout += bytes);
      await new Promise(done => child.once('close', done));
      assert.equal(stdout, 'native-result'); assert.throws(() => process.kill(child.pid, 0));
    };
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const lockedPreload = join(root, 'locked-write.cjs');
  await writeFile(lockedPreload, `if (${modeText} === 'locked-write') Object.defineProperty(require('node:fs'),
    'writeFileSync', { writable: false, configurable: false });`);
  const driver = `const job = require(${JSON.stringify(job)});
    const config = entryModuleName => ({ entryModuleName, projectTopDir: ${JSON.stringify(project)} });
    (${modeText} === 'overlap' ? Promise.all([job.run(config('first')), job.run(config('second'))]) :
      ${modeText} === 'late' ? job.run(config('first')).then(() => job.run(config('second'))) : job.run(config('entry')))
      .catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['--require', lockedPreload, '--require', join(root, 'observer.cjs'), '-e', driver], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
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
  return { result: await collectCompilerObservations(directory, project, sdk), raw, directory, project, sdk, bodies };
}
it('binds generated write fingerprints to the same SDK owner before native dispatch without reading files', async () => {
  const { result, raw, bodies } = await observe();
  expect(result).toHaveProperty('nativeDescriptions');
  const descriptions = (result as typeof result & { nativeDescriptions: Record<string, unknown>[] }).nativeDescriptions;
  expect(result.invalid).toBe(false);
  expect(descriptions).toHaveLength(4);
  const roles = ['compile-context', 'files-info', 'npm-entries', 'cache-info'], order = [3, 0, 1, 2];
  descriptions.forEach((item, index) => expect(item).toMatchObject({
    sequence: index + 1, role: roles[index], binding: 'sdk-write-call-only', write: 'returned', generation: 'returned',
    size: Buffer.byteLength(bodies[order[index]!]!), sha256: sha(bodies[order[index]!]!),
    configurationIndex: 0, scope: 'project', ownerId: expect.any(String), observationOrder: expect.any(Number),
  }));
  expect(result.nativeCalls[0]).toHaveProperty('descriptionSequences', [1, 2, 3, 4]);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('native-compiler-inputs-unverified');
  expect(JSON.stringify(raw)).not.toMatch(/PRIVATE_(?:BODY|UNRELATED|ERROR)_SENTINEL|source\.ets;record/);
  expect(raw[0]![0].nativeDescriptions).toEqual([]);
});
it('hashes Buffer writes before original calls without changing the SDK return', async () => {
  const { result, bodies } = await observe('buffer');
  expect(result).toHaveProperty('nativeDescriptions');
  expect(result).toHaveProperty('nativeDescriptions.1.sha256', sha(bodies[0]!));
});
it.each(['duplicate-write', 'retry-failed'])('does not bind an ambiguous or failed %s generation', async mode => {
  const { result } = await observe(mode);
  const call = result.nativeCalls[0]!;
  const descriptions = (result as typeof result & { nativeDescriptions: { role: string; sequence: number }[] }).nativeDescriptions;
  const files = descriptions.filter(item => item.role === 'files-info').map(item => item.sequence);
  expect((call as typeof call & { descriptionSequences: number[] }).descriptionSequences.some(sequence => files.includes(sequence))).toBe(false);
  expect(result.invalid).toBe(true);
});
it('bounds admitted records during nested generation before method completion', async () => {
  const { result, raw } = await observe('nested-budget');
  expect(raw[0]![1].nativeDescriptions.length).toBeLessThanOrEqual(64);
  expect(result.missing).toContain('native-description-budget');
});
it('links the latest observed generation while leaving subsequent filesystem changes unverified', async () => {
  const { result, bodies } = await observe('rewrite');
  expect(result).toHaveProperty('nativeDescriptions');
  expect(result.nativeCalls[0]).toHaveProperty('descriptionSequences', [1, 3, 4, 5]);
  expect(result).toHaveProperty('nativeDescriptions.4.sha256', sha(bodies[0]!));
  expect(result.files).toEqual([]);
});
it.each(['no-write', 'encoding', 'accessor', 'unsafe', 'sensitive', 'locked', 'locked-write', 'budget', 'total-budget', 'count-budget',
  'failed-write', 'throw-generation', 'path-drift', 'different-owner'])('keeps %s generation incomplete while preserving official behavior', async mode => {
  const { result, raw } = await observe(mode);
  expect(result).toHaveProperty('nativeDescriptions');
  expect(result.missing.some(item => item.startsWith('native-description-'))).toBe(true);
  expect(result.missing).toContain('native-compiler-inputs-unverified');
  expect(JSON.stringify(raw)).not.toMatch(/PRIVATE_(?:BODY|UNRELATED|ERROR)_SENTINEL|outside\.txt|\/\.env"/);
  if (mode === 'failed-write') { expect(result).toHaveProperty('nativeDescriptions.1.write', 'threw'); }
  if (mode === 'throw-generation') { expect(result).toHaveProperty('nativeDescriptions.1.generation', 'threw'); }
});
it('keeps concurrent generation and dispatch linked to their own job configuration', async () => {
  const { result } = await observe('overlap');
  expect(result).toHaveProperty('nativeDescriptions');
  expect(result.nativeCalls).toHaveLength(2);
  const descriptions = (result as typeof result & { nativeDescriptions: { configurationIndex: number; ownerId: string }[] }).nativeDescriptions;
  expect(descriptions).toHaveLength(8);
  for (const call of result.nativeCalls) {
    expect(descriptions.filter(item => item.configurationIndex === call.configurationIndex)).toHaveLength(4);
  }
});
it('cuts off late generation and does not revive an old receiver in a different job', async () => {
  const { result, raw } = await observe('late');
  expect(result).toHaveProperty('nativeDescriptions');
  const first = raw.find(records => records[0].configuration.entryModuleName === 'first')!;
  const second = raw.find(records => records[0].configuration.entryModuleName === 'second')!;
  expect(first[1].nativeDescriptions).toHaveLength(4);
  expect(second[1].nativeDescriptions).toEqual([]);
  expect(result.missing).toContain('native-description-owner-mismatch');
});
it.each(['start', 'sequence', 'owner', 'order', 'path', 'binding', 'write', 'budget', 'duplicate'])('rejects forged description %s bindings', async mode => {
  const { directory, project, sdk, raw } = await observe();
  expect(raw[0]![1]).toHaveProperty('nativeDescriptions');
  const records = raw[0]!, description = records[1].nativeDescriptions[1], call = records[1].nativeCalls[0];
  if (mode === 'start') { records[0].nativeDescriptions = [description]; }
  if (mode === 'sequence') { description.sequence = 3; }
  if (mode === 'owner') { description.ownerId = '00000000-0000-4000-8000-000000000000'; }
  if (mode === 'order') { description.observationOrder = call.observationOrder + 1; }
  if (mode === 'path') { description.path = join(project, 'other.txt'); }
  if (mode === 'binding') { description.binding = 'actual-native-read'; }
  if (mode === 'write') { description.write = 'threw'; }
  if (mode === 'budget') { description.size = 8 * 1024 * 1024 + 1; }
  if (mode === 'duplicate') { call.descriptionSequences = [1, 2, 2, 3, 4]; }
  await writeFile(join(directory, (await readdir(directory))[0]!),
    records.map(record => JSON.stringify(record)).join('\n') + '\n');
  expect((await collectCompilerObservations(directory, project, sdk)).invalid).toBe(true);
});
