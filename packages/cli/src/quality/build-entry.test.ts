/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ToolProvider } from '../toolchain/index.js';
import { runTerminal } from '../terminal/index.js';
import { applySigning, prepareSigning } from './build-signing.js';
import { Project } from '../utils/project.js';
import { digest } from './evidence.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-build-entry-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function put(file: string, text: string) {
  await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), text);
}
async function fixture(mode = 'success', signing = false) {
  await put('build-profile.json5', JSON5.stringify({ app: { products: [{ name: 'default' }],
    ...(signing ? { signingConfigs: [{ name: 'acceptance' }, { name: 'original' }] } : {}) },
    modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] }] }));
  await put('AppScope/app.json5', '{"app":{"bundleName":"org.example.build","versionCode":1}}');
  await put('oh-package.json5', '{"name":"acceptance","version":"1.0.0"}');
  await put('entry/oh-package.json5', '{"name":"entry","version":"1.0.0"}');
  await put('entry/src/main/module.json5', '{"module":{"name":"entry","type":"entry"}}');
  await put('official/sdk/default/sdk-pkg.json', '{"data":{"apiVersion":26}}');
  await put('official/hvigor.cjs', `
    const fs=require('node:fs'), path=require('node:path'), args=process.argv.slice(2);
    fs.mkdirSync('build',{recursive:true});
    fs.appendFileSync('build/calls.jsonl',JSON.stringify({args,home:process.env.HOME})+'\\n');
    if(args.includes('--help')) console.log('--no-daemon');
    else if(args.includes('tasks')) console.log('assembleHap - Assemble HAP\\nassembleHsp - Assemble HSP\\nassembleApp - Assemble App');
    else if(args.some(a=>a.startsWith('assemble'))) {
      const profile=fs.readFileSync('build-profile.json5','utf8');
      fs.writeFileSync('build/observed-profile.txt',profile);
      if('${mode}'==='failure') { console.error('original compiler diagnostic'); process.exitCode=7; }
      else if('${mode}'==='conflict') fs.appendFileSync('build-profile.json5','\\n// subsequent external edit\\n');
      else {
        fs.mkdirSync('entry/build/default/outputs/default',{recursive:true});
        fs.writeFileSync('entry/build/default/outputs/default/entry-default-unsigned.hap','fixture artifact');
        if(args.includes('assembleApp')) {
          fs.mkdirSync('build/outputs/default',{recursive:true});
          fs.writeFileSync('build/outputs/default/acceptance.app','fixture app');
        }
      }
    }
  `);
  await put('official/ohpm.cjs', "require('node:fs').appendFileSync('build/calls.jsonl',JSON.stringify({args:['ohpm',...process.argv.slice(2)]})+'\\n');\n");
  const provider = { nodePath: process.execPath, javaPath: process.execPath,
    hvigorJsPath: join(root, 'official/hvigor.cjs'), ohpmJsPath: join(root, 'official/ohpm.cjs'),
    sdkPath: join(root, 'official/sdk'), sourceType: 'studio', assertJava: () => undefined, readVersion: () => '26.0.0.821' } as unknown as ToolProvider;
  vi.spyOn(ToolProvider, 'new').mockResolvedValue(provider);
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'state') });
  return { context, runtime: await createRuntime() };
}
async function approved(setup: Awaited<ReturnType<typeof fixture>>, input: unknown, id = 'deveco.build') {
  const plan = await setup.runtime.execute(id, input, setup.context);
  expect(plan.exitCode).toBe(5);
  return { plan, result: await setup.runtime.execute(id, input, { ...setup.context,
    policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } }) };
}
async function calls() {
  return (await readFile(join(root, 'build/calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

async function outputLayoutFixture(mode = 'fresh') {
  const base = 'official/hvigor-ohos-plugin/src/common/iml';
  await put(`${base}/module-path-info-iml.js`, `
    const path = require('node:path');
    exports.ModulePathInfoIml = class {
      constructor(target = 'default') {
        this._modulePath = path.resolve('entry'); this._productName = 'default'; this._targetName = target;
      }
      getModuleBuildOutputPath() {
        const moved = '${mode}' === 'moved' && require('node:fs').existsSync('build/move-output');
        return path.resolve((moved ? 'build/changed/outputs/' : 'build/custom/outputs/') + this._targetName);
      }
    };
  `);
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('tasks') || args.includes('assembleHap') || args.includes('assembleApp')) {
      const { ModulePathInfoIml } = require('./hvigor-ohos-plugin/src/common/iml/module-path-info-iml.js');
      const info = new ModulePathInfoIml('${mode}' === 'wrong-target' ? 'other' : 'default');
      let output;
      if('${mode}' !== 'late' || args.includes('assembleHap') || args.includes('assembleApp')) output = info.getModuleBuildOutputPath();
      if(args.includes('assembleHap') || args.includes('assembleApp')) {
        fs.rmSync('entry/build/default/outputs/default', {recursive:true,force:true});
        if('${mode}' === 'moved') {
          fs.writeFileSync('build/move-output', '');
          output = info.getModuleBuildOutputPath();
        }
        fs.mkdirSync(output, {recursive:true});
        if('${mode}' !== 'stale') fs.writeFileSync(path.join(output, 'custom-unsigned.hap'), 'custom artifact');
      }
    }\n`, { flag: 'a' });
  if (mode === 'stale') { await put('build/custom/outputs/default/custom-unsigned.hap', 'custom artifact'); }
}

it('collects a custom output path observed before the build and preserves its incomplete identity', async () => {
  const setup = await fixture(); await outputLayoutFixture();
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ buildId: null, provenance: { completeness: 'incomplete',
    outputLayout: { binding: 'observed-partial', paths: [expect.objectContaining({
      scope: 'module', modulePath: 'entry', target: 'default', product: 'default', path: 'build/custom/outputs/default',
    })] }, missingArtifacts: [], artifactEvidence: [expect.objectContaining({
      path: join(root, 'build/custom/outputs/default/custom-unsigned.hap'), status: 'fresh', sha256: digest('custom artifact'),
    })],
  } });
});

it('retains a custom artifact unchanged since the precompile snapshot as reused-unverified', async () => {
  const setup = await fixture(); await outputLayoutFixture('stale');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { missingArtifacts: ['entry@default'],
    artifactEvidence: [expect.objectContaining({ status: 'reused-unverified', sha256: digest('custom artifact') })],
  } });
});

it('does not call an output first observed during compilation fresh without a precompile baseline', async () => {
  const setup = await fixture(); await outputLayoutFixture('late');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { missingArtifacts: ['entry@default'],
    artifactEvidence: [expect.objectContaining({ status: 'baseline-unavailable', sha256: digest('custom artifact') })],
  } });
});

it('does not let a custom output for another target satisfy the selected facet', async () => {
  const setup = await fixture(); await outputLayoutFixture('wrong-target');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { outputLayout: { paths: [expect.objectContaining({ target: 'other' })] },
    missingArtifacts: ['entry@default'],
  } });
});

it('keeps both observed layouts and rejects a directory changed after the precompile snapshot', async () => {
  const setup = await fixture(); await outputLayoutFixture('moved');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { outputLayout: { paths: [
    expect.objectContaining({ path: 'build/custom/outputs/default' }),
    expect.objectContaining({ path: 'build/changed/outputs/default' }),
  ] }, missingArtifacts: ['entry@default'],
  artifactEvidence: [expect.objectContaining({ status: 'baseline-unavailable', sha256: digest('custom artifact') })],
  } });
});

it('collects custom product outputs through the same precompile path observations', async () => {
  const setup = await fixture(); await outputLayoutFixture();
  await put('official/hvigor-ohos-plugin/src/common/iml/project-path-info-iml.js', `
    exports.ProjectPathInfoIml = class {
      constructor() { this._productName = 'default'; }
      getProjectOutputPath() { return require('node:path').resolve('build/custom-product/default'); }
    };
  `);
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('tasks') || args.includes('assembleApp')) {
      const { ProjectPathInfoIml } = require('./hvigor-ohos-plugin/src/common/iml/project-path-info-iml.js');
      const output = new ProjectPathInfoIml().getProjectOutputPath();
      if(args.includes('assembleApp')) {
        fs.rmSync('build/outputs/default', {recursive:true,force:true});
        fs.mkdirSync(output, {recursive:true});
        fs.writeFileSync(path.join(output, 'custom.app'), 'custom product');
      }
    }\n`, { flag: 'a' });
  const { result } = await approved(setup, { product: 'default' });
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { outputLayout: { paths: expect.arrayContaining([
    expect.objectContaining({ scope: 'product', product: 'default', path: 'build/custom-product/default' }),
  ]) }, missingArtifacts: [], artifactEvidence: expect.arrayContaining([
    expect.objectContaining({ path: join(root, 'build/custom-product/default/custom.app'), status: 'fresh', sha256: digest('custom product') }),
  ]) } });
});

