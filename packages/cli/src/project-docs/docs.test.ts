/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ToolProvider } from '../toolchain/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-docs-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function put(path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
}
async function fixture(mode = 'positive') {
  await put('build-profile.json5', '{"modules":[{"name":"entry","srcPath":"./entry"}]}');
  await put('entry/src/main/module.json5', '{"module":{"name":"entry","type":"har"}}');
  await put('entry/src/main/ets/Api.ts', 'export class Api { public value(): number { return 1; } private secret(): void {} }\nclass Hidden {}\n');
  const compiler = 'official/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript';
  await put(`${compiler}/package.json`, '{"name":"fixture-compiler","version":"test","main":"lib/typescript.js"}');
  await put(`${compiler}/lib/typescript.js`, `module.exports = require(${JSON.stringify(createRequire(import.meta.url).resolve('typescript'))});`);
  await put('official/tools/arktsdoc/index.js', `
    const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
    const output = args[args.indexOf('-d')+1], input = args[args.indexOf('-i')+1], mode=${JSON.stringify(mode)};
    const doc = {id:Math.random(),createTime:Date.now(),children:[{filePath:path.basename(input),fileKind:'file',
      jsDoc:[{id:Math.random(),kind:'Class',name:'Api',signature:{label:'class Api'},description:'API <script>',tags:[],
        classLikeInfo:{methods:[{name:'value',kind:'Method',description:'Read value',signature:{label:'value(): number'},tags:[]},
          {name:'secret',kind:'Method',modifiers:['Private'],signature:{label:'secret(): void'},tags:[]}]}},
        {kind:'Class',name:'Hidden',signature:{label:'class Hidden'},tags:[]}]}]};
    if (mode==='omitted') { doc.children=[]; }
    if (mode==='signature') { doc.children[0].jsDoc[0].classLikeInfo.methods[0].signature.label='value(): string'; }
    fs.mkdirSync(path.join(output,'docs'),{recursive:true});
    fs.writeFileSync(path.join(output,'docs/index.html'), '<html><script>window.getArkDocInfo = function() { return '+(mode==='malformed' ? 'executeMalicious()' : JSON.stringify(doc))+'; };</script></html>');
    if (mode==='drift') { fs.appendFileSync(input,'// changed'); }
    if (mode==='compiler-drift') { fs.writeFileSync('official/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/package.json','{"name":"fixture-compiler","version":"changed"}'); }
    if (mode==='linked') { fs.symlinkSync(input, path.join(path.dirname(input), 'Linked.ts')); }
    console.error('original ArkTSDoc output'); process.exitCode=mode==='failure' ? 17 : 0;
  `);
  vi.spyOn(ToolProvider, 'new').mockResolvedValue({
    nodePath: process.execPath, toolchainRoot: join(root, 'official'), sourceType: 'studio',
    arktsdocPath: join(root, 'official/tools/arktsdoc/index.js'),
    sdkPath: join(root, 'official/sdk'), readVersion: () => '26.0.0.821',
  } as unknown as ToolProvider);
  return { runtime: await createRuntime(), context: await createExecutionContext({
    cwd: root, projectRoot: root, dataDir: join(root, 'private'),
  }) };
}
const input = { files: ['entry/src/main/ets/Api.ts'] };

it('produces one stable public API model for HTML, index, AI JSON and check while retaining raw producer evidence', async () => {
  const { runtime, context } = await fixture();
  const generated = await runtime.execute('docs.generate', input, context);
  expect(generated.exitCode).toBe(0);
  const model = generated.data as { model: { entries: { name: string; id: string }[] }; modelHash: string };
  expect(model.model.entries.map((item) => item.name)).toEqual(['Api', 'Api.value']);
  expect(model.model.entries[0].id).toMatch(/^[a-f0-9]{64}$/);
  const json = generated.artifacts.find((item) => item.kind === 'docs-ai-json')!;
  expect(JSON.parse(await readFile(json.path, 'utf8'))).toEqual(model.model);
  const index = JSON.parse(await readFile(generated.artifacts.find((item) => item.kind === 'docs-index')!.path, 'utf8'));
  expect(index.modelHash).toBe(model.modelHash);
  const html = await readFile(generated.artifacts.find((item) => item.kind === 'docs-html')!.path, 'utf8');
  expect(html).toContain(model.modelHash); expect(html).toContain('API &lt;script&gt;');
  expect(generated.artifacts.some((item) => item.kind === 'docs-official-html')).toBe(true);
  const checked = await runtime.execute('docs.check', { ...input, baseline: json.path }, context);
  expect(checked.exitCode).toBe(0);
  expect(checked.data).toMatchObject({ modelHash: model.modelHash, diff: { added: [], removed: [], changed: [] } });
});

