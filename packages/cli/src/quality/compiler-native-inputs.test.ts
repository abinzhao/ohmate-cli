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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-native-input-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
async function observe(mode = 'normal') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const library = join(sdk, 'ets-loader/lib'), job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const utils = join(library, 'fast_build/ark_compiler/utils.js'), nodeWriter = join(library, 'process_module_files.js');
  const module = join(library, 'fast_build/ark_compiler/module/module_mode.js');
  const source = join(project, 'src/main.ets'), destination = join(project, 'cache/main.ts');
  const modeText = JSON.stringify(mode), body = '\ufefflet PRIVATE_SOURCE_SENTINEL = "transformed";\n';
  for (const folder of [directory, dirname(source), dirname(destination), dirname(utils), dirname(module), dirname(job)]) {
    await mkdir(folder, { recursive: true });
  }
  const writer = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    const mode = ${modeText};
    function write(config) {
      if (mode === 'no-write') return;
      if (mode === 'retry-no-write' && globalThis.generated) return;
      let value = ${JSON.stringify(body)};
      if (mode === 'buffer') value = Buffer.from(value);
      if (mode === 'budget') value = 'x'.repeat(8 * 1024 * 1024 + 1);
      fs.writeFileSync(config.destination, value, mode === 'encoding' ? 'utf16le' : 'utf8');
      if (mode === 'duplicate') fs.writeFileSync(config.destination, value, 'utf8');
      if (mode === 'throw-generation' || mode === 'retry-failed' && globalThis.generated) throw globalThis.officialError;
      globalThis.generated = true;
    }
    function operation(config) {
      if (mode === 'sync') { write(config); return globalThis.returnMarker; }
      if (mode === 'completion-order' && !globalThis.generated) {
        write(config);
        globalThis.officialPromise = new Promise(resolve => setImmediate(() => resolve(globalThis.returnMarker)));
        return globalThis.officialPromise;
      }
      const result = new Promise((resolve, reject) => {
        const complete = () => { try { write(config); resolve(globalThis.returnMarker); } catch (error) { reject(error); } };
        if (mode === 'pending') setImmediate(complete); else complete();
      });
      globalThis.officialPromise = result; return result;
    }
  `;
  await writeFile(utils, writer + `
    exports.writeFileContentToTempDir = (source, content, config) => operation(config);
    if (mode === 'locked') Object.defineProperty(exports, 'writeFileContentToTempDir', { writable: false, configurable: false });
  `);
  await writeFile(nodeWriter, writer + `
    exports.writeFileSyncByNode = (node, config, meta, source) => operation(config);
  `);
  await writeFile(module, `
    const fs = require('node:fs'), path = require('node:path');
    class ModuleMode {
      generateCompileFilesInfo() {
        let line = this.destination + ';PRIVATE_RECORD_SENTINEL;esm;PRIVATE_MARKER_SENTINEL;PRIVATE_PACKAGE_SENTINEL;false;ets\\n';
        if (${modeText} === 'malformed') line = this.destination + ';too;few\\n';
        if (${modeText} === 'reference-budget') line = line.repeat(513);
        if (${modeText} === 'bytecode') line = this.destination + ';;;;PRIVATE_PACKAGE_SENTINEL;\\n';
        fs.writeFileSync(this.filesInfoPath, line, 'utf8');
      }
      generateAbcCacheFilesInfo() {
        fs.writeFileSync(this.cacheFilePath, this.destination + ';' + this.destination.replace(/\\.[^.]+$/, '.protoBin') + '\\n', 'utf8');
      }
    }
    exports.ModuleMode = ModuleMode;
  `);
  await writeFile(job, `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'),
      utils = require(${JSON.stringify(utils)}), nodeWriter = require(${JSON.stringify(nodeWriter)}),
      { ModuleMode } = require(${JSON.stringify(module)});
    exports.run = async config => {
      globalThis.returnMarker = {}; globalThis.officialError = new Error('PRIVATE_ERROR_SENTINEL'); globalThis.generated = false;
      let source = ${JSON.stringify(source)}, destination = ${JSON.stringify(destination)};
      if (${modeText} === 'sensitive') source = path.join(config.projectTopDir, '.env');
      if (${modeText} === 'unsafe') destination = ${JSON.stringify(join(root, 'outside.txt'))};
      if (${modeText} === 'unsafe-dot') destination = config.projectTopDir + '/cache/../../outside.txt';
      if (${modeText} === 'failed-write') destination = path.join(config.projectTopDir, 'missing/main.ts');
      if (${modeText} === 'overlap') destination = path.join(config.projectTopDir, 'cache', config.entryModuleName + '.ts');
      let getters = 0;
      const ast = ${modeText} === 'inherited-source' ? Object.create({ fileName: source }) : { fileName: source };
      if (${modeText} === 'accessor-source') Object.defineProperty(ast, 'fileName', { get() { getters++; return source; } });
      const writerConfig = { destination }, run = () => ['ast', 'ast-fallback', 'inherited-source', 'accessor-source'].includes(${modeText}) ?
        nodeWriter.writeFileSyncByNode(ast, writerConfig, {}, ${modeText} === 'ast' ? source : undefined) :
        utils.writeFileContentToTempDir(source, 'PRIVATE_INPUT_SENTINEL', writerConfig);
      const result = run();
      if (${modeText} === 'sync') assert.equal(result, globalThis.returnMarker);
      else assert.equal(result, globalThis.officialPromise);
      if (${modeText} === 'pending') return;
      if (${modeText} === 'completion-order') { source = path.join(config.projectTopDir, 'src/second.ets'); await run(); }
      if (['failed-write', 'throw-generation'].includes(${modeText})) {
        await assert.rejects(result, error => ${modeText} === 'failed-write' ? error.code === 'ENOENT' : error === globalThis.officialError);
      } else await result;
      assert.equal(getters, 0);
      if (${modeText} === 'retry-failed') await assert.rejects(run(), error => error === globalThis.officialError);
      if (${modeText} === 'retry-no-write') await run();
      if (${modeText} === 'attempt-budget') for (let i = 0; i < 513; i++) await
        utils.writeFileContentToTempDir(path.join(config.projectTopDir, 'src', i + '.ets'), '', writerConfig);
      if (${modeText} === 'rewrite') fs.writeFileSync(destination, 'changed-after-generation');
      fs.writeFileSync(path.join(config.projectTopDir, 'unrelated.txt'), 'PRIVATE_UNRELATED_SENTINEL');
      const owner = new ModuleMode(); owner.destination = destination;
      owner.filesInfoPath = path.join(config.projectTopDir, 'cache', config.entryModuleName + '.filesInfo.txt');
      owner.cacheFilePath = path.join(config.projectTopDir, 'cache', config.entryModuleName + '.cache');
      owner.projectConfig = { cachePath: path.join(config.projectTopDir, 'cache') };
      owner.generateCompileFilesInfo(); owner.generateAbcCacheFilesInfo();
    };
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const lock = join(root, 'lock.cjs');
  await writeFile(lock, `if (${modeText} === 'locked-write') Object.defineProperty(require('node:fs'), 'writeFileSync',
    { writable: false, configurable: false });`);
  const driver = `const job = require(${JSON.stringify(job)}), config = name =>
    ({ projectTopDir: ${JSON.stringify(project)}, entryModuleName: name });
    (${modeText} === 'overlap' ? Promise.all([job.run(config('first')), job.run(config('second'))]) : job.run(config('entry')))
      .catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['--require', lock, '--require', join(root, 'observer.cjs'), '-e', driver], {
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
  return { result: await collectCompilerObservations(directory, project, sdk), raw, directory, project, sdk, body, destination };
}
it.each(['normal', 'ast', 'ast-fallback', 'buffer', 'sync'])('binds %s generated byte fingerprints to SDK source arguments and description references', async mode => {
  const { result, raw, body } = await observe(mode);
  expect(result).toHaveProperty('nativeInputWrites');
  const write = raw[0]![1].nativeInputWrites[0];
  expect(write).toMatchObject({ sequence: 1, source: { scope: 'project', path: join(root, 'project/src/main.ets') },
    destination: { scope: 'project', path: join(root, 'project/cache/main.ts') },
    sha256: sha(body), size: Buffer.byteLength(body), write: 'returned', generation: 'returned',
    operation: mode.startsWith('ast') ? 'writeFileSyncByNode' : 'writeFileContentToTempDir', binding: 'sdk-source-write-call-only' });
  expect(raw[0]![1].nativeInputWrites).toHaveLength(1);
  const [files, cache] = raw[0]![1].nativeDescriptions;
  expect(files).toHaveProperty('inputReferences.0.sourceWriteSequence', 1);
  expect(files).toHaveProperty('inputReferences.0.format', 'module');
  expect(files).toHaveProperty('inputReferences.0.fieldSha256', [
    'PRIVATE_RECORD_SENTINEL', 'esm', 'PRIVATE_MARKER_SENTINEL', 'PRIVATE_PACKAGE_SENTINEL', 'false', 'ets'].map(sha));
  expect(cache).toHaveProperty('inputReferences.0.sourceWriteSequence', 1);
  expect(cache).toHaveProperty('inputReferences.0.output.path', join(root, 'project/cache/main.protoBin'));
  expect(write.observationOrder).toBeLessThan(files.observationOrder);
  expect(result.invalid).toBe(false); expect(result.files).toEqual([]);
  expect(result.missing).toContain('native-compiler-inputs-unverified');
  expect(JSON.stringify(raw)).not.toMatch(/PRIVATE_(?:SOURCE|INPUT|RECORD|MARKER|PACKAGE|ERROR|UNRELATED)_SENTINEL/);
});
it('retains generated-write provenance while keeping later filesystem rewrites unverified', async () => {
  const { result, raw, body } = await observe('rewrite');
  expect(result).toHaveProperty('nativeInputWrites.0.sha256', sha(body));
  expect(raw[0]![1]).toHaveProperty('nativeDescriptions.0.inputReferences.0.sourceWriteSequence', 1);
  expect(result.files).toEqual([]);
});
it.each(['duplicate', 'retry-failed', 'throw-generation', 'failed-write', 'no-write', 'encoding', 'locked',
  'locked-write', 'budget', 'sensitive', 'unsafe', 'unsafe-dot', 'inherited-source', 'accessor-source', 'retry-no-write',
  'attempt-budget'])('keeps %s generation unbound without changing SDK results or errors', async mode => {
  const { result, raw } = await observe(mode);
  expect(result).toHaveProperty('nativeInputWrites');
  for (const description of raw[0]![1].nativeDescriptions) {
    for (const reference of description.inputReferences ?? []) { expect(reference.sourceWriteSequence).toBeUndefined(); }
  }
  expect(result.missing.some(item => item.startsWith('native-input-'))).toBe(true);
  expect(JSON.stringify(raw)).not.toMatch(/PRIVATE_(?:SOURCE|INPUT|RECORD|MARKER|PACKAGE|ERROR|UNRELATED)_SENTINEL|outside\.txt|\/\.env"/);
});
it.each(['malformed', 'reference-budget'])('keeps %s description references incomplete and bounded', async mode => {
  const { result, raw } = await observe(mode);
  expect(raw[0]![1]).toHaveProperty('nativeInputWrites');
  expect(result.missing).toContain(mode === 'malformed' ? 'native-input-description-unobservable' : 'native-input-reference-budget');
  expect(raw[0]![1].nativeDescriptions.every((item: { inputReferences?: unknown[] }) =>
    (item.inputReferences?.length ?? 0) <= 512)).toBe(true);
});
it('retains abbreviated bytecode rows as declarations without claiming source generation', async () => {
  const { result, raw } = await observe('bytecode');
  expect(result).toHaveProperty('nativeInputWrites');
  expect(raw[0]![1]).toHaveProperty('nativeDescriptions.0.inputReferences.0.format', 'bytecode');
  expect(raw[0]![1].nativeDescriptions[0].inputReferences[0].sourceWriteSequence).toBeUndefined();
});
it('cuts off pending source generation at job close without attributing late writes', async () => {
  const { result, raw } = await observe('pending');
  expect(result).toHaveProperty('nativeInputWrites', []);
  expect(result.missing).toContain('pending-native-inputs-at-close');
  expect(raw[0]![1].nativeDescriptions).toEqual([]);
});
it('keeps the latest destination write when an older source Promise completes later', async () => {
  const { result, raw } = await observe('completion-order');
  expect(raw[0]![1]).toHaveProperty('nativeDescriptions.0.inputReferences.0.sourceWriteSequence', 2);
  expect(result.invalid).toBe(false);
});
it('attributes concurrent source writes and description references only to their own job', async () => {
  const { result, raw } = await observe('overlap');
  expect(result).toHaveProperty('nativeInputWrites');
  expect(raw).toHaveLength(2);
  for (const records of raw) {
    expect(records[1].nativeInputWrites).toHaveLength(1);
    expect(records[1].nativeInputWrites[0].destination.path).toContain(records[0].configuration.entryModuleName + '.ts');
    expect(records[1].nativeDescriptions[0]).toHaveProperty('inputReferences.0.sourceWriteSequence', 1);
  }
});
it.each(['start', 'sequence', 'order', 'source', 'destination', 'hash', 'binding', 'outcome', 'reference', 'format', 'fields'])(
  'rejects forged generated-input %s evidence', async mode => {
    const { raw, directory, project, sdk } = await observe();
    expect(raw[0]![1]).toHaveProperty('nativeInputWrites');
    const records = raw[0]!, write = records[1].nativeInputWrites[0], reference = records[1].nativeDescriptions[0].inputReferences[0];
    if (mode === 'start') { records[0].nativeInputWrites = [write]; }
    if (mode === 'sequence') { write.sequence = 2; }
    if (mode === 'order') { write.observationOrder = records[1].nativeDescriptions[0].observationOrder + 1; }
    if (mode === 'source') { write.source.path = join(root, 'outside.txt'); }
    if (mode === 'destination') { write.destination.path = join(project, 'changed.ts'); }
    if (mode === 'hash') { write.sha256 = 'invalid'; }
    if (mode === 'binding') { write.binding = 'actual-native-read'; }
    if (mode === 'outcome') { write.generation = 'threw'; }
    if (mode === 'reference') { reference.sourceWriteSequence = 2; }
    if (mode === 'format') { reference.format = 'cache-pair'; }
    if (mode === 'fields') { reference.fieldSha256 = []; }
    await writeFile(join(directory, (await readdir(directory))[0]!),
      records.map(record => JSON.stringify(record)).join('\n') + '\n');
    expect((await collectCompilerObservations(directory, project, sdk)).invalid).toBe(true);
  });