it('routes plain build through native provenance and installs dependencies when sync is required', async () => {
  const setup = await fixture();
  expect(setup.runtime.registry.get('deveco.build')?.adapter).toBe('native');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.provenance).toMatchObject({ adapter: 'native', manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const invoked = await calls();
  expect(invoked.findIndex((item) => item.args[0] === 'ohpm')).toBeLessThan(invoked.findIndex((item) => item.args.includes('--sync')));
  expect(invoked.some((item) => item.args.includes('module=entry@default') && item.args.includes('assembleHap'))).toBe(true);
});

async function compilerFixture() {
  const base = 'official/sdk/default/openharmony/ets/build-tools/ets-loader';
  const platform = process.platform === 'darwin' ? 'build-mac' : process.platform === 'win32' ? 'build-win' : 'build';
  const executable = `${base}/bin/ark/${platform}/bin/es2abc${process.platform === 'win32' ? '.exe' : ''}`;
  await put(`${base}/package.json`, '{"name":"compilier","version":"0.0.1"}');
  await put(`${base}/node_modules/typescript/package.json`, '{"name":"ohos-typescript","version":"4.9.5-r4"}');
  await put(`${base}/node_modules/arkguard/package.json`, '{"name":"arkguard","version":"1.1.3"}');
  await put(executable, 'compiler executable identity');
  return executable;
}
it('records SDK components and a default es2abc candidate without inventing its version or execution', async () => {
  const setup = await fixture(), executable = await compilerFixture();
  const plan = await setup.runtime.execute('deveco.build', {}, setup.context);
  expect(plan.data).toMatchObject({ review: { tools: { compilerIdentity: {
    components: {
      es2abc: { sha256: digest('compiler executable identity'), version: null, executionObserved: false },
      typescriptPackage: { version: '4.9.5-r4', executionObserved: false },
      arkguardPackage: { version: '1.1.3', executionObserved: false },
      loaderPackage: { version: '0.0.1', executionObserved: false },
    },
  } } } });
  await put(executable, 'same version, different binary');
  const changed = await setup.runtime.execute('deveco.build', {}, { ...setup.context,
    policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(changed.data).toMatchObject({ code: 'APPROVAL_STALE' });
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});
async function loaderFixture(missing = false, stale = false) {
  await put('entry/src/main/ets/Index.ets', 'export const input = 1;\n');
  await put('entry/src/main/worker.ts', 'export const worker = 1;\n');
  await put('oh_modules/bytecode/module.abc', 'bytecode dependency');
  await put('oh_modules/bytecode/sourceMaps.map', '{"version":3}');
  const loader = { moduleName: 'entry', projectRootPath: root, modulePathMap: { entry: join(root, 'entry') },
    compileEntry: [join(root, 'entry/src/main/ets/Index.ets'), ...(missing ? [join(root, 'entry/src/main/ets/Missing.ets')] : [])],
    workers: [join(root, 'entry/src/main/worker.ts')], declarationEntry: '@normalized:ohmurl-not-a-file',
    byteCodeHarInfo: { library: { abcPath: join(root, 'oh_modules/bytecode/module.abc'),
      sourceMapsPath: join(root, 'oh_modules/bytecode/sourceMaps.map') } } };
  const path = 'entry/build/default/intermediates/loader/default/loader.json';
  if (stale) { await put(path, JSON.stringify(loader)); return; }
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) {
      fs.mkdirSync(path.dirname(${JSON.stringify(path)}),{recursive:true});
      fs.writeFileSync(${JSON.stringify(path)},${JSON.stringify(JSON.stringify(loader))});
    }\n`, { flag: 'a' });
}
it('records fresh loader declaration inputs including worker and bytecode source map while leaving binding unverified', async () => {
  const setup = await fixture(); await compilerFixture(); await loaderFixture();
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: {
    completeness: 'incomplete', buildId: null, loaderInputs: { loaders: [expect.objectContaining({
      spec: 'entry@default', status: 'fresh', binding: 'unverified', inputPhase: 'post-build',
      inputs: expect.arrayContaining([
        expect.objectContaining({ path: 'entry/src/main/worker.ts', role: 'worker' }),
        expect.objectContaining({ path: 'oh_modules/bytecode/sourceMaps.map', role: 'bytecode-source-map', sha256: digest('{"version":3}') }),
      ]),
    })] },
    missing: expect.arrayContaining(['full-compiler-input-closure', 'final-compiler-configuration']),
  } });
  expect(JSON.stringify(result.data)).not.toContain('ohmurl-not-a-file');
});
it('degrades a successful official build when its loader declares an unreadable compiler input', async () => {
  const setup = await fixture(); await loaderFixture(true);
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { loaders: [expect.objectContaining({
    missing: expect.arrayContaining(['compile-entry:entry/src/main/ets/Missing.ets']),
  })] } } });
});
it('preserves an unchanged loader as reused-unverified instead of claiming current build identity', async () => {
  const setup = await fixture(); await loaderFixture(false, true);
  const { result } = await approved(setup, {});
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { loaders: [expect.objectContaining({
    status: 'reused-unverified', binding: 'unverified',
  })] } } });
});
it('refuses sensitive loader inputs and retains only the rejection reason', async () => {
  const setup = await fixture(); await loaderFixture();
  await put('entry/.env', 'PRIVATE_TEST_FIXTURE');
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) {
      const file='entry/build/default/intermediates/loader/default/loader.json', data=JSON.parse(fs.readFileSync(file));
      data.compileEntry.push(${JSON.stringify(join(root, 'entry/.env'))});
      fs.writeFileSync(file,JSON.stringify(data));
    }\n`, { flag: 'a' });
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { loaders: [expect.objectContaining({
    missing: expect.arrayContaining(['compile-entry:sensitive-input']),
  })] } } });
  expect(JSON.stringify(result)).not.toContain(digest('PRIVATE_TEST_FIXTURE'));
});
async function observedCompilerFixture(mode: 'actual' | 'drift' | 'added' | 'missing' | 'unfinished' | 'getter' | 'cache' | 'probe' | 'sensitive-loader' | 'cache-info' | 'cache-absent') {
  const plugin = 'official/hvigor-ohos-plugin/src/tasks/worker/job.js';
  const frontend = 'official/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js';
  await put('official/hvigor-ohos-plugin/package.json', '{"type":"commonjs"}');
  await put(frontend, `exports.createLanguageService = host => {
    host.getScriptSnapshot(${JSON.stringify(join(root, 'entry/src/main/ets/Index.ets'))});
    host.fileExists(${JSON.stringify(join(root, 'entry/src/main/ets/Absent.ets'))});
    host.resolveModuleNames(['./Dependency'], ${JSON.stringify(join(root, 'entry/src/main/ets/Index.ets'))});
    host.getScriptSnapshot(${JSON.stringify(join(root, 'entry/src/main/ets/Dependency.ets'))});
    if ('${mode}' === 'probe') host.readFile(${JSON.stringify(join(root, 'entry/src/main/ets/optional.json'))});
    if ('${mode}' === 'cache-info') host.readFile(${JSON.stringify(join(root, 'entry/build/.tsbuildinfo'))});
    if ('${mode}' === 'cache-absent') host.fileExists(${JSON.stringify(join(root, 'entry/build/.tsbuildinfo'))});
    return { dispose() {} };
  };`);
  await put('entry/src/main/ets/Index.ets', 'export { value } from "./Dependency";\n');
  await put('entry/src/main/ets/Dependency.ets', 'export const value = 1;\n');
  if (mode === 'cache-info') { await put('entry/build/.tsbuildinfo', 'previous incremental state'); }
  if (mode === 'getter') {
    await writeFile(join(root, frontend), `
      const original=exports.createLanguageService;
      Object.defineProperty(exports,'createLanguageService',{get:()=>original,configurable:false});
    `, { flag: 'a' });
  }
  await put(plugin, `const fs = require('node:fs'), originalTs = require(${JSON.stringify(join(root, frontend))});
    const ts = '${mode}' === 'getter' ? Object.defineProperties({}, Object.getOwnPropertyDescriptors(originalTs)) : originalTs;
    exports.run = async config => {
      ts.createLanguageService({
        fileExists: path => fs.existsSync(path),
        readFile: file => { try { return fs.readFileSync(file).toString(); } catch(error) { if(error.code==='ENOENT') return undefined; throw error; } },
        getScriptSnapshot: path => { const text=fs.readFileSync(path).toString(); return { getLength:()=>text.length, getText:()=>text }; },
        resolveModuleNames: () => [{ resolvedFileName: ${JSON.stringify(join(root, 'entry/src/main/ets/Dependency.ets'))} }],
      });
      if ('${mode}' === 'cache-info') fs.writeFileSync('entry/build/.tsbuildinfo','next incremental state');
      if ('${mode}' === 'cache-absent') fs.writeFileSync('entry/build/.tsbuildinfo','initial incremental state');
      if ('${mode}' === 'cache') {
        fs.existsSync(${JSON.stringify(join(root, 'entry/build/custom-cache/new.cache'))});
        fs.mkdirSync(${JSON.stringify(join(root, 'entry/build/custom-cache'))},{recursive:true});
        fs.writeFileSync(${JSON.stringify(join(root, 'entry/build/custom-cache/new.cache'))},'original cache');
        fs.readFileSync(${JSON.stringify(join(root, 'entry/build/custom-cache/new.cache'))});
        fs.writeFileSync(${JSON.stringify(join(root, 'entry/build/custom-cache/new.cache'))},'updated cache');
      }
      if ('${mode}' === 'unfinished') process.exit(0);
      if ('${mode}' === 'drift') fs.writeFileSync('entry/src/main/ets/Dependency.ets', 'export const value = 2;\\n');
      if ('${mode}' === 'added') fs.writeFileSync('entry/src/main/ets/Absent.ets', 'export const late = 1;\\n');
      return [];
    };`);
  const loader = join(root, mode === 'sensitive-loader' ? 'entry/.env' : 'entry/custom-output/loader.json');
  if (mode === 'sensitive-loader') { await put('entry/.env', '{"private":"PRIVATE_TEST_MARKER"}'); }
  await put('entry/custom-output/loader.json', JSON.stringify({
    compileEntry: [join(root, 'entry/src/main/ets/Index.ets'), ...(mode === 'missing' ? [join(root, 'entry/src/main/ets/Missing.ets')] : [])],
  }));
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) require(${JSON.stringify(join(root, plugin))}).run({
      projectTopDir: process.cwd(), modulePath: path.resolve('entry'), entryModuleName:'entry', targetName:'.default',
      buildMode:'debug', buildId:'official-invocation-id', etsLoaderPath:${JSON.stringify(join(root, 'official/sdk/default/openharmony/ets/build-tools/ets-loader'))},
      aceBuildJson:${JSON.stringify(loader)}, aceModuleBuild:path.resolve('entry/custom-output/ets'),
      cachePath:path.resolve('entry/build/custom-cache'),
      obfuscationOptions: { get credential() { throw new Error('must not inspect omitted options'); } },
    }).catch(error=>{console.error(error);process.exitCode=1;});\n`, { flag: 'a' });
}
it('observes actual compiler hosts and submitted custom loader paths without treating the official invocation id as a complete buildId', async () => {
  const setup = await fixture(); await observedCompilerFixture('actual');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: {
    buildId: null, compilerObservation: {
      scope: 'actual-compiler-hosts', binding: 'observed-partial',
      configurations: [expect.objectContaining({ entryModuleName: 'entry', targetName: '.default',
        officialBuildId: 'official-invocation-id', aceBuildJson: join(root, 'entry/custom-output/loader.json') })],
      hosts: expect.arrayContaining([expect.objectContaining({ kind: 'language-service' })]),
      files: expect.arrayContaining([expect.objectContaining({ path: 'entry/src/main/ets/Index.ets' })]),
      resolutions: expect.arrayContaining([expect.objectContaining({ containingFile: 'entry/src/main/ets/Index.ets',
        resolvedFile: 'entry/src/main/ets/Dependency.ets' })]),
    },
    loaderInputs: { loaders: expect.arrayContaining([expect.objectContaining({ path: 'entry/custom-output/loader.json',
      layout: 'observed-configuration', binding: 'observed-partial' })]) },
  } });
});
it('observes SDK-style readonly getter exports without modifying the compiler exports', async () => {
  const setup = await fixture(); await observedCompilerFixture('getter');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { compilerObservation: {
    hosts: expect.arrayContaining([expect.objectContaining({ kind: 'language-service' })]),
  } } });
});
it('keeps generated cache reads separate from source input drift and retains cache uncertainty', async () => {
  const setup = await fixture(); await observedCompilerFixture('cache');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { compilerObservation: {
    drift: [], files: expect.arrayContaining([expect.objectContaining({ path: 'entry/build/custom-cache/new.cache',
      role: 'generated-runtime-read' })]),
    missing: expect.arrayContaining(['filesystem-observation-partial']),
  } } });
});
it('keeps unsuccessful optional host reads as absent probes while preserving compiler uncertainty', async () => {
  const setup = await fixture(); await observedCompilerFixture('probe');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { compilerObservation: { drift: [], invalid: false } } });
});
it('refuses an observed sensitive loader path before reading or retaining its content hash', async () => {
  const setup = await fixture(); await observedCompilerFixture('sensitive-loader');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(JSON.stringify(result)).not.toContain(digest('{"private":"PRIVATE_TEST_MARKER"}'));
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { invalidInputs: true } } });
});
it('records SDK incremental build-info read bytes and later cache transitions separately from source drift', async () => {
  const setup = await fixture(); await observedCompilerFixture('cache-info');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { buildId: null, compilerObservation: {
    drift: [], cacheTransitions: expect.arrayContaining([expect.objectContaining({
      path: 'entry/build/.tsbuildinfo', readSha256: digest('previous incremental state'),
      afterSha256: digest('next incremental state'), binding: 'cache-unverified',
    })]),
  } } });
});
it('retains initially absent SDK build-info probes as unverified cache creation rather than source additions', async () => {
  const setup = await fixture(); await observedCompilerFixture('cache-absent');
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { compilerObservation: {
    drift: [], cacheTransitions: expect.arrayContaining([expect.objectContaining({
      path: 'entry/build/.tsbuildinfo', readSha256: null,
      afterSha256: digest('initial incremental state'), binding: 'cache-unverified',
    })]),
  } } });
});
it.each(['drift', 'added', 'missing', 'unfinished'] as const)('retains successful official output but degrades %s actual compiler evidence', async (mode) => {
  const setup = await fixture(); await observedCompilerFixture(mode);
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ invocations: expect.arrayContaining([expect.objectContaining({ toolExitCode: 0 })]),
    verification: { artifactIdentity: 'incomplete' } });
  if (mode === 'added' || mode === 'drift') {
    expect(result.data).toMatchObject({ provenance: { compilerObservation: {
      drift: expect.arrayContaining([mode === 'added' ? 'entry/src/main/ets/Absent.ets' : 'entry/src/main/ets/Dependency.ets']),
    } } });
  }
});
it.each(['changed', 'added'])('reports a compiler component %s during the official build', async (mode) => {
  const setup = await fixture(), executable = await compilerFixture();
  const path = mode === 'changed' ? executable : 'official/sdk/default/openharmony/ets/build-tools/ets-loader/compile_plugin.js';
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) fs.writeFileSync(${JSON.stringify(path)},'producer changed during build');\n`, { flag: 'a' });
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: {
    compilerDrift: expect.arrayContaining([mode === 'changed' ? 'es2abc' : 'loaderPlugin']),
  } });
});
it.skipIf(process.platform === 'win32')('retains official results when a generated loader becomes inaccessible', async () => {
  const setup = await fixture(); await loaderFixture();
  const directory = join(root, 'entry/build/default/intermediates/loader/default');
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) fs.chmodSync(${JSON.stringify(directory)},0);\n`, { flag: 'a' });
  try {
    const { result } = await approved(setup, {});
    expect(result.exitCode).toBe(3);
    expect(result.data).toMatchObject({
      invocations: expect.arrayContaining([expect.objectContaining({ toolExitCode: 0 })]),
      provenance: { loaderInputs: { invalidInputs: true } },
    });
  } finally { await chmod(directory, 0o700); }
});
it('bounds unreadable dependency declarations before attempting thousands of file reads', async () => {
  const setup = await fixture();
  const records = Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [
    `library${index}`, { abcPath: join(root, `entry/missing${index}.abc`) },
  ]));
  const path = 'entry/build/default/intermediates/loader/default/loader.json';
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) {
      fs.mkdirSync(path.dirname(${JSON.stringify(path)}),{recursive:true});
      fs.writeFileSync(${JSON.stringify(path)},${JSON.stringify(JSON.stringify({ byteCodeHarInfo: records }))});
    }\n`, { flag: 'a' });
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { loaders: [expect.objectContaining({
    inputs: [], missing: ['loader-input-budget'],
  })] } } });
});
it('reads runtimeOnly entries from the official package-keyed dynamicImportLibInfo record', async () => {
  const setup = await fixture(); await loaderFixture();
  await put('oh_modules/runtime/Index.ets', 'export const dynamicInput = 1;\n');
  const dynamic = { runtime: { hostModulesInfo: [{ hostDependencyName: 'runtime', hostModuleName: 'entry' }],
    moduleName: 'runtime', entryFilePath: join(root, 'oh_modules/runtime/Index.ets'),
    isLocalDependency: false, pkgPath: join(root, 'oh_modules/runtime') } };
  await writeFile(join(root, 'official/hvigor.cjs'), `
    if(args.includes('assembleHap')) {
      const file='entry/build/default/intermediates/loader/default/loader.json', data=JSON.parse(fs.readFileSync(file));
      data.dynamicImportLibInfo=${JSON.stringify(dynamic)}; fs.writeFileSync(file,JSON.stringify(data));
    }\n`, { flag: 'a' });
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { loaders: [expect.objectContaining({
    inputs: expect.arrayContaining([expect.objectContaining({
      path: 'oh_modules/runtime/Index.ets', role: 'runtime-only-entry', sha256: digest('export const dynamicInput = 1;\n'),
    })]),
  })] } } });
});
it('retains the raw loader hash when malformed JSON prevents schema interpretation', async () => {
  const setup = await fixture(); await loaderFixture();
  await writeFile(join(root, 'official/hvigor.cjs'),
    "if(args.includes('assembleHap')) fs.writeFileSync('entry/build/default/intermediates/loader/default/loader.json','{');\n", { flag: 'a' });
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { loaderInputs: { loaders: [expect.objectContaining({
    status: 'unreadable', sha256: digest('{'), missing: ['loader-unreadable'],
  })] } } });
});