it('compares signatures on stable symbol identity rather than official random IDs', async () => {
  const setup = await fixture();
  const initial = await setup.runtime.execute('docs.generate', input, setup.context);
  expect(initial.exitCode).toBe(0);
  const baseline = initial.artifacts.find((item) => item.kind === 'docs-ai-json')!.path;
  await writeFile(join(root, 'official/tools/arktsdoc/index.js'), (await readFile(join(root, 'official/tools/arktsdoc/index.js'), 'utf8'))
    .replace('mode="positive"', 'mode="signature"'));
  await put('entry/src/main/ets/Api.ts', 'export class Api { public value(): string { return "1"; } private secret(): void {} }\nclass Hidden {}\n');
  const result = await setup.runtime.execute('docs.check', { ...input, baseline }, setup.context);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ diff: { added: [], removed: [], changed: [expect.objectContaining({ name: 'Api.value' })] } });
});

it('reports API additions and removals when the same module changes its source file set', async () => {
  const { runtime, context } = await fixture();
  const generated = await runtime.execute('docs.generate', { modules: ['entry'] }, context);
  expect(generated.exitCode).toBe(0);
  const baseline = generated.artifacts.find((item) => item.kind === 'docs-ai-json')!.path;
  await put('entry/src/main/ets/Other.ts', await readFile(join(root, 'entry/src/main/ets/Api.ts'), 'utf8'));
  await rm(join(root, 'entry/src/main/ets/Api.ts'));
  const result = await runtime.execute('docs.check', { modules: ['entry'], baseline }, context);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ diff: {
    added: [expect.objectContaining({ file: 'entry/src/main/ets/Other.ts' }), expect.objectContaining({ file: 'entry/src/main/ets/Other.ts' })],
    removed: [expect.objectContaining({ file: 'entry/src/main/ets/Api.ts' }), expect.objectContaining({ file: 'entry/src/main/ets/Api.ts' })],
    changed: [],
  } });
});

it.each(['malformed', 'omitted', 'failure'])('rejects %s producer results without evaluating returned code', async (mode) => {
  const { runtime, context } = await fixture(mode);
  const result = await runtime.execute('docs.generate', input, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ execution: 'failed', invocations: [expect.objectContaining({ stderr: expect.stringContaining('original ArkTSDoc') })] });
  expect(result.artifacts.some((item) => item.kind === 'docs-report')).toBe(true);
});

it('refuses source drift and does not treat a forged baseline as generated documentation', async () => {
  const { runtime, context } = await fixture('drift');
  expect((await runtime.execute('docs.generate', input, context)).exitCode).toBe(3);
  await put('forged.json', '{"schemaVersion":"1.0","entries":[]}');
  expect((await runtime.execute('docs.check', { ...input, baseline: join(root, 'forged.json') }, context)).exitCode).toBe(4);
});

it('keeps raw invocation evidence if source verification becomes unsafe after the producer ran', async () => {
  const { runtime, context } = await fixture('linked');
  const result = await runtime.execute('docs.generate', input, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ execution: 'failed', invocations: [expect.objectContaining({ toolExitCode: 0 })] });
  expect(result.artifacts.some((item) => item.kind === 'docs-report')).toBe(true);
});

it('keeps legacy official docs retrieval commands registered', async () => {
  const { runtime } = await fixture();
  for (const command of ['docs.search', 'docs.read', 'docs.catalog']) {
    expect(runtime.registry.list().some((item) => item.command.join('.') === command && item.adapter === 'legacy-child')).toBe(true);
  }
});

