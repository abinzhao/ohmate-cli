/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ToolProvider } from '../toolchain/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-quality-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function put(path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function fixture() {
  await put('build-profile.json5', JSON.stringify({
    app: { products: [{ name: 'default' }], buildModeSet: [{ name: 'debug' }, { name: 'release' }] },
    modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] }],
  }));
  await put('AppScope/app.json5', '{"app":{"bundleName":"org.example.acceptance","versionCode":1}}');
  await put('oh-package.json5', '{"name":"acceptance","version":"1.0.0"}');
  await put('entry/oh-package.json5', '{"name":"entry","version":"1.0.0"}');
  await put('entry/src/main/module.json5', '{"module":{"name":"entry","type":"entry"}}');
  await put('entry/test/Index.test.ets', "// describe('Comment', () => {});\nconst noise = \"describe('String', () => {})\";\ndescribe('Suite', () => { it('case', 0, () => {}); });\n");
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return { context, runtime: await createRuntime() };
}
async function officialFixture(mode = 'success') {
  const provider = {
    nodePath: process.execPath, hvigorJsPath: join(root, 'official/hvigorw.cjs'), ohpmJsPath: join(root, 'official/ohpm.cjs'),
    javaPath: process.execPath, sdkPath: join(root, 'official/sdk'), toolchainRoot: join(root, 'official'), sourceType: 'studio',
    readVersion: () => '26.0.0.810', assertJava: () => undefined,
  } as unknown as ToolProvider;
  await put('official/sdk/default/sdk-pkg.json', '{"data":{"apiVersion":26,"platformVersion":"7.0.0"}}');
  await put('official/hvigorw.cjs', `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    fs.mkdirSync(path.join(process.cwd(), 'build'), {recursive:true});
    fs.appendFileSync(path.join(process.cwd(), 'build/calls.jsonl'), JSON.stringify({args, cwd:process.cwd(), home:process.env.HOME})+'\\n');
    if (args.includes('--help')) { console.log('--no-daemon --offline tasks'); }
    else if (args.includes('tasks')) { console.log('entry:default@assembleHap\\nentry:test\\nentry:onDeviceTest'); }
    else if (args.includes('test')) {
      if ('${mode}' !== 'missing') {
        const file = path.join(process.cwd(), 'entry/.test/default/intermediates/test/coverage_data/test_result.txt');
        fs.mkdirSync(path.dirname(file), { recursive:true });
        fs.writeFileSync(file, '${mode}' === 'test-failure' ? '[fail] Suite#case\\n' :
          '${mode}' === 'wrong-scope' ? '[pass] Other#case\\n' : '[pass] Suite#case\\n');
      }
      if ('${mode}' === 'mutate-source') { fs.appendFileSync(path.join(process.cwd(), 'entry/test/Index.test.ets'), '// tool changed source\\n'); }
      console.log('BUILD SUCCESSFUL');
    } else if (args.includes('assembleHap')) {
      if ('${mode}' === 'failure') { console.error('ERROR: 10905108 ArkTS Compiler Error\\nError Message: original diagnostic'); process.exitCode = 7; }
      else if ('${mode}' !== 'no-artifact') {
        const file = path.join(process.cwd(), 'entry/build/default/outputs/default/entry-default-unsigned.hap');
        fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'actual fixture artifact');
      }
    }
  `);
  await put('official/ohpm.cjs', "console.log('official dependency fixture');\n");
  vi.spyOn(ToolProvider, 'new').mockResolvedValue(provider);
  return provider;
}
async function approve(id: string, input: unknown, setup: Awaited<ReturnType<typeof fixture>>) {
  const plan = await setup.runtime.execute(id, input, setup.context);
  expect(plan.exitCode).toBe(5);
  const approvedPlan = (plan.data as { planId: string }).planId;
  return setup.runtime.execute(id, input, { ...setup.context, policy: { ...setup.context.policy, approvedPlan } });
}

it('resolves file-scoped tests without evaluating comments or strings and without running a tool', async () => {
  const setup = await fixture();
  const result = await setup.runtime.execute('test.plan', { kind: 'local', files: ['entry/test/Index.test.ets'] }, setup.context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ modules: ['entry'], scope: ['Suite'], execution: 'not-run', methodCandidates: ['Suite#case'] });
});