it('binds approval to installed bytecode and SourceMap bytes before any official invocation', async () => {
  const setup = await fixture(); await loaderFixture();
  const plan = await setup.runtime.execute('deveco.build', {}, setup.context);
  expect(plan.exitCode).toBe(5);
  await put('oh_modules/bytecode/sourceMaps.map', '{"version":3,"changed":true}');
  const result = await setup.runtime.execute('deveco.build', {}, { ...setup.context,
    policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(result.data).toMatchObject({ code: 'APPROVAL_STALE' });
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('invalidates approval when an OHPM alias target changes inside the hidden installed store', async () => {
  const setup = await fixture(); await loaderFixture();
  await put('oh_modules/.ohpm/library/Index.ets', 'installed hidden version one');
  await symlink('.ohpm/library', join(root, 'oh_modules/library'));
  const plan = await setup.runtime.execute('deveco.build', {}, setup.context);
  expect(plan.exitCode).toBe(5);
  await put('oh_modules/.ohpm/library/Index.ets', 'installed hidden version two');
  const result = await setup.runtime.execute('deveco.build', {}, { ...setup.context,
    policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(result.data).toMatchObject({ code: 'APPROVAL_STALE' });
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['source', 'bytecode', 'source-map', 'added', 'removed'])(
  'retains official success but refuses installed dependency %s drift during compilation', async (mode) => {
    const setup = await fixture(); await loaderFixture();
    await put('entry/oh_modules/library/Index.ets', 'export const library = 1;\n');
    const file = mode === 'source' ? 'entry/oh_modules/library/Index.ets'
      : mode === 'bytecode' ? 'oh_modules/bytecode/module.abc'
        : mode === 'added' ? 'entry/oh_modules/library/Added.ets' : 'oh_modules/bytecode/sourceMaps.map';
    await writeFile(join(root, 'official/hvigor.cjs'), `
      if(args.includes('assembleHap')) {
        ${mode === 'removed' ? `fs.unlinkSync(${JSON.stringify(file)});`
          : `fs.writeFileSync(${JSON.stringify(file)},'changed installed dependency');`}
      }\n`, { flag: 'a' });
    const { result } = await approved(setup, {});
    expect(result.exitCode).toBe(3);
    expect(result.data).toMatchObject({
      execution: 'executed', buildId: null,
      invocations: expect.arrayContaining([expect.objectContaining({ toolExitCode: 0, argv: expect.arrayContaining(['assembleHap']) })]),
      provenance: {
        completeness: 'incomplete',
        installedInputDrift: expect.arrayContaining([file]),
      },
    });
  });

it('archives precompile installed bytes separately from post-build loader declarations', async () => {
  const setup = await fixture(); await loaderFixture();
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: {
    installedInputs: {
      scope: 'ohpm-installed-inventory', inputPhase: 'precompile', binding: 'inventory-only',
      files: expect.arrayContaining([expect.objectContaining({
        path: 'oh_modules/bytecode/sourceMaps.map', sha256: digest('{"version":3}'),
      })]),
    },
    installedInputDrift: [],
    missing: expect.arrayContaining(['full-compiler-input-closure']),
  } });
});

it('preserves existing argv-shaped build calls while refusing subcommand forwarding', async () => {
  const setup = await fixture('success', true);
  const { plan, result } = await approved(setup, { argv: ['--modules', 'entry@default', '--signing-config=acceptance'] });
  expect(plan.data).toMatchObject({ risk: 'R3' });
  expect(result.exitCode).toBe(0);
  expect(result.provenance.adapter).toBe('native');
  expect((await setup.runtime.execute('deveco.build', { argv: ['clean'] }, setup.context)).exitCode).toBe(4);
});

it('does not install or sync when the upstream configuration check finds an up-to-date baseline', async () => {
  const setup = await fixture();
  await put('oh_modules/.ohpm/lock.json5', '{}');
  await put('.hvigor/outputs/sync/output.json', '{}');
  const future = new Date(Date.now() + 5000);
  await utimes(join(root, '.hvigor/outputs/sync/output.json'), future, future);
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(0);
  expect((await calls()).some((item) => item.args.includes('--sync') || item.args[0] === 'ohpm')).toBe(false);
});

it.each(['--signing-config', '--signing-config=acceptance'])('keeps native terminal signing selection and R3 approval for %s', async (flag) => {
  await fixture('success', true);
  vi.stubEnv('OHMATE_DATA_DIR', join(root, 'state'));
  const chunks: string[] = [];
  const argv = ['build', flag, ...flag.includes('=') ? [] : ['acceptance'], '--project', root, '--format', 'json'];
  expect(await runTerminal(argv, { stdout: (text) => chunks.push(text), stderr: () => undefined })).toBe(5);
  const plan = JSON.parse(chunks.join(''));
  expect(plan.data).toMatchObject({ risk: 'R3', input: { signingConfig: 'acceptance' } });
  expect(plan.provenance.adapter).toBe('native');
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['success', 'failure'])('restores the exact signing profile bytes after %s and records only the reference change', async (mode) => {
  const setup = await fixture(mode, true);
  const file = join(root, 'build-profile.json5');
  const initial = `\uFEFF// preserved comment\r\n${(await readFile(file, 'utf8')).replace("{name:'default'}", "{name:'default', signingConfig:'original'}")}\r\n`;
  await writeFile(file, initial);
  const { plan, result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(plan.data).toMatchObject({ risk: 'R3', review: { signing: { requested: 'acceptance', change: { field: ['app', 'products', 0, 'signingConfig'] } } } });
  expect(JSON5.parse(await readFile(join(root, 'build/observed-profile.txt'), 'utf8')).app.products[0].signingConfig).toBe('acceptance');
  expect(await readFile(file, 'utf8')).toBe(initial);
  expect(result.exitCode).toBe(mode === 'success' ? 0 : 6);
  expect(result.data).toMatchObject({ configuration: { signing: { state: 'restored' } }, provenance: { sourceDrift: [] } });
  const journal = result.artifacts!.find((item) => item.kind === 'build-signing-journal')!;
  const saved = await readFile(journal.path, 'utf8');
  expect(saved).not.toContain('signingConfigs');
  expect(saved).not.toContain('preserved comment');
  if (mode === 'failure') {
    expect(result.data).toMatchObject({ invocations: expect.arrayContaining([expect.objectContaining({ toolExitCode: 7 })]) });
  }
});

it('requires R3 for a signed product even when its signing selection is implicit', async () => {
  const setup = await fixture('success', true);
  const profile = JSON5.parse(await readFile(join(root, 'build-profile.json5'), 'utf8'));
  profile.app.products[0].signingConfig = 'original';
  await put('build-profile.json5', JSON5.stringify(profile));
  const plan = await setup.runtime.execute('build.run', {}, setup.context);
  expect(plan.exitCode).toBe(5);
  expect(plan.data).toMatchObject({ risk: 'R3', review: { signing: { effective: 'original', requested: null } } });
});

it('does not classify a template reference with no declared signing config as an actual signature', async () => {
  const setup = await fixture();
  const profile = JSON5.parse(await readFile(join(root, 'build-profile.json5'), 'utf8'));
  profile.app.products[0].signingConfig = 'default'; profile.app.signingConfigs = [];
  await put('build-profile.json5', JSON5.stringify(profile));
  const plan = await setup.runtime.execute('deveco.build', {}, setup.context);
  expect(plan.exitCode).toBe(5);
  expect(plan.data).toMatchObject({ risk: 'R2', review: { signing: { reference: 'default', effective: null, status: 'unresolved' } } });
  const invalid = await setup.runtime.execute('deveco.build', { signingConfig: 'default' }, setup.context);
  expect(invalid.exitCode).toBe(4);
});

it('preserves a subsequent profile edit and offers conflict-aware signing recovery', async () => {
  const setup = await fixture('conflict', true);
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ configuration: { signing: { state: 'recovery-required', journalId: expect.any(String) } } });
  expect(await readFile(join(root, 'build-profile.json5'), 'utf8')).toContain('subsequent external edit');
  const id = (result.data as { configuration: { signing: { journalId: string } } }).configuration.signing.journalId;
  const inspected = await setup.runtime.execute('build.signing.inspect', { journalId: id }, setup.context);
  expect(inspected.data).toMatchObject({ state: 'conflict' });
  const restore = await setup.runtime.execute('build.signing.restore', { journalId: id }, setup.context);
  expect(restore.exitCode).toBe(4);
  expect(await readFile(join(root, 'build-profile.json5'), 'utf8')).toContain('subsequent external edit');
});

it('keeps explicit assemble overrides as official task requests on the compatibility entry', async () => {
  const setup = await fixture();
  const { result } = await approved(setup, { modules: ['entry'], assembleType: 'assembleHsp' });
  expect((await calls()).find((item) => item.args.includes('assembleHsp')).args).toContain('module=entry@default');
  expect(result.exitCode).toBe(3);
  expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ASSEMBLE_TYPE_MISMATCH' })]));
});

it('retains the product-only selection as a whole-product official build', async () => {
  const setup = await fixture();
  const { result } = await approved(setup, { product: 'default' });
  expect(result.exitCode).toBe(0);
  expect((await calls()).find((item) => item.args.includes('assembleApp')).args).not.toContain('--mode');
});

it('removes reviewed quickfix compiler config and retains exact bytes for explicit recovery', async () => {
  const setup = await fixture();
  const cache = 'entry/build/config/buildConfig.json', original = '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}\n';
  await put(cache, original);
  const { plan, result } = await approved(setup, {});
  expect(plan.data).toMatchObject({ review: { cacheCleanup: { files: [expect.objectContaining({ path: cache, diff: expect.stringContaining('-' + original.trim()) })] } } });
  expect(result.exitCode).toBe(0);
  await expect(readFile(join(root, cache))).rejects.toMatchObject({ code: 'ENOENT' });
  const cleanup = (result.data as { configuration: { cacheCleanup: { journalId: string } } }).configuration.cacheCleanup;
  expect(cleanup.journalId).toEqual(expect.any(String));
  const restored = await approved(setup, { journalId: cleanup.journalId }, 'build.cache.restore');
  expect(restored.result.exitCode).toBe(0);
  expect(await readFile(join(root, cache), 'utf8')).toBe(original);
});

it('invalidates a build approval when a reviewed quickfix cache changes', async () => {
  const setup = await fixture(), cache = 'entry/build/config/buildConfig.json';
  await put(cache, '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}');
  const plan = await setup.runtime.execute('deveco.build', {}, setup.context);
  expect(plan.exitCode).toBe(5);
  const next = '{"compileConfig":{"watchMode":"true"},"patchConfig":{"mode":"hotReload"}}';
  await put(cache, next);
  const result = await setup.runtime.execute('deveco.build', {}, { ...setup.context,
    policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } });
  expect(result.exitCode).toBe(5);
  expect(result.data).toMatchObject({ code: 'APPROVAL_STALE' });
  expect(await readFile(join(root, cache), 'utf8')).toBe(next);
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not certify newly added compiler inputs after the official tool runs', async () => {
  const setup = await fixture();
  const script = join(root, 'official/hvigor.cjs'), text = await readFile(script, 'utf8');
  await writeFile(script, text.replace("fs.writeFileSync('build/observed-profile.txt',profile);",
    "fs.writeFileSync('build/observed-profile.txt',profile); fs.writeFileSync('entry/src/main/Injected.ets','export const injected = 1;');"));
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ provenance: { sourceDrift: ['entry/src/main/Injected.ets'] } });
});

it('restores signing on cancellation and keeps the original invocation evidence', async () => {
  const setup = await fixture('success', true), controller = new AbortController();
  const file = join(root, 'build-profile.json5'), original = await readFile(file, 'utf8');
  const script = join(root, 'official/hvigor.cjs'), text = await readFile(script, 'utf8');
  await writeFile(script, text.replace("fs.writeFileSync('build/observed-profile.txt',profile);",
    "fs.writeFileSync('build/observed-profile.txt',profile); console.log('BUILD_WAITING'); setInterval(()=>{},1000);"));
  setup.context = { ...setup.context, abortSignal: controller.signal, stdout: (chunk) => {
    if (chunk.includes('BUILD_WAITING')) { controller.abort(); }
  } };
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(130);
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(result.data).toMatchObject({ configuration: { signing: { state: 'restored' } },
    invocations: expect.arrayContaining([expect.objectContaining({ stdout: expect.stringContaining('BUILD_WAITING') })]) });
});

it('recovers an outstanding signing reference from persisted state through a new runtime', async () => {
  const setup = await fixture('success', true), original = await readFile(join(root, 'build-profile.json5'), 'utf8');
  const plan = await setup.runtime.execute('deveco.build', { signingConfig: 'acceptance' }, setup.context);
  const context = { ...setup.context, policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } };
  const prepared = await prepareSigning(Project.discover(root), 'default', 'acceptance', context);
  const id = await applySigning(prepared, 'default', context);
  const restored = await approved({ ...setup, runtime: await createRuntime() }, { journalId: id }, 'build.signing.restore');
  expect(restored.plan.data).toMatchObject({ risk: 'R3' });
  expect(restored.result.exitCode).toBe(0);
  expect(await readFile(join(root, 'build-profile.json5'), 'utf8')).toBe(original);
});

it('retains signing recovery evidence when a producer replaces the profile with a link', async () => {
  const setup = await fixture('success', true), script = join(root, 'official/hvigor.cjs');
  await writeFile(script, (await readFile(script, 'utf8')).replace("fs.writeFileSync('build/observed-profile.txt',profile);",
    "fs.writeFileSync('build/observed-profile.txt',profile); fs.unlinkSync('build-profile.json5'); fs.symlinkSync('AppScope/app.json5','build-profile.json5');"));
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ configuration: { signing: { state: 'recovery-required', journalId: expect.any(String) } },
    invocations: expect.arrayContaining([expect.objectContaining({ toolExitCode: 0 })]) });
  expect(result.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'build-signing-journal' })]));
});

