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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-native-dispatch-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function observe(mode = 'normal') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), directory = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const module = join(sdk, 'ets-loader/lib/fast_build/ark_compiler/module/module_mode.js');
  for (const folder of [project, directory, dirname(job), dirname(module)]) { await mkdir(folder, { recursive: true }); }
  const modeText = JSON.stringify(mode), executable = JSON.stringify(process.execPath);
  await writeFile(module, `
    const cp = require('node:child_process'), assert = require('node:assert/strict');
    class ModuleMode {
      generateMergedAbcOfEs2Abc() {
        if (${modeText} === 'throw-method') throw globalThis.officialError;
        const command = this.cmdArgs.join(' ');
        if (['no-dispatch', 'argument-budget', 'byte-budget'].includes(${modeText})) return globalThis.methodResult;
        if (${modeText} === 'throw-exec') {
          assert.throws(() => cp.exec(null), error => error.code === 'ERR_INVALID_ARG_TYPE');
          return globalThis.methodResult;
        }
        if (${modeText} === 'failed') {
          const child = cp.exec('ohmate-command-that-does-not-exist', { cwd: this.projectConfig.projectTopDir });
          child.on('error', () => {});
          globalThis.childResult = child;
          return child;
        }
        const child = cp.exec(command, { cwd: this.projectConfig.projectTopDir });
        globalThis.childResult = child;
        if (${modeText} === 'multiple') {
          const other = cp.exec(command, { cwd: this.projectConfig.projectTopDir });
          globalThis.otherClosed = new Promise(done => other.once('close', done));
        }
        this.projectConfig.buildMode = 'mutated-after-dispatch';
        this.arkConfig.isDebug = false; this.cmdArgs.push('PRIVATE_ARG_SENTINEL');
        return child;
      }
    }
    if (${modeText} === 'locked') Object.freeze(ModuleMode.prototype);
    exports.ModuleMode = ModuleMode;
  `);
  // The record limit concerns shell dispatch, independent of 65 Node cold starts.
  const budgetCommand = process.platform === 'win32' ?
    '<nul set /p "=native-result" & exit /b 0' : "printf '%s' native-result";
  const command = mode === 'failed' ? 'ohmate-command-that-does-not-exist' : mode === 'pending' ?
    `"${process.execPath}" -e "process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('native-result'))"` :
    mode === 'budget' ? budgetCommand :
    `"${process.execPath}" -e "process.stdout.write('native-result')"`;
  await writeFile(job, `
    const assert = require('node:assert/strict'), cp = require('node:child_process'),
      { ModuleMode } = require(${JSON.stringify(module)});
    exports.run = async config => {
      if (${modeText} === 'pending' && config.entryModuleName === 'second') {
        globalThis.pendingChild.stdin.end(); await globalThis.pendingClosed; return;
      }
      globalThis.methodResult = {}; globalThis.officialError = new Error('PRIVATE_ERROR_SENTINEL');
      const owner = new ModuleMode();
      owner.projectConfig = { projectTopDir: config.projectTopDir, entryModuleName: config.entryModuleName,
        buildMode: 'debug', compatibleSdkVersion: 26, rawBody: 'PRIVATE_CONFIG_SENTINEL' };
      Object.defineProperty(owner.projectConfig, 'compileSdkVersion', { get() { throw new Error('getter evaluated'); } });
      owner.arkConfig = { es2abcPath: ${executable}, isDebug: true, optTryCatchFunc: false };
      owner.filesInfoPath = ${JSON.stringify(join(project, 'cache/filesInfo.txt'))};
      owner.npmEntriesInfoPath = ${JSON.stringify(join(project, 'cache/npmEntries.txt'))};
      owner.cacheFilePath = ${JSON.stringify(join(project, 'cache/modules.cache'))};
      owner.moduleAbcPath = ${JSON.stringify(join(project, 'output/modules.abc'))};
      owner.cmdArgs = [${JSON.stringify(command)}];
      if (${modeText} === 'sensitive') owner.filesInfoPath = ${JSON.stringify(join(project, '.env'))};
      if (${modeText} === 'unsafe') owner.cacheFilePath = ${JSON.stringify(join(root, 'outside.cache'))};
      if (${modeText} === 'argument-budget') owner.cmdArgs = Array.from({ length: 257 }, () => 'x');
      if (${modeText} === 'byte-budget') owner.cmdArgs = Array.from({ length: 32 }, () => 'x'.repeat(4096));
      if (${modeText} === 'no-dispatch' || ${modeText} === 'throw-exec' ||
          ${modeText} === 'argument-budget' || ${modeText} === 'byte-budget') {
        owner.generateMergedAbcOfEs2Abc();
        return;
      }
      if (${modeText} === 'throw-method') {
        assert.throws(() => owner.generateMergedAbcOfEs2Abc(), error => error === globalThis.officialError); return;
      }
      if (${modeText} === 'accessor') {
        const saved = owner.cmdArgs; let getterCalls = 0;
        Object.defineProperty(owner, 'cmdArgs', { get() { getterCalls++; return saved; } });
        const child = owner.generateMergedAbcOfEs2Abc();
        assert.equal(getterCalls, 2);
        await new Promise(done => child.once('close', done)); return;
      }
      if (${modeText} === 'mismatch') owner.cmdArgs.join = () => ${JSON.stringify(command + ' ')};
      const child = owner.generateMergedAbcOfEs2Abc();
      assert.equal(child, globalThis.childResult);
      const closed = new Promise(done => child.once('close', (code, signal) => done({code, signal})));
      if (${modeText} === 'pending') {
        globalThis.pendingChild = child; globalThis.pendingClosed = closed;
        await new Promise(done => child.stdout.once('data', done)); return;
      }
      let stdout = ''; child.stdout.on('data', bytes => stdout += bytes);
      const result = await closed;
      if (${modeText} !== 'failed') { assert.deepEqual(result, { code: 0, signal: null }); assert.equal(stdout, 'native-result'); }
      if (globalThis.otherClosed) await globalThis.otherClosed;
      assert.throws(() => process.kill(child.pid, 0));
      if (${modeText} === 'budget') {
        assert(child instanceof cp.ChildProcess);
        const calls = [{ pid: child.pid, close: result, stdout, osExited: true }];
        for (let i = 0; i < 64; i++) {
          owner.cmdArgs = [${JSON.stringify(command)}];
          const another = owner.generateMergedAbcOfEs2Abc();
          assert(another instanceof cp.ChildProcess);
          assert.equal(another, globalThis.childResult);
          let output = '', errors = '';
          another.stdout.on('data', bytes => output += bytes);
          another.stderr.on('data', bytes => errors += bytes);
          const close = await new Promise(done => another.once('close', (code, signal) => done({ code, signal })));
          assert.deepEqual(close, { code: 0, signal: null });
          assert.equal(output, 'native-result'); assert.equal(errors, '');
          assert.throws(() => process.kill(another.pid, 0));
          calls.push({ pid: another.pid, close, stdout: output, osExited: true });
        }
        require('node:fs').writeFileSync(${JSON.stringify(join(root, 'budget-results.json'))}, JSON.stringify(calls));
      }
      const unrelated = cp.exec(${JSON.stringify(command)});
      let unrelatedOutput = '';
      unrelated.stdout.on('data', bytes => unrelatedOutput += bytes);
      const unrelatedClose = await new Promise(done => unrelated.once('close', (code, signal) => done({ code, signal })));
      if (${modeText} === 'budget') {
        assert.deepEqual(unrelatedClose, { code: 0, signal: null });
        assert.equal(unrelatedOutput, 'native-result');
        assert.throws(() => process.kill(unrelated.pid, 0));
      }
    };
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const driver = `const job = require(${JSON.stringify(job)});
    const config = entryModuleName => ({ entryModuleName, projectTopDir: ${JSON.stringify(project)} });
    (${modeText} === 'overlap' ? Promise.all([job.run(config('first')), job.run(config('second'))]) :
      ${modeText} === 'pending' ? job.run(config('first')).then(() => job.run(config('second'))) : job.run(config('entry')))
      .catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['--require', join(root, 'observer.cjs'), '-e', driver], {
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
  const budgetCalls = mode === 'budget' ? JSON.parse(await readFile(join(root, 'budget-results.json'), 'utf8')) : [];
  return { result: await collectCompilerObservations(directory, project, sdk), raw, directory, project, sdk, command, budgetCalls };
}
it('binds one SDK es2abc shell call to immutable configuration, reference paths, command hash and close', async () => {
  const { result, raw, command } = await observe();
  expect(result).toHaveProperty('nativeCalls');
  expect(result.invalid).toBe(false);
  expect(result.nativeCalls).toEqual([expect.objectContaining({
    sequence: 1, configurationIndex: 0, kind: 'sdk-es2abc-shell-call', binding: 'sdk-call-reference-only',
    commandSha256: sha(command), commandBytes: Buffer.byteLength(command), argumentCount: 1,
    projectConfiguration: expect.objectContaining({ buildMode: 'debug', entryModuleName: 'entry', compatibleSdkVersion: 26 }),
    arkConfiguration: expect.objectContaining({ isDebug: true, optTryCatchFunc: false }),
    dispatch: 'returned', pid: expect.any(Number), close: { code: 0, signal: null },
    paths: [
      { role: 'files-info', scope: 'project', path: 'cache/filesInfo.txt' },
      { role: 'npm-entries', scope: 'project', path: 'cache/npmEntries.txt' },
      { role: 'cache-info', scope: 'project', path: 'cache/modules.cache' },
      { role: 'output', scope: 'project', path: 'output/modules.abc' },
    ],
  })]);
  expect(raw[0]![0].nativeCalls).toEqual([]);
  expect(JSON.stringify(raw)).not.toMatch(/PRIVATE_(?:CONFIG|ARG|ERROR)_SENTINEL|process\.stdout\.write/);
  expect(result.files).toEqual([]);
  expect(result.missing).toContain('native-compiler-inputs-unverified');
  expect(result.missing).toContain('full-final-compiler-configuration');
});
it('keeps concurrent native calls attached to their initiating job', async () => {
  const { result } = await observe('overlap');
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls).toHaveLength(2);
  for (const call of result.nativeCalls) {
    expect(call.projectConfiguration.entryModuleName).toBe(result.configurations[call.configurationIndex]!.entryModuleName);
    expect(call.close).toEqual({ code: 0, signal: null });
  }
});
it('seals native events at job close and does not attribute late close to the next invocation', async () => {
  const { result, raw } = await observe('pending');
  const first = raw.find(records => records[0].configuration.entryModuleName === 'first')!;
  const second = raw.find(records => records[0].configuration.entryModuleName === 'second')!;
  expect(first[1].nativeCalls).toHaveLength(1);
  expect(first[1].nativeCalls[0].dispatch).toBe('returned');
  expect(first[1].nativeCalls[0].close).toBe(null);
  expect(first[1].missing).toContain('pending-native-compiler-at-close');
  expect(second[1].nativeCalls).toEqual([]);
  expect(result.invalid).toBe(true);
});
it('does not invoke SDK argument accessors while preparing evidence', async () => {
  const { result } = await observe('accessor');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-call-unobservable');
});
it.each(['sensitive', 'unsafe'])('rejects %s declared paths without copying their names into native evidence', async mode => {
  const { result, raw } = await observe(mode);
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls).toEqual([]);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-call-unobservable');
  expect(JSON.stringify(raw)).not.toContain('outside.cache');
  expect(JSON.stringify(raw)).not.toContain('/.env');
});
it('keeps a command mismatch separate from an observed matching dispatch', async () => {
  const { result } = await observe('mismatch');
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls[0]!.dispatch).toBe('not-observed');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-command-mismatch');
});
it('does not overwrite the first process when an SDK call dispatches more than once', async () => {
  const { result } = await observe('multiple');
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls).toHaveLength(1);
  expect(result.nativeCalls[0]!.close).toEqual({ code: 0, signal: null });
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-multiple-dispatch');
});
it.each(['throw-method', 'throw-exec', 'no-dispatch'])('preserves original %s behavior and leaves dispatch unverified', async mode => {
  const { result } = await observe(mode);
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls[0]!.dispatch).toBe('not-observed');
  expect(result.nativeCalls[0]!.close).toBe(null);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-dispatch-unavailable');
});
it('records a failed shell close without copying native stderr or certifying executable identity', async () => {
  const { result } = await observe('failed');
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls[0]!.close?.code).toBeGreaterThan(0);
  expect(result.nativeCalls[0]!.binding).toBe('sdk-call-reference-only');
  expect(result.missing).toContain('native-compiler-inputs-unverified');
});
it('bounds native call records without interrupting official calls', async () => {
  const { result, budgetCalls, command } = await observe('budget');
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls).toHaveLength(64);
  expect(budgetCalls).toHaveLength(65);
  for (const call of budgetCalls) {
    expect(call).toEqual({ pid: expect.any(Number), close: { code: 0, signal: null },
      stdout: 'native-result', osExited: true });
  }
  expect(result.nativeCalls.map(call => call.pid)).toEqual(budgetCalls.slice(0, 64).map((call: { pid: number }) => call.pid));
  for (const call of result.nativeCalls) {
    expect(call.dispatch).toBe('returned');
    expect(call.close).toEqual({ code: 0, signal: null });
    expect(call.commandSha256).toBe(sha(command));
  }
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-call-budget');
}, 10000);
it.each(['argument-budget', 'byte-budget'])('rejects %s without hashing or retaining oversized commands', async mode => {
  const { result } = await observe(mode);
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls).toEqual([]);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-call-budget');
});
it('preserves a locked SDK method while reporting that observation is unavailable', async () => {
  const { result } = await observe('locked');
  expect(result).toHaveProperty('nativeCalls');
  expect(result.nativeCalls).toEqual([]);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('native-compiler-call-uninstrumentable');
});
it.each(['start', 'sequence', 'role', 'path', 'close', 'count'])('rejects forged native %s records', async mode => {
  const { directory, project, sdk, raw } = await observe();
  expect(raw[0]![1]).toHaveProperty('nativeCalls');
  const records = raw[0]!, call = records[1].nativeCalls[0];
  if (mode === 'start') { records[0].nativeCalls = [call]; }
  if (mode === 'sequence') { call.sequence = 2; }
  if (mode === 'role') { call.paths[0].role = 'actual-native-read'; }
  if (mode === 'path') { call.paths[0].path = join(root, 'outside'); }
  if (mode === 'close') { call.dispatch = 'not-observed'; }
  if (mode === 'count') { records[1].nativeCalls = Array.from({ length: 65 }, () => call); }
  await writeFile(join(directory, (await readdir(directory))[0]!),
    records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const result = await collectCompilerObservations(directory, project, sdk);
  expect(result.invalid).toBe(true);
});
