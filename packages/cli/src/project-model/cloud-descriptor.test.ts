/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';
import { readProject } from './project-reader.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ohmate-cloud-descriptor-')); });
afterEach(async () => { await rm(root, { recursive: true }); });
async function put(path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}
async function run(id = 'project.inspect', input: unknown = {}) {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute(id, input, context);
}
async function template(extension = 'ts', functionType = 0, directory = 'backend/functions/hello') {
  await put(`${directory}/function-config.json`, { handler: 'handler.myHandler', functionType, triggers: [
    { type: 'http', properties: { enableUrlDecode: true, authFlag: 'true', authAlgor: 'HDA-SYSTEM', authType: 'apigw-client' } },
  ] });
  await put(`${directory}/package.json`, { name: 'hello', version: '1.0.0', license: 'ISC', dependencies: {} });
  await put(`${directory}/handler.${extension}`, functionType === 1 ?
    'export class myHandler { method1() { return 1; } }\n' :
    'let myHandler = async function (event, context, callback, logger) { callback({ code: 0 }); };\nexport { myHandler };\n');
}
function sha(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }

it.each(['ts', 'js'])('recognizes an official-shaped %s descriptor without server SDK or main', async (extension) => {
  await template(extension);
  const before = await readdir(root), result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'Cloud', facets: ['Cloud'], completeness: 'complete', cloud: [{
    path: 'backend/functions/hello', entry: `backend/functions/hello/handler.${extension}`,
    basis: 'function-descriptor-entry', handler: 'handler.myHandler', functionType: 0,
    evidence: expect.arrayContaining([
      { path: 'backend/functions/hello/function-config.json', sha256: sha(await readFile(join(root, 'backend/functions/hello/function-config.json'))) },
      { path: `backend/functions/hello/handler.${extension}`, sha256: sha(await readFile(join(root, `backend/functions/hello/handler.${extension}`))) },
    ]),
  }], checks: { officialBuild: 'not-run', cloudRuntime: 'not-run', nativeAbi: 'not-run' } });
  expect(await readdir(root)).toEqual(before);
});

it('recognizes cloud-object type and an explicit handler without a manifest', async () => {
  await put('function-config.json', { handler: 'api.myHandler', functionType: 1 });
  await put('api.ts', 'export class myHandler { method1() { return 1; } }\n');
  expect((await run()).data).toMatchObject({ kind: 'Cloud', cloud: [
    expect.objectContaining({ path: '.', entry: 'api.ts', functionType: 1 }),
  ] });
});

it('does not invent a type when the optional official functionType is absent', async () => {
  await put('function-config.json', { handler: 'api.myHandler' });
  await put('api.js', 'exports.myHandler = () => 1;\n');
  const result = await run();
  expect(result.exitCode).toBe(0);
  const cloud = (result.data as { cloud: Record<string, unknown>[] }).cloud;
  expect(cloud[0]).toMatchObject({ handler: 'api.myHandler', entry: 'api.js' });
  expect(cloud[0]).not.toHaveProperty('functionType');
});