it('retains a cache recovery journal and original backups after an interrupted cleanup', async () => {
  const setup = await fixture();
  const cache = 'entry/build/config/buildConfig.json', original = '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}';
  await put(cache, original);
  setup.context = { ...setup.context, eventSink: async (event) => {
    if (event.type === 'build.cache.removed') { throw new Error('fixture event persistence failure'); }
  } };
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ configuration: { cacheCleanup: { state: 'recovery-required', journalId: expect.any(String) } } });
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  const id = (result.data as { configuration: { cacheCleanup: { journalId: string } } }).configuration.cacheCleanup.journalId;
  const restored = await approved({ ...setup, context: { ...setup.context, eventSink: () => undefined } }, { journalId: id }, 'build.cache.restore');
  expect(restored.result.exitCode).toBe(0);
  expect(await readFile(join(root, cache), 'utf8')).toBe(original);
});

it('reviews installation forced by a temporary signing override before executing it', async () => {
  const setup = await fixture('success', true);
  await put('oh_modules/.ohpm/lock.json5', '{}'); await put('.hvigor/outputs/sync/output.json', '{}');
  const earlier = new Date(Date.now() - 5000);
  await utimes(join(root, 'build-profile.json5'), earlier, earlier);
  const plan = await setup.runtime.execute('deveco.build', { signingConfig: 'acceptance' }, setup.context);
  expect(plan.exitCode).toBe(5);
  expect(plan.data).toMatchObject({ review: { install: true, syncRequired: true } });
});

