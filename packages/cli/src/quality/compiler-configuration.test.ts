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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-configuration-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function observe(mode = 'normal') {
  const project = join(root, 'project'), sdk = join(root, 'sdk'), observations = join(root, 'observations');
  const job = join(root, 'hvigor-ohos-plugin/src/tasks/worker/job.js');
  const loader = join(root, 'hvigor-arkts-compose/dist/src/util/load-sdk-functions.js');
  const rollup = join(root, 'hvigor-arkts-base/dist/src/hvigor-compile.js');
  const ark = join(sdk, 'ets-loader/lib/fast_build/ark_compiler/common/process_ark_config.js');
  for (const folder of [project, observations, dirname(job), dirname(loader), dirname(rollup), dirname(ark)]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(join(project, 'loader.json'), '{"processTs":false,"pandaMode":"es2abc"}');
  await writeFile(loader, `
    exports.loadSdkFunctions = config => {
      if (${JSON.stringify(mode)} === 'throw') throw globalThis.officialFailure;
      config.buildMode = 'debug'; config.shouldEmitJs = false;
    };
    if (${JSON.stringify(mode)} === 'locked') Object.freeze(exports);
  `);
  await writeFile(rollup, `
    exports.runHvigorCompile = config => { globalThis.rollupReturn = { config }; return globalThis.rollupReturn; };
  `);
  await writeFile(ark, `
    exports.initArkConfig = config => ({ nodePath: 'node', isDebug: config.buildMode === 'debug',
      es2abcPath: ${JSON.stringify(join(sdk, 'bin/es2abc'))} });
    exports.initArkProjectConfig = context => {
      const loader = JSON.parse(require('node:fs').readFileSync(context.projectConfig.aceBuildJson).toString());
      return { projectRootPath: context.projectConfig.projectTopDir, processTs: loader.processTs,
        pandaMode: loader.pandaMode, hotReload: false, rawBody: 'PRIVATE_CONFIGURATION_SENTINEL' };
    };
  `);
  await writeFile(job, `
    const assert = require('node:assert/strict'), loader = require(${JSON.stringify(loader)}),
      rollup = require(${JSON.stringify(rollup)}), ark = require(${JSON.stringify(ark)});
    exports.run = async input => {
      if (${JSON.stringify(mode)} === 'outside') return;
      const merged = { ...input, buildMode: 'release', shouldEmitJs: true,
        aceBuildJson: ${JSON.stringify(join(project, 'loader.json'))}, rawBody: 'PRIVATE_CONFIGURATION_SENTINEL' };
      Object.defineProperty(merged, 'compileSdkVersion', { get() { throw new Error('getter must not run'); } });
      if (${JSON.stringify(mode)} === 'throw') {
        globalThis.officialFailure = new Error('original failure');
        assert.throws(() => loader.loadSdkFunctions(merged), error => error === globalThis.officialFailure);
        return;
      }
      loader.loadSdkFunctions(merged);
      const compileInput = { ...input, buildMode: merged.buildMode,
        cacheDirectory: ${JSON.stringify(join(project, '.cache'))}, enableFileSystemCache: true };
      const result = rollup.runHvigorCompile(compileInput);
      assert.equal(result, globalThis.rollupReturn);
      const config = ark.initArkConfig(merged), derived = ark.initArkProjectConfig({ projectConfig: merged });
      assert.equal(config.isDebug, true); assert.equal(derived.processTs, false);
      merged.buildMode = 'changed-after-sdk'; compileInput.enableFileSystemCache = false;
      config.isDebug = false; derived.pandaMode = 'changed-after-derivation';
    };
  `);
  await writeFile(join(root, 'observer.cjs'), compilerObserverSource);
  const driver = `
    const job = require(${JSON.stringify(job)});
    (async () => {
      if (${JSON.stringify(mode)} === 'outside') require(${JSON.stringify(loader)}).loadSdkFunctions({});
      const config = entryModuleName => ({entryModuleName, projectTopDir:${JSON.stringify(project)}});
      if (${JSON.stringify(mode)} === 'overlap') await Promise.all([job.run(config('first')), job.run(config('second'))]);
      else await job.run(config('entry'));
    })().catch(error => { console.error(error); process.exitCode=1; });
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
    (await readFile(join(observations, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))));
  return { result: await collectCompilerObservations(observations, project, sdk), raw, observations, project, sdk };
}
it('records SDK merged values, actual Rollup input and derived Ark values before later mutation', async () => {
  const { result } = await observe();
  expect(result.invalid).toBe(false);
  expect(result.configurationStages).toEqual([
    { configurationIndex: 0, stage: 'sdk-loader-input', values: expect.objectContaining({ buildMode: 'release', shouldEmitJs: true }) },
    { configurationIndex: 0, stage: 'sdk-loader-output', values: expect.objectContaining({ buildMode: 'debug', shouldEmitJs: false }) },
    { configurationIndex: 0, stage: 'rollup-input', values: expect.objectContaining({ buildMode: 'debug', enableFileSystemCache: true }) },
    { configurationIndex: 0, stage: 'ark-config', values: expect.objectContaining({ nodePath: 'node', isDebug: true }) },
    { configurationIndex: 0, stage: 'ark-project', values: expect.objectContaining({ processTs: false, pandaMode: 'es2abc', hotReload: false }) },
  ]);
  expect(result.configurations[0]).not.toHaveProperty('buildMode');
  expect(result.missing).toContain('full-final-compiler-configuration');
});
it('excludes unknown content and accessors from configuration snapshots', async () => {
  const { result, raw } = await observe();
  expect(result.configurationStages).toHaveLength(5);
  expect(JSON.stringify(raw)).not.toContain('PRIVATE_CONFIGURATION_SENTINEL');
  expect(result.configurationStages.every(item => !('compileSdkVersion' in item.values))).toBe(true);
});
it('does not manufacture an SDK output snapshot when the original function throws', async () => {
  const { result } = await observe('throw');
  expect(result.invalid).toBe(false);
  expect(result.configurationStages).toEqual([
    { configurationIndex: 0, stage: 'sdk-loader-input', values: expect.objectContaining({ buildMode: 'release' }) },
  ]);
});
it('ignores effective configuration calls outside an actual job invocation', async () => {
  const { result } = await observe('outside');
  expect(result.configurationStages).toEqual([]);
});
it('keeps effective configuration stages in their initiating overlapping job', async () => {
  const { result, raw } = await observe('overlap');
  expect(result.invalid).toBe(false);
  expect(result.configurationStages).toHaveLength(10);
  for (const records of raw) {
    expect(records[0].configurationStages).toEqual([]);
    const closed = records[1];
    expect(closed.configurationStages).toHaveLength(5);
    expect(closed.configurationStages.slice(0, 3).every((item: { values: { entryModuleName: string } }) =>
      item.values.entryModuleName === closed.configuration.entryModuleName)).toBe(true);
  }
});
it('preserves invocation attribution after collecting configuration stages', async () => {
  const { result } = await observe('overlap');
  for (const stage of result.configurationStages.filter(item => item.stage === 'sdk-loader-output')) {
    expect(stage.configurationIndex).toBeTypeOf('number');
    expect(stage.values.entryModuleName).toBe(result.configurations[stage.configurationIndex]!.entryModuleName);
  }
});
it('retains official execution when a configuration export cannot be wrapped', async () => {
  const { result } = await observe('locked');
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-configuration-uninstrumentable');
  expect(result.configurationStages.some(item => item.stage.startsWith('sdk-loader-'))).toBe(false);
});
it.each(['unknown-stage', 'unknown-field', 'budget'])('rejects forged %s configuration stages', async mode => {
  const { observations, project, sdk } = await observe('outside');
  const path = join(observations, (await readdir(observations))[0]!);
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  records[0].configurationStages = [];
  const snapshot = { stage: mode === 'unknown-stage' ? 'certified-final' : 'rollup-input',
    values: mode === 'unknown-field' ? { rawBody: 'PRIVATE_FORGED_SENTINEL' } : { buildMode: 'debug' } };
  records[1].configurationStages = mode === 'budget' ? Array.from({ length: 65 }, () => snapshot) : [snapshot];
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const result = await collectCompilerObservations(observations, project, sdk);
  expect(result.invalid).toBe(true);
  expect(result.missing).toContain('compiler-observation-unreadable');
});