it.each([undefined, '', 'handler', 'handler.a.b', '../handler.a', '/handler.a', 'src/handler.a',
  'handler\\nested.a', 'handler:a', 'handler.a\n', 'handler.${NAME}', 'handler.' + 'a'.repeat(57)])(
  'keeps an unsupported or missing handler unverified: %s', async (handler) => {
    await template();
    await put('backend/functions/hello/function-config.json', { handler, functionType: 0 });
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect(result.data).toMatchObject({ kind: 'unknown', facets: [], completeness: 'incomplete', diagnostics:
      expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_CLOUD_DESCRIPTOR_UNRESOLVED' })]) });
  });

it.each([2, -1, 0.5, '0', null])('does not certify an unsupported functionType: %s', async (functionType) => {
  await template();
  await put('backend/functions/hello/function-config.json', { handler: 'handler.myHandler', functionType });
  expect((await run()).data).toMatchObject({ kind: 'unknown', facets: [], completeness: 'incomplete' });
});

it('accepts the exact handler bound and rejects the next byte', async () => {
  const handler = 'a.' + 'b'.repeat(62);
  await put('function-config.json', { handler, functionType: 0 });
  await put('a.ts', `export const ${'b'.repeat(62)} = () => 1;\n`);
  expect((await run()).exitCode).toBe(0);
  await put('function-config.json', { handler: handler + 'b', functionType: 0 });
  expect((await run()).data).toMatchObject({ kind: 'unknown', completeness: 'incomplete' });
});

it.each(['missing', 'empty', 'declaration', 'other-directory', 'unsupported-extension'])(
  'does not substitute %s for the referenced same-directory entry', async (kind) => {
    await template();
    await rm(join(root, 'backend/functions/hello/handler.ts'));
    if (kind !== 'missing') {
      const path = kind === 'declaration' ? 'backend/functions/hello/handler.d.ts' :
        kind === 'other-directory' ? 'elsewhere/handler.ts' :
          kind === 'unsupported-extension' ? 'backend/functions/hello/handler.mjs' : 'backend/functions/hello/handler.ts';
      await put(path, kind === 'empty' ? ' \n' : 'export const myHandler = () => 1;\n');
    }
    expect((await run()).data).toMatchObject({ kind: 'unknown', completeness: 'incomplete', cloud: [], diagnostics:
      expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_CLOUD_ENTRY_UNAVAILABLE' })]) });
  });

it('does not choose between source and compiled entries sharing the handler basename', async () => {
  await template();
  await put('backend/functions/hello/handler.js', 'exports.myHandler = () => 2;\n');
  expect((await run()).data).toMatchObject({ kind: 'unknown', cloud: [], completeness: 'incomplete', diagnostics:
    expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_CLOUD_ENTRY_AMBIGUOUS' })]) });
});

it.each(['function-config.json', 'handler.ts'])('refuses a symlink or hardlink %s without exposing private text', async (name) => {
  for (const kind of ['symlink', 'hardlink']) {
    await template();
    await put(`private/${kind}-${name}`, 'SYNTHETIC_PRIVATE_PAYLOAD');
    const path = join(root, 'backend/functions/hello', name);
    await rm(path);
    if (kind === 'symlink') { await symlink(join(root, 'private', `${kind}-${name}`), path); }
    else { await link(join(root, 'private', `${kind}-${name}`), path); }
    const result = await run();
    expect(result.data).toMatchObject({ kind: 'unknown', completeness: 'incomplete' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_PAYLOAD');
    await rm(path);
  }
});

it.each(['malformed', 'sensitive', 'oversized'])('keeps the existing reader rejection for a %s descriptor', async (kind) => {
  await template();
  await put('backend/functions/hello/function-config.json', kind === 'malformed' ? '{"handler":' :
    kind === 'sensitive' ? { handler: 'handler.myHandler', token: 'SYNTHETIC_PRIVATE_PAYLOAD' } : ' '.repeat(8 * 1024 * 1024 + 1));
  const result = await run();
  expect(result.data).toMatchObject({ kind: 'unknown', completeness: 'incomplete', diagnostics:
    expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_INPUT_UNAVAILABLE' })]) });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_PAYLOAD');
});

it('does not read cloud account configuration or execute a source or package script', async () => {
  await template();
  await put('backend/cloud-config.json', { token: 'SYNTHETIC_ACCOUNT_VALUE' });
  await put('backend/functions/hello/handler.ts', 'throw new Error("SYNTHETIC_EXECUTION_SENTINEL");\n');
  await put('backend/functions/hello/package.json', { name: 'hello', scripts: { postinstall: 'touch unexpected-write' } });
  const result = await run();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ kind: 'Cloud' });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ACCOUNT_VALUE');
  expect(await readdir(join(root, 'backend/functions/hello'))).not.toContain('unexpected-write');
});

it('preserves independent SDK entry evidence and does not promote descriptor discovery into strict preflight', async () => {
  await template();
  await put('worker/package.json', { name: 'worker', main: 'index.js', dependencies: { '@hw-agconnect/cloud-server': '1.0.0' } });
  await put('worker/index.js', 'exports.handler = () => 1;\n');
  expect((await run()).data).toMatchObject({ facets: ['Cloud'], cloud: expect.arrayContaining([
    expect.objectContaining({ basis: 'server-sdk-entry', path: 'worker' }),
    expect.objectContaining({ basis: 'function-descriptor-entry', path: 'backend/functions/hello' }),
  ]) });
  await expect(readProject(root)).rejects.toThrow();
});

it('retains descriptor hashes in dependency inspection and both SBOM facets', async () => {
  await template();
  const path = 'backend/functions/hello/function-config.json', hash = sha(await readFile(join(root, path)));
  const analyzed = await run('deps.analyze');
  expect(analyzed.exitCode).toBe(0);
  expect(analyzed.data).toMatchObject({ project: { kind: 'Cloud' }, inputs: expect.arrayContaining([{ path, sha256: hash }]) });
  for (const standard of ['cyclonedx', 'spdx']) {
    const result = await run('deps.sbom', { standard });
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ project: { kind: 'Cloud', facetEvidence: { Cloud: expect.arrayContaining([{ path, sha256: hash }]) } } });
    expect(JSON.stringify((result.data as { document: unknown }).document)).toContain(hash);
  }
});