it('refuses a forged signing restoration that changes a non-reference field even with recomputed hashes', async () => {
  const setup = await fixture('success', true), original = await readFile(join(root, 'build-profile.json5'), 'utf8');
  const plan = await setup.runtime.execute('deveco.build', { signingConfig: 'acceptance' }, setup.context);
  const context = { ...setup.context, policy: { ...setup.context.policy, approvedPlan: (plan.data as { planId: string }).planId } };
  const id = await applySigning(await prepareSigning(Project.discover(root), 'default', 'acceptance', context), 'default', context);
  const file = join(context.dataDir, 'state', `build-signing-${id}.json`), journal = JSON.parse(await readFile(file, 'utf8'));
  journal.edit.before += ', name:"renamed"';
  const current = await readFile(join(root, 'build-profile.json5'), 'utf8'), { start, before, after } = journal.edit;
  journal.oldHash = digest(current.slice(0, start) + before + current.slice(start + after.length));
  await writeFile(file, JSON.stringify(journal));
  const restore = await setup.runtime.execute('build.signing.restore', { journalId: id }, setup.context);
  expect(restore.exitCode).toBe(4);
  expect(await readFile(join(root, 'build-profile.json5'), 'utf8')).not.toBe(original);
  expect(await readFile(join(root, 'build-profile.json5'), 'utf8')).not.toContain('renamed');
});