it('resolves named and star re-exports through the compiler and documents their declaration sources', async () => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/Public.ts', "export { Api as PublicApi } from './Api'; export * from './Api';\n");
  const result = await runtime.execute('docs.generate', { files: ['entry/src/main/ets/Public.ts'] }, context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ model: { entries: [
    expect.objectContaining({ file: 'entry/src/main/ets/Public.ts', name: 'Api' }),
    expect.objectContaining({ file: 'entry/src/main/ets/Public.ts', name: 'Api.value' }),
    expect.objectContaining({ file: 'entry/src/main/ets/Public.ts', name: 'PublicApi' }),
    expect.objectContaining({ file: 'entry/src/main/ets/Public.ts', name: 'PublicApi.value' }),
  ] }, coverage: { arkts: 'official-with-compiler-exports' } });
  const compiler = result.artifacts.find((item) => item.kind === 'docs-compiler-exports')!;
  const evidence = JSON.parse(await readFile(compiler.path, 'utf8'));
  expect(evidence).toMatchObject({ compiler: { packageVersion: 'test' }, completeness: 'public-export-program' });
  expect(evidence.reads).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'entry/src/main/ets/Api.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
  expect(evidence.resolutions).toEqual(expect.arrayContaining([expect.objectContaining({ specifier: './Api', resolved: 'entry/src/main/ets/Api.ts' })]));
});

it('groups overloads on stable public identities and keeps compiler signatures separate from implementations', async () => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/Api.ts', 'export class Api { value(v: string): string; value(v: number): number; value(v: string|number): string|number { return v; } }\n');
  const result = await runtime.execute('docs.generate', input, context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ model: { entries: [expect.objectContaining({ name: 'Api' }),
    expect.objectContaining({ name: 'Api.value', signature: 'value(v: string): string\nvalue(v: number): number' })] } });
});

it('retains compiler evidence and prevents certification when a re-export cannot be resolved', async () => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/Public.ts', "export { Missing } from './Missing';");
  const result = await runtime.execute('docs.generate', { files: ['entry/src/main/ets/Public.ts'] }, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ execution: 'failed', failure: expect.stringContaining('resolve') });
  expect(result.artifacts.some((item) => item.kind === 'docs-compiler-exports')).toBe(true);
  expect(result.artifacts.some((item) => item.kind === 'docs-ai-json')).toBe(false);
});

it.each(['', 'Named'])('resolves a %s default class by its compiler declaration identity', async (name) => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/Api.ts', `export default class ${name} { value(): number { return 1; } }\n`);
  const script = join(root, 'official/tools/arktsdoc/index.js');
  await writeFile(script, (await readFile(script, 'utf8')).replace("name:'Api'", `name:'${name || 'default'}'`));
  const result = await runtime.execute('docs.generate', input, context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ model: { entries: [expect.objectContaining({ name: 'default' }),
    expect.objectContaining({ name: 'default.value' })] } });
});

it('does not certify unresolved star re-exports as an empty public module', async () => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/Public.ts', "export * from './Missing';");
  const result = await runtime.execute('docs.generate', { files: ['entry/src/main/ets/Public.ts'] }, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ compiler: { resolutions: [expect.objectContaining({ resolved: null })] } });
});

it('does not certify a star re-export from a source that the compiler says is not a module', async () => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/NotModule.ts', 'const hidden = 1;\n');
  await put('entry/src/main/ets/Public.ts', "export * from './NotModule';");
  const result = await runtime.execute('docs.generate', { files: ['entry/src/main/ets/Public.ts'] }, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ compiler: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 2306 })]) } });
});

it('refuses compiler identity drift even when source files and the ArkTSDoc exit stay unchanged', async () => {
  const { runtime, context } = await fixture('compiler-drift');
  const result = await runtime.execute('docs.generate', input, context);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ sourceDrift: [expect.stringContaining('typescript/package.json')] });
  expect(result.artifacts.some((item) => item.kind === 'docs-ai-json')).toBe(false);
});

it('associates the official anonymous source-text name exactly and removes the implementation from its public signature', async () => {
  const { runtime, context } = await fixture();
  await put('entry/src/main/ets/Api.ts', 'export default class { value(): number { return 1; } }\n');
  const script = join(root, 'official/tools/arktsdoc/index.js');
  await writeFile(script, (await readFile(script, 'utf8'))
    .replace("name:'Api'", "name:fs.readFileSync(input,'utf8').trim()")
    .replace("label:'class Api'", "label:fs.readFileSync(input,'utf8').trim()"));
  const result = await runtime.execute('docs.generate', input, context);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ model: { entries: [expect.objectContaining({ name: 'default', signature: 'class default' }),
    expect.objectContaining({ name: 'default.value', signature: 'value(): number' })] } });
});
