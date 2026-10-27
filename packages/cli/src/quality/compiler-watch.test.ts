/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compilerObserverSource } from './compiler-observer-source.js';
import { collectCompilerObservations } from './compiler-observations.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-watch-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode = 'normal') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), observations = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const task = join(root, 'hvigor-arkts-base/node_modules/rollup-lite/dist/shared/watch.js');
  const compose = join(root, 'hvigor-arkts-compose/dist/src/arkts-pack.js');
  for (const folder of [project, sdk, observations, dirname(job), dirname(task), dirname(compose)]) {
    await mkdir(folder, { recursive: true });
  }
  for (const name of ['First.ets', 'Second.ets', 'Late.ets']) {
    await writeFile(join(project, name), name);
  }
  await writeFile(task, `
    const fs = require('node:fs');
    exports.Task = class {
      constructor(config) {
        this.config = config; this.closed = false; this.watcher = { emitter: {
          emit: async function(event, value) {
            require('node:assert/strict').equal(this, globalThis.emitter);
            globalThis.events.push([event, value.code]); return globalThis.emitReturn;
          }
        } };
        globalThis.emitter = this.watcher.emitter;
        if (${mode === 'locked-emitter'}) Object.freeze(this.watcher.emitter);
      }
      async run() {
        await this.watcher.emitter.emit('event', {code:'BUNDLE_START', lastChangedFiles:new Map([[this.config.file,'update']])});
        if (this.config.pending) {
          await new Promise(done => {
            fs.readFile(${JSON.stringify(join(project, 'Late.ets'))}, (error, value) => { done(); });
            if (this.config.closeFailure) {
              require('node:assert/strict').throws(()=>this.close(), error=>error===globalThis.originalError);
            } else this.close();
          });
        } else fs.readFileSync(this.config.file);
        if (this.config.failure) {
          await this.watcher.emitter.emit('event', {code:'ERROR', error:globalThis.originalError});
          throw globalThis.originalError;
        }
        const event = {code:'BUNDLE_END', lastReUsedFiles:new Set([${JSON.stringify(join(project, 'First.ets'))}])};
        if (this.config.sensitive) event.lastReUsedFiles.add(${JSON.stringify(join(project, '.env'))});
        Object.defineProperty(event, 'result', {get() {throw Error('private cache contents must not be read');}});
        const value = await this.watcher.emitter.emit('event', event);
        require('node:assert/strict').equal(value, globalThis.emitReturn);
        return globalThis.runReturn;
      }
      async hotCompile() { return this.run(); }
      close() {
        if (this.config.closeFailure === 'before') throw globalThis.originalError;
        this.closed = true;
        if (this.config.closeFailure === 'after') throw globalThis.originalError;
        return globalThis.closeReturn;
      }
    };
    if (${mode === 'locked-task'}) Object.freeze(exports.Task.prototype);
  `);
  await writeFile(job, 'exports.run = async callback => callback();');
  await writeFile(compose, `
    exports.watch = async config => {
      config.watchMode = 'true';
      const task = new (require(${JSON.stringify(task)}).Task)(config);
      globalThis.task = task;
      return task.run();
    };
    if (${mode === 'locked-watch'}) Object.freeze(exports);
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const driver = `
    const assert = require('node:assert/strict'), compose = require(${JSON.stringify(compose)});
    globalThis.events=[]; globalThis.emitReturn={emitted:true}; globalThis.runReturn={run:true};
    globalThis.closeReturn={close:true}; globalThis.originalError=Error('original watch failure');
    (async () => {
      const config={projectTopDir:${JSON.stringify(project)},file:${JSON.stringify(join(project, 'First.ets'))},
        pending:${['pending', 'pending-close-error'].includes(mode)},sensitive:${mode === 'sensitive'},
        closeFailure:${JSON.stringify(mode === 'pending-close-error' ? 'before' : mode === 'close-error-after' ? 'after' : '')}};
      assert.equal(await compose.watch(config), globalThis.runReturn);
      const task=globalThis.task;
      if (${mode === 'budget'}) for(let index=0;index<70;index++) await task.run();
      if (!config.pending) {
        config.file=${JSON.stringify(join(project, 'Second.ets'))};
        config.failure=${mode === 'error'};
        if (config.failure) await assert.rejects(task.hotCompile(), error=>error===globalThis.originalError);
        else assert.equal(await task.hotCompile(), globalThis.runReturn);
        if (config.closeFailure) assert.throws(()=>task.close(), error=>error===globalThis.originalError);
        else assert.equal(task.close(), globalThis.closeReturn);
      }
      if (${mode === 'second-session'}) {
        await compose.watch({projectTopDir:${JSON.stringify(project)},targetName:'other',
          file:${JSON.stringify(join(project, 'Second.ets'))}});
        assert.equal(globalThis.task.close(), globalThis.closeReturn);
      }
      await require(${JSON.stringify(job)}).run(()=>require('node:fs').readFileSync(${JSON.stringify(join(project, 'Second.ets'))}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const child = spawn(process.execPath, ['--require', join(root, 'observer.cjs'), '-e', driver], {
    cwd: project, env: { HOME: root, USERPROFILE: root, TMPDIR: tmpdir(),
      OHMATE_COMPILER_PROJECT: project, OHMATE_COMPILER_SDK: sdk, OHMATE_COMPILER_OBSERVATIONS: observations },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
  let exit;
  try {
    exit = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally { clearTimeout(deadline); }
  expect({ exit, stdout, stderr }).toEqual({ exit: { code: 0, signal: null }, stdout: '', stderr: '' });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  const raw = await Promise.all((await readdir(observations)).map(async name =>
    ({ path: join(observations, name), records: (await readFile(join(observations, name), 'utf8')).trim()
      .split('\n').map(line => JSON.parse(line)) })));
  return { result: await collectCompilerObservations(observations, project, sdk), raw, observations, project, sdk };
}
it('records independent Watch rounds after setup returns, preserving original returns and event dispatch', async () => {
  const { result, raw } = await observe();
  expect(result.invalid).toBe(false);
  expect(result.watchRounds).toEqual([
    expect.objectContaining({ round: 1, operation: 'run', events: ['BUNDLE_START', 'BUNDLE_END'], taskClosed: false,
      changedFiles: ['First.ets'], reusedFiles: ['First.ets'], binding: 'rollup-reported' }),
    expect.objectContaining({ round: 2, operation: 'hotCompile', events: ['BUNDLE_START', 'BUNDLE_END'], taskClosed: false,
      changedFiles: ['Second.ets'], reusedFiles: ['First.ets'], binding: 'rollup-reported' }),
    expect.objectContaining({ round: 3, operation: 'close', events: [], taskClosed: true }),
  ]);
  const rounds = raw.filter(item => item.records[1].watch?.operation !== 'close' && item.records[1].watch);
  expect(rounds).toHaveLength(2);
  expect(rounds[0]!.records[1].watch.sessionId).toBe(rounds[1]!.records[1].watch.sessionId);
  for (const { records } of rounds) {
    const round = records[1].watch.round;
    expect(records[1].files.map((file: { path: string }) => file.path))
      .toEqual([join(root, 'project', round === 1 ? 'First.ets' : 'Second.ets')]);
  }
  expect(result.missing).toContain('watch-cache-reuse-unverified');
});
it('retains original Watch failures without manufacturing a bundle completion', async () => {
  const { result } = await observe('error');
  expect(result.watchRounds.find(item => item.round === 2)?.events).toEqual(['BUNDLE_START', 'ERROR']);
  expect(result.watchRounds.some(item => item.operation === 'close' && item.taskClosed)).toBe(true);
});
it('closes the active round immediately and excludes asynchronous bytes returned after Task.close', async () => {
  const { result, raw } = await observe('pending');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('pending-compiler-reads-at-close');
  expect(result.watchRounds.find(item => item.operation === 'run')?.taskClosed).toBe(true);
  expect(raw.every(item => !JSON.stringify(item.records[1].files).includes('Late.ets'))).toBe(true);
  const ordinary = raw.find(item => !item.records[1].watch && item.records[1].files.length);
  expect(ordinary!.records[1].files.map((file: { path: string }) => file.path)).toEqual([join(root, 'project/Second.ets')]);
});
it('rejects sensitive Watch paths without serializing cache bodies or sensitive names', async () => {
  const { result, raw } = await observe('sensitive');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('unsafe-watch-input');
  expect(JSON.stringify(raw)).not.toContain(join(root, 'project/.env'));
});
it.each(['locked-task', 'locked-watch'])('preserves official execution for %s exports and retains a coverage gap', async mode => {
  const { result } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('watch-uninstrumentable');
});
it('preserves event dispatch when the official emitter is not writable', async () => {
  const { result } = await observe('locked-emitter');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('watch-uninstrumentable');
});
it.each(['pending-close-error', 'close-error-after'])('retains the original %s exception and a failed-close gap', async mode => {
  const { result, raw } = await observe(mode);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('watch-close-failed');
  expect(result.watchRounds.find(item => item.operation === 'close')?.taskClosed).toBe(mode === 'close-error-after');
  if (mode === 'pending-close-error') {
    expect(result.missing).toContain('pending-compiler-reads-at-close');
    expect(result.watchRounds.find(item => item.operation === 'run')?.taskClosed).toBe(true);
    expect(raw.every(item => !JSON.stringify(item.records[1].files).includes('Late.ets'))).toBe(true);
  }
});
it('keeps separate sessions with different configurations independent', async () => {
  const { result } = await observe('second-session');
  expect(result.invalid).toBe(false);
  expect(new Set(result.watchRounds.map(item => item.sessionId)).size).toBe(2);
});
it.each(['pid', 'configuration'])('rejects a Watch session assembled from different %s values', async mode => {
  const { raw, observations, project, sdk } = await observe();
  const target = raw.find(item => item.records[1].watch?.round === 2)!;
  for (const record of target.records) {
    if (mode === 'pid') { record.pid++; }
    else { record.configuration.targetName = 'different-target'; }
  }
  await writeFile(target.path, target.records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const result = await collectCompilerObservations(observations, project, sdk);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('watch-session-identity-mismatch');
});
it('bounds Watch journal creation while preserving subsequent official execution', async () => {
  const { result, raw } = await observe('budget');
  expect(raw.length).toBeLessThanOrEqual(64);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-observation-unfinished');
});
it.each(['unknown', 'duplicate', 'missing-round', 'after-close'])('rejects forged %s Watch lifecycle evidence', async mode => {
  const { raw, observations, project, sdk } = await observe();
  const selected = raw.filter(item => item.records[1].watch);
  expect(selected.length).toBe(3);
  const ordered = selected.sort((a, b) => a.records[1].watch.round - b.records[1].watch.round);
  const target = ordered[mode === 'duplicate' ? 1 : 2]!;
  if (mode === 'unknown') { target.records[1].watch.events.push('CERTIFIED_CACHE'); }
  if (mode === 'duplicate') { target.records[1].watch.round = 1; }
  if (mode === 'missing-round') { target.records[1].watch.round = 4; }
  if (mode === 'after-close') {
    ordered[0]!.records[1].watch.operation = 'close'; ordered[0]!.records[1].watch.taskClosed = true;
    await writeFile(ordered[0]!.path, ordered[0]!.records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  await writeFile(target.path, target.records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const result = await collectCompilerObservations(observations, project, sdk);
  expect(result.invalid).toBe(true);
  expect(result.missing.some(item => item.startsWith('compiler-observation-') || item.startsWith('watch-'))).toBe(true);
});