it('retains the signing journal identity when its stored record becomes invalid during the build', async () => {
  const setup = await fixture('success', true), script = join(root, 'official/hvigor.cjs');
  await writeFile(script, (await readFile(script, 'utf8')).replace("fs.writeFileSync('build/observed-profile.txt',profile);",
    "fs.writeFileSync('build/observed-profile.txt',profile); const dir=path.join(process.cwd(),'state/state'); const j=fs.readdirSync(dir).find(n=>n.startsWith('build-signing-')); fs.writeFileSync(path.join(dir,j),'invalid');"));
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ configuration: { signing: { state: 'recovery-required', journalId: expect.any(String) } } });
  expect(result.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'build-signing-recovery' })]));
});

it('preserves an external profile save between preparation and atomic replacement', async () => {
  const setup = await fixture('success', true), file = join(root, 'build-profile.json5');
  const subsequent = (await readFile(file, 'utf8')) + '\n// external editor saved\n';
  let changed = false;
  setup.context = { ...setup.context, eventSink: async (event) => {
    if (event.type === 'build.file.before-displace' && (event.payload as { path: string }).path === 'build-profile.json5' && !changed) {
      changed = true; await writeFile(file, subsequent);
    }
  } };
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(6);
  expect(await readFile(file, 'utf8')).toBe(subsequent);
});

