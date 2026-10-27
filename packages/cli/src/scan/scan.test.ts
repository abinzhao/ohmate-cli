/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { ToolProvider } from '../toolchain/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-scan-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function put(path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
}
async function fixture(mode = 'positive') {
  await put('build-profile.json5', '{"modules":[{"name":"entry","srcPath":"./entry"},{"name":"lib","srcPath":"./lib"}]}');
  for (const module of ['entry', 'lib']) {
    await put(`${module}/src/main/module.json5`, `{"module":{"name":"${module}","type":"har"}}`);
    await put(`${module}/src/main/ets/Api.ts`, 'export function value(): number { return 1; }\n');
  }
  await put('linter.json5', '{files:["**/*.ts"],rules:{"@typescript-eslint/no-explicit-any":"error"}}');
  await put('official/linter.cjs', `
    const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
    const output = args[args.indexOf('--output')+1], mode = ${JSON.stringify(mode)};
    fs.writeFileSync(path.join(process.env.HOME, 'observed.json'), JSON.stringify({args, home:process.env.HOME}));
    const file = args[0], finding = {filePath:mode==='outside' ? path.join(process.cwd(),'lib/src/main/ets/Api.ts') : file,
      messages:[{line:1,column:31,severity:'error',message:'Disallow any <script>',rule:'@typescript-eslint/no-explicit-any'},
                {line:1,column:31,severity:'error',message:'Disallow any <script>',rule:'@typescript-eslint/no-explicit-any'}]};
    if (mode !== 'missing') { fs.writeFileSync(output, mode==='malformed' ? '{}' : JSON.stringify(mode==='positive' || mode==='failure' || mode==='drift' ? [] : [finding])); }
    if (mode==='drift') { fs.appendFileSync(file, '// changed'); }
    if (mode==='added') { fs.writeFileSync(path.join(path.dirname(file), 'Added.ts'), 'export const added = 1;'); }
    if (mode==='linked') { fs.symlinkSync(file, path.join(path.dirname(file), 'Linked.ts')); }
    console.error('original official output');
    process.exitCode = mode==='failure' ? 17 : ['negative','outside','added'].includes(mode) ? 4 : 0;
  `);
  vi.spyOn(ToolProvider, 'new').mockResolvedValue({
    nodePath: process.execPath, codelinterPath: join(root, 'official/linter.cjs'),
    sourceType: 'studio', readVersion: () => '26.0.0.821', sdkPath: join(root, 'official/sdk'),
  } as unknown as ToolProvider);
  return { runtime: await createRuntime(), context: await createExecutionContext({
    cwd: root, projectRoot: root, dataDir: join(root, 'private'),
  }) };
}

it('runs the requested official scope in a private home and archives raw JSON, SARIF and escaped HTML', async () => {
  const { runtime, context } = await fixture('negative');
  const result = await runtime.execute('scan', { files: ['entry/src/main/ets/Api.ts'], domains: ['official'], config: 'linter.json5' }, context);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ execution: 'executed', scope: { modules: ['entry'], files: ['entry/src/main/ets/Api.ts'] },
    findings: [expect.objectContaining({ ruleId: '@typescript-eslint/no-explicit-any', file: 'entry/src/main/ets/Api.ts', line: 1, column: 31, source: 'official-codelinter' })],
    invocations: [expect.objectContaining({ toolExitCode: 4, stderr: expect.stringContaining('original official') })] });
  const data = result.data as { invocations: { argv: string[] }[] };
  expect(data.invocations[0].argv).toContain('--exit-on');
  expect(data.invocations[0].argv).not.toContain('--fix');
  const raw = result.artifacts.find((item) => item.kind === 'scan-raw-result')!;
  expect(JSON.parse(await readFile(raw.path, 'utf8'))[0].messages).toHaveLength(2);
  const sarif = JSON.parse(await readFile(result.artifacts.find((item) => item.kind === 'scan-sarif')!.path, 'utf8'));
  expect(sarif.runs[0].results).toHaveLength(1);
  expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('entry/src/main/ets/Api.ts');
  const html = await readFile(result.artifacts.find((item) => item.kind === 'scan-html')!.path, 'utf8');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
});

it('does not certify unimplemented domains based on an empty official report', async () => {
  const { runtime, context } = await fixture();
  const partial = await runtime.execute('scan', { modules: ['entry'] }, context);
  expect(partial.exitCode).toBe(3);
  expect(partial.data).toMatchObject({ coverage: { completeness: 'incomplete', domains: expect.arrayContaining([
    expect.objectContaining({ domain: 'grammar', status: 'not-run' }),
  ]) } });
  expect((await runtime.execute('scan', { modules: ['entry'], domains: ['official'] }, context)).exitCode).toBe(0);
  const unavailable = await runtime.execute('scan', { modules: ['entry'], domains: ['memory'] }, context);
  expect(unavailable.exitCode).toBe(3);
  expect(unavailable.data).toMatchObject({ execution: 'not-run', invocations: [] });
});

it.each(['malformed', 'missing', 'outside', 'failure'])('preserves official evidence and refuses %s reports', async (mode) => {
  const { runtime, context } = await fixture(mode);
  const result = await runtime.execute('scan', { files: ['entry/src/main/ets/Api.ts'], domains: ['official'] }, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ execution: 'failed', invocations: [expect.objectContaining({ stderr: expect.stringContaining('original official') })] });
  expect(result.artifacts.some((item) => item.kind === 'scan-report')).toBe(true);
});

it.each(['drift', 'added'])('refuses source %s during producer execution', async (mode) => {
  const { runtime, context } = await fixture(mode);
  const result = await runtime.execute('scan', { modules: ['entry'], domains: ['official'] }, context);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ sourceDrift: expect.arrayContaining([mode === 'drift' ? 'entry/src/main/ets/Api.ts' : 'entry/src/main/ets/Added.ts']) });
});

it('retains invocation evidence when the producer makes the input tree unsafe during execution', async () => {
  const { runtime, context } = await fixture('linked');
  const result = await runtime.execute('scan', { modules: ['entry'], domains: ['official'] }, context);
  expect(result.exitCode).toBe(6);
  expect(result.data).toMatchObject({ execution: 'failed', invocations: [expect.objectContaining({ toolExitCode: 0 })] });
  expect(result.artifacts.some((item) => item.kind === 'scan-report')).toBe(true);
});

it('rejects missing modules, crossed scope, symlinks and unregistered fix/apply before launching a tool', async () => {
  const { runtime, context } = await fixture();
  for (const input of [{ modules: ['missing'] }, { modules: ['lib'], files: ['entry/src/main/ets/Api.ts'] },
    { files: ['../Api.ts'] }, { files: ['entry/src/main/ets/Missing.ts'] }, { fix: true }, { apply: true }]) {
    expect((await runtime.execute('scan', input, context)).exitCode).toBe(4);
  }
  await symlink(join(root, 'lib/src/main/ets/Api.ts'), join(root, 'entry/src/main/ets/Linked.ts'));
  expect((await runtime.execute('scan', { files: ['entry/src/main/ets/Linked.ts'] }, context)).exitCode).toBe(4);
});

it('returns unavailable when the official producer cannot be discovered', async () => {
  const { runtime, context } = await fixture();
  vi.spyOn(ToolProvider, 'new').mockRejectedValue(new Error('Code Linter not installed'));
  const result = await runtime.execute('scan', { domains: ['official'] }, context);
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ execution: 'not-run', code: 'OFFICIAL_PRODUCER_UNAVAILABLE' });
});