it('rejects scopes and module targets that would broaden the requested execution', async () => {
  const setup = await fixture();
  await officialFixture();
  expect((await setup.runtime.execute('test.plan', { kind: 'local', files: ['entry/test/Index.test.ets'], scope: ['Missing'] }, setup.context)).exitCode).toBe(4);
  expect((await setup.runtime.execute('build.run', { modules: ['entry@missing'] }, setup.context)).exitCode).toBe(4);
});

it('reviews the actual build then preserves artifact and input hashes in immutable provenance', async () => {
  const setup = await fixture();
  await officialFixture();
  const result = await approve('build.run', {}, setup);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ execution: 'executed', product: 'default', buildMode: 'debug',
    provenance: { completeness: 'incomplete', tools: { hvigor: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } } });
  expect(result.provenance).toMatchObject({ adapter: 'native', completeness: 'incomplete', manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const artifacts = result.artifacts ?? [];
  expect(artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'hap' }), expect.objectContaining({ kind: 'build-provenance' })]));
  const provenance = JSON.parse(await readFile(artifacts.find((item) => item.kind === 'build-provenance')!.path, 'utf8'));
  expect(provenance).toMatchObject({ product: 'default', modules: ['entry@default'], buildMode: 'debug' });
  const sbom = artifacts.find(item => item.kind === 'build-sbom')!;
  expect(sbom).toBeDefined();
  const bytes = await readFile(sbom.path);
  expect(provenance.sbom).toMatchObject({ path: sbom.path, sha256: sbom.sha256,
    format: 'cyclonedx', scope: 'dependency-inventory' });
  expect(JSON.parse(bytes.toString())).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6',
    components: expect.arrayContaining([expect.objectContaining({ name: 'entry' })]) });
  expect(provenance.inputs).toContainEqual(expect.objectContaining({ path: 'AppScope/app.json5', sha256: expect.any(String) }));
  const calls = (await readFile(join(root, 'build/calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(calls.some((call) => call.args.includes('assembleHap') && call.args.includes('module=entry@default'))).toBe(true);
  expect(calls.every((call) => call.home.startsWith(join(root, 'private')))).toBe(true);
});

it('does not replace official error text or its nonzero exit code with a success message', async () => {
  const setup = await fixture();
  await officialFixture('failure');
  const result = await approve('build.run', {}, setup);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ execution: 'failed',
    invocations: expect.arrayContaining([expect.objectContaining({ toolExitCode: 7, stderr: expect.stringContaining('10905108') })]),
    diagnostics: expect.arrayContaining([expect.objectContaining({ priority: 'P0', original: expect.stringContaining('original diagnostic') })]) });
});

it('requires fresh test evidence even when the official task exits zero', async () => {
  const setup = await fixture();
  await officialFixture('missing');
  await put('entry/.test/default/intermediates/test/coverage_data/test_result.txt', '[pass] Old#case\n');
  const result = await approve('test.local', { files: ['entry/test/Index.test.ets'] }, setup);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ execution: 'build-only', reports: [expect.objectContaining({ status: 'stale', result: null })] });
});

it('records failed cases even when the producer itself exits zero', async () => {
  const setup = await fixture();
  await officialFixture('test-failure');
  const result = await approve('test.local', { files: ['entry/test/Index.test.ets'] }, setup);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ execution: 'executed', reports: [expect.objectContaining({ status: 'fresh', failed: 1, passed: 0 })] });
});

it('does not accept fresh results from a different suite as the selected file execution', async () => {
  const setup = await fixture();
  await officialFixture('wrong-scope');
  const result = await approve('test.local', { files: ['entry/test/Index.test.ets'] }, setup);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ execution: 'build-only', reports: [expect.objectContaining({ scopeMatched: false })] });
});

it('ignores regex literals and rejects dynamic suites instead of silently broadening scope', async () => {
  const setup = await fixture();
  await put('entry/test/Index.test.ets', "const regex = /describe('Regex', () => {})/;\ndescribe('Suite', () => { it('case', 0, () => {}); });\n");
  const planned = await setup.runtime.execute('test.plan', { kind: 'local', files: ['entry/test/Index.test.ets'] }, setup.context);
  expect(planned.data).toMatchObject({ scope: ['Suite'] });
  await put('entry/test/Index.test.ets', "describe(suiteName, () => { it('case', 0, () => {}); });\n");
  expect((await setup.runtime.execute('test.plan', { files: ['entry/test/Index.test.ets'] }, setup.context)).exitCode).toBe(4);
});