it('preserves a newly replaced cache between hash verification and deletion', async () => {
  const setup = await fixture(), cache = 'entry/build/config/buildConfig.json';
  await put(cache, '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}');
  const subsequent = '{"compileConfig":{"watchMode":"true"},"patchConfig":{"mode":"hotReload"}}';
  setup.context = { ...setup.context, eventSink: async (event) => {
    if (event.type === 'build.file.before-displace' && (event.payload as { path: string }).path === cache) { await put(cache, subsequent); }
  } };
  const { result } = await approved(setup, {});
  expect(result.exitCode).toBe(6);
  expect(await readFile(join(root, cache), 'utf8')).toBe(subsequent);
});

async function interruptDisplacement(kind: 'signing' | 'cache', dataDir: string, restoreId?: string) {
  const module = (file: string) => JSON.stringify(pathToFileURL(resolve(`packages/cli/src/${file}.ts`)).href);
  const entry = join(root, 'interrupted.mjs');
  await writeFile(entry, `
    import { createExecutionContext } from ${module('runtime/context')};
    import { Project } from ${module('utils/project')};
    import { readProject } from ${module('project-model/project-reader')};
    import { prepareSigning, applySigning } from ${module('quality/build-signing')};
    import { prepareCacheCleanup, removeBuildCache, restoreBuildCache } from ${module('quality/build-cache')};
    const context=await createExecutionContext({cwd:${JSON.stringify(root)},projectRoot:${JSON.stringify(root)},dataDir:${JSON.stringify(dataDir)},approvedPlan:'${'a'.repeat(64)}'});
    context.eventSink=async(event)=>{ if(event.type==='${restoreId ? 'build.cache.published' : 'build.file.displaced'}'){ console.log('DISPLACED'); setInterval(()=>{},1000); await new Promise(()=>{}); } };
    if(${JSON.stringify(restoreId ?? null)}) await restoreBuildCache(${JSON.stringify(restoreId ?? '')},context);
    else if('${kind}'==='signing') await applySigning(await prepareSigning(Project.discover(context.cwd),'default','acceptance',context),'default',context);
    else await removeBuildCache(await prepareCacheCleanup(await readProject(context.cwd),context),context);
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve_) => child.once('close', resolve_));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child did not displace a file: ${stderr}`)), 3000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('DISPLACED')) { clearTimeout(timer); resolve_(); } });
      child.once('close', () => { clearTimeout(timer); reject(new Error(`Child exited early: ${stderr}`)); });
    });
  } finally { child.kill('SIGKILL'); await closed; }
  const file = (await readdir(join(dataDir, 'state'))).find((name) => name.startsWith(`build-${kind}-`))!;
  return JSON.parse(await readFile(join(dataDir, 'state', file), 'utf8'));
}

it.each(['signing', 'cache'] as const)('restores exact %s bytes after a child is killed while the original file is displaced', async (kind) => {
  const setup = await fixture('success', true), cache = 'entry/build/config/buildConfig.json';
  await put(cache, '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}');
  const file = join(root, kind === 'signing' ? 'build-profile.json5' : cache), original = await readFile(file);
  const journal = await interruptDisplacement(kind, setup.context.dataDir);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  const { result } = await approved({ ...setup, runtime: await createRuntime() }, { journalId: journal.id }, `build.${kind}.restore`);
  expect(result.exitCode).toBe(0);
  expect(await readFile(file)).toEqual(original);
  expect((await readdir(dirname(file))).some((name) => name.endsWith('.held'))).toBe(false);
});

it('keeps the journal identity when signing publication succeeds but the journal update fails', async () => {
  const setup = await fixture('success', true);
  setup.context = { ...setup.context, eventSink: async (event) => {
    if (event.type === 'build.file.displaced') {
      const directory = join(setup.context.dataDir, 'state');
      const file = (await readdir(directory)).find((name) => name.startsWith('build-signing-'))!;
      await writeFile(join(directory, file), 'invalid');
    }
  } };
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ configuration: { signing: { state: 'recovery-required', journalId: expect.any(String) } } });
  expect(JSON5.parse(await readFile(join(root, 'build-profile.json5'), 'utf8')).app.products[0].signingConfig).toBe('acceptance');
});

it('retains both a re-created external profile and its displaced original on conflict', async () => {
  const setup = await fixture('success', true), file = join(root, 'build-profile.json5');
  const original = await readFile(file, 'utf8'), external = original + '\n// re-created external profile\n';
  setup.context = { ...setup.context, eventSink: async (event) => {
    if (event.type === 'build.file.displaced') { await writeFile(file, external); }
  } };
  const { result } = await approved(setup, { signingConfig: 'acceptance' });
  expect(result.exitCode).toBe(6);
  expect(await readFile(file, 'utf8')).toBe(external);
  const journal = JSON.parse(await readFile(result.artifacts!.find((item) => item.kind === 'build-signing-journal')!.path, 'utf8'));
  expect(journal.phase).toBe('recovery-required');
  expect(await readFile(join(root, journal.heldPath), 'utf8')).toBe(original);
});

it('restores the reviewed cache permissions independently of the process umask', async () => {
  const setup = await fixture(), cache = 'entry/build/config/buildConfig.json';
  await put(cache, '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}');
  await chmod(join(root, cache), 0o664);
  const { result } = await approved(setup, {});
  const id = (result.data as { configuration: { cacheCleanup: { journalId: string } } }).configuration.cacheCleanup.journalId;
  const previous = process.umask(0o022);
  try {
    const restored = await approved(setup, { journalId: id }, 'build.cache.restore');
    expect(restored.result.exitCode).toBe(0);
    expect((await lstat(join(root, cache))).mode & 0o777).toBe(0o664);
  } finally { process.umask(previous); }
});

it('retries an interrupted cache restoration whose complete destination still has the wrong permissions', async () => {
  const setup = await fixture(), cache = 'entry/build/config/buildConfig.json';
  const original = '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}';
  await put(cache, original); await chmod(join(root, cache), 0o664);
  const journal = await interruptDisplacement('cache', setup.context.dataDir);
  await put(cache, original); await chmod(join(root, cache), 0o644);
  const inspected = await setup.runtime.execute('build.cache.inspect', { journalId: journal.id }, setup.context);
  expect(inspected.data).toMatchObject({ files: [expect.objectContaining({ state: 'permissions', currentMode: 0o644, originalMode: 0o664 })] });
  const { plan, result } = await approved(setup, { journalId: journal.id }, 'build.cache.restore');
  expect(plan.data).toMatchObject({ review: { files: [expect.objectContaining({ oldMode: 0o644, mode: 0o664 })] } });
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(root, cache), 'utf8')).toBe(original);
  expect((await lstat(join(root, cache))).mode & 0o777).toBe(0o664);
  expect((await readdir(dirname(join(root, cache)))).some((name) => name.endsWith('.held'))).toBe(false);
});

it('finishes cache cleanup after publication was interrupted with already correct bytes and permissions', async () => {
  const setup = await fixture(), cache = 'entry/build/config/buildConfig.json';
  const original = '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}';
  await put(cache, original); await chmod(join(root, cache), 0o664);
  const journal = await interruptDisplacement('cache', setup.context.dataDir);
  await interruptDisplacement('cache', setup.context.dataDir, journal.id);
  expect(await readFile(join(root, cache), 'utf8')).toBe(original);
  expect((await lstat(join(root, cache))).mode & 0o777).toBe(0o664);
  const { result } = await approved(setup, { journalId: journal.id }, 'build.cache.restore');
  expect(result.exitCode).toBe(0);
  expect((await readdir(dirname(join(root, cache)))).some((name) => name.endsWith('.held'))).toBe(false);
});

it('keeps all displaced cache paths when a permissions repair is interrupted a second time', async () => {
  const setup = await fixture(), cache = 'entry/build/config/buildConfig.json';
  const original = '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}';
  await put(cache, original); await chmod(join(root, cache), 0o664);
  const journal = await interruptDisplacement('cache', setup.context.dataDir);
  await put(cache, original); await chmod(join(root, cache), 0o644);
  const interrupted = { ...setup, context: { ...setup.context, eventSink: async (event: { type: string }) => {
    if (event.type === 'build.file.displaced') {
      await put(cache, original); await chmod(join(root, cache), 0o664); throw new Error('Second interruption');
    }
  } } };
  const failed = await approved(interrupted, { journalId: journal.id }, 'build.cache.restore');
  expect(failed.result.exitCode).not.toBe(0);
  const restored = await approved(setup, { journalId: journal.id }, 'build.cache.restore');
  expect(restored.result.exitCode).toBe(0);
  expect(await readFile(join(root, cache), 'utf8')).toBe(original);
  expect((await lstat(join(root, cache))).mode & 0o777).toBe(0o664);
  expect((await readdir(dirname(join(root, cache)))).some((name) => name.endsWith('.held'))).toBe(false);
});