it('invalidates an approved build if the actual tool bytes change', async () => {
  const setup = await fixture();
  const provider = await officialFixture();
  const planned = await setup.runtime.execute('build.run', {}, setup.context);
  expect(planned.exitCode).toBe(5);
  await writeFile(provider.hvigorJsPath, '// changed tool\n', { flag: 'a' });
  const result = await setup.runtime.execute('build.run', {}, { ...setup.context,
    policy: { ...setup.context.policy, approvedPlan: (planned.data as { planId: string }).planId } });
  expect(result.exitCode).toBe(5);
  expect(result.data).toMatchObject({ code: 'APPROVAL_STALE' });
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('builds HAP and HAR modules in separate official task scopes', async () => {
  const setup = await fixture();
  await officialFixture();
  const profile = JSON.parse(await readFile(join(root, 'build-profile.json5'), 'utf8'));
  profile.modules.push({ name: 'shared', srcPath: './shared' });
  await put('build-profile.json5', JSON.stringify(profile));
  await put('shared/src/main/module.json5', '{"module":{"name":"shared","type":"har"}}');
  await writeFile(join(root, 'official/hvigorw.cjs'), "if (process.argv.includes('tasks')) { console.log('shared:default@assembleHar'); }\n", { flag: 'a' });
  await approve('build.run', { modules: ['entry', 'shared'] }, setup);
  const calls = (await readFile(join(root, 'build/calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const hap = calls.find((call) => call.args.includes('assembleHap'));
  expect(hap.args).toContain('module=entry@default');
  expect(hap.args).not.toContain('assembleHar');
  expect(calls.find((call) => call.args.includes('assembleHar')).args).toContain('module=shared@default');
});

it('reads the official description-list catalog with explicit module and product selectors', async () => {
  const setup = await fixture();
  const provider = await officialFixture();
  await writeFile(provider.hvigorJsPath, (await readFile(provider.hvigorJsPath, 'utf8')).replace(
    "console.log('entry:default@assembleHap\\nentry:test\\nentry:onDeviceTest')",
    "console.log(args.includes('module=entry@default') && args.includes('product=default') ? 'assembleHap - Assemble module\\ntest - Run local tests' : 'init - Initialize')"));
  const result = await approve('build.run', {}, setup);
  expect(result.exitCode).toBe(0);
  const invocation = (result.data as { invocations: { argv: string[] }[] }).invocations.find((item) => item.argv.includes('tasks'));
  expect(invocation?.argv).toContain('module=entry@default');
  expect(invocation?.argv).toContain('product=default');
});

it('uses hashed installed task declarations when the official task command exposes only lazy init tasks', async () => {
  const setup = await fixture();
  const provider = await officialFixture();
  await writeFile(provider.hvigorJsPath, (await readFile(provider.hvigorJsPath, 'utf8')).replace(
    "console.log('entry:default@assembleHap\\nentry:test\\nentry:onDeviceTest')", "console.log('init - Refresh project')"));
  await put('hvigor-ohos-plugin/src/tasks/common/task-names.js', '_.ASSEMBLE_HAP={name:"assembleHap",description:"Build HAP"};\n');
  await put('hvigor-ohos-plugin/src/tasks/manager/global-task-creation-manager.js',
    'class AssembleHapCA { declareTaskDetail=()=>task_names_js_1.TaskNames.CommonHookTask.ASSEMBLE_HAP; }\n');
  const result = await approve('build.run', {}, setup);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ provenance: { toolchain: {
    taskDefinitions: { tasks: ['assembleHap'], inputs: expect.arrayContaining([expect.objectContaining({ sha256: expect.any(String) })]) },
  } } });
});

it('recognizes the src/test layout used by the installed official Local Test producer', async () => {
  const setup = await fixture();
  await put('entry/src/test/Acceptance.test.ets', "describe('Acceptance', () => { it('math', 0, () => {}); });\n");
  const result = await setup.runtime.execute('test.plan', { files: ['entry/src/test/Acceptance.test.ets'] }, setup.context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ modules: ['entry'], scope: ['Acceptance'], methodCandidates: ['Acceptance#math'] });
});

it('builds Local Test with UnitTestBuild and never selects an ohosTest target', async () => {
  const setup = await fixture();
  const provider = await officialFixture();
  await writeFile(provider.hvigorJsPath, "if (process.argv.includes('tasks')) { console.log('UnitTestBuild - Build unit test'); }\n", { flag: 'a' });
  const result = await approve('test.local', { modules: ['entry'], buildOnly: true, coverage: false }, setup);
  expect(result.exitCode).toBe(3);
  const calls = (await readFile(join(root, 'build/calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(calls.some((call) => call.args.includes('UnitTestBuild') && call.args.includes('module=entry'))).toBe(true);
  expect(calls.some((call) => call.args.includes('assembleHap') || call.args.some((arg: string) => arg.includes('@ohosTest')))).toBe(false);
});

it('requires every selected literal method, not just one result from the suite', async () => {
  const setup = await fixture();
  await officialFixture();
  await put('entry/test/Index.test.ets', "describe('Suite', () => { it('case', 0, () => {}); it('other', 0, () => {}); });\n");
  const result = await approve('test.local', { files: ['entry/test/Index.test.ets'] }, setup);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ reports: [expect.objectContaining({ missingCases: ['Suite#other'] })] });
});

it('rejects a module with no local test declarations before executing project scripts', async () => {
  const setup = await fixture();
  await officialFixture();
  await rm(join(root, 'entry/test'), { recursive: true });
  const result = await setup.runtime.execute('test.local', { modules: ['entry'] }, setup.context);
  expect(result.exitCode).toBe(4);
  await expect(readFile(join(root, 'build/calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects file scope when another file declares the same suite or method identity', async () => {
  const setup = await fixture();
  await put('entry/test/Other.test.ets', "describe('Suite', () => { it('hidden', 0, () => {}); });\n");
  const result = await setup.runtime.execute('test.plan', { files: ['entry/test/Index.test.ets'] }, setup.context);
  expect(result.exitCode).toBe(4);
});

it('maps distinct module suites to separate invocations and rejects scopes missing from all modules', async () => {
  const setup = await fixture();
  await officialFixture();
  const profile = JSON.parse(await readFile(join(root, 'build-profile.json5'), 'utf8'));
  profile.modules.push({ name: 'shared', srcPath: './shared' });
  await put('build-profile.json5', JSON.stringify(profile));
  await put('shared/src/main/module.json5', '{"module":{"name":"shared","type":"har"}}');
  await put('shared/src/test/Index.test.ets', "describe('Shared', () => { it('one', 0, () => {}); });\n");
  expect((await setup.runtime.execute('test.plan', { modules: ['entry', 'shared'], scope: ['Missing'] }, setup.context)).exitCode).toBe(4);
  const planned = await setup.runtime.execute('test.plan', { modules: ['entry', 'shared'] }, setup.context);
  expect(planned.data).toMatchObject({ selections: [
    { module: 'entry', scope: ['Suite'], expectedCases: ['Suite#case'] },
    { module: 'shared', scope: ['Shared'], expectedCases: ['Shared#one'] },
  ] });
  await approve('test.local', { modules: ['entry', 'shared'] }, setup);
  const calls = (await readFile(join(root, 'build/calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const tests = calls.filter((call) => call.args.includes('test'));
  expect(tests).toHaveLength(2);
  expect(tests[0].args).toEqual(expect.arrayContaining(['module=entry', 'scope=Suite']));
  expect(tests[1].args).toEqual(expect.arrayContaining(['module=shared', 'scope=Shared']));
});

it('does not certify an unchanged artifact as produced by a zero-exit build', async () => {
  const setup = await fixture();
  await officialFixture('no-artifact');
  await put('entry/build/default/outputs/default/entry-default-unsigned.hap', 'previous artifact');
  const result = await approve('build.run', {}, setup);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ verification: { artifactIdentity: 'incomplete' },
    provenance: { artifactEvidence: [expect.objectContaining({ status: 'reused-unverified' })] } });
});

it('does not use an unrelated module artifact to satisfy the requested module build', async () => {
  const setup = await fixture();
  await officialFixture('no-artifact');
  const profile = JSON.parse(await readFile(join(root, 'build-profile.json5'), 'utf8'));
  profile.modules.push({ name: 'shared', srcPath: './shared' });
  await put('build-profile.json5', JSON.stringify(profile));
  await put('shared/src/main/module.json5', '{"module":{"name":"shared","type":"har"}}');
  await put('shared/build/default/outputs/default/shared.har', 'unrelated artifact');
  const result = await approve('build.run', { modules: ['entry'] }, setup);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ verification: { artifactIdentity: 'incomplete' } });
});

it('does not certify a test if a project script changes the reviewed source during execution', async () => {
  const setup = await fixture();
  await officialFixture('mutate-source');
  const result = await approve('test.local', { modules: ['entry'] }, setup);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ sourceDrift: ['entry/test/Index.test.ets'] });
});
