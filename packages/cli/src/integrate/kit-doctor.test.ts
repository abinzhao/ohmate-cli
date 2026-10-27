/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext } from '../runtime/context.js';
import { runKitTool } from './kit-tools.js';
import { prepareRuntimeIntegration, runtimeIntegrationSchema } from './runtime-integration.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-doctor-'));
  await mkdir(join(root, 'entry/src/main/ets'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), JSON.stringify({
    app: { products: [{ name: 'default', compatibleSdkVersion: '6.0.0(20)', targetSdkVersion: '6.0.0(20)' }] },
    modules: [{ name: 'entry', srcPath: './entry' }],
  }));
  await writeFile(join(root, 'entry/src/main/module.json5'), '{"module":{"name":"entry","type":"entry"}}');
  await writeFile(join(root, 'entry/hvigorfile.ts'), "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n");
  await writeFile(join(root, 'entry/oh-package.json5'), '{"dependencies":{"@ohmate/ohmatekit":"file:../ohmatekit"}}');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function context() {
  return createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
}
async function integrate(profile: 'debug' | 'test' | 'release-none') {
  const prepared = await prepareRuntimeIntegration(runtimeIntegrationSchema.parse({ module: 'entry', profile }), await context());
  for (const change of prepared.patch.changes) { await writeFile(join(root, change.path), change.text!); }
}
async function doctor() { return runKitTool('doctor', {}, await context()); }

it('reads consumer API and dependency declarations without inventing API26 or an actual build mode', async () => {
  const result = await doctor();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ staticValid: true, checks: {
    api: { source: 'consumer-build-profile', minimumSupportedApi: 'unverified', products: [
      { name: 'default', compatibleSdkVersion: '6.0.0(20)', targetSdkVersion: '6.0.0(20)', compileSdkVersion: null },
    ] },
    buildMode: { actual: null, source: 'hvigor-context-unavailable' },
    dependencies: { binding: 'declaration-only', modules: [
      { name: 'entry', coordinate: '@ohmate/ohmatekit', version: 'file:../ohmatekit' },
    ] },
  }, missing: expect.arrayContaining(['actual-hvigor-build-mode', 'minimum-supported-api-matrix', 'compiler-dependency-closure']) });
  await expect(readFile(join(root, 'runtime-profile.json5'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['debug', 'test'] as const)('checks %s manifest source bindings while keeping compiler evidence incomplete', async profile => {
  await integrate(profile);
  const result = await doctor();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ checks: { buildMode: { actual: null, manifests: [
    { module: 'entry', profile, declared: 'debug', required: 'debug', sourceBinding: 'matched' },
  ] } }, missing: expect.arrayContaining(['compiler-bound-profile-entry', 'final-artifact-purity']) });
});

it('rejects a Test manifest claiming Test Build Mode instead of the required debug mode', async () => {
  await integrate('test');
  const path = join(root, 'entry/ohmate-profile-manifest.json');
  const value = JSON.parse(await readFile(path, 'utf8')); value.buildMode = 'test';
  await writeFile(path, JSON.stringify(value));
  const result = await doctor();
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ staticValid: false, findings: expect.arrayContaining([
    expect.objectContaining({ code: 'RUNTIME_MANIFEST_BUILD_MODE_MISMATCH' }),
  ]) });
});

it.each(['entry', 'profile', 'dependency', 'dependency-version', 'guard'] as const)('rejects current %s drift without running or rewriting the integration', async target => {
  await integrate('debug');
  if (target === 'entry') { await writeFile(join(root, 'entry/src/main/ets/OHMateRuntimeEntry.ets'), 'export class Changed {}\n'); }
  if (target === 'profile') {
    await writeFile(join(root, 'runtime-profile.json5'), '{"schemaVersion":"1.0","release":"core","debug":"debug","test":"test","probes":[]}');
  }
  if (target === 'dependency') { await writeFile(join(root, 'entry/oh-package.json5'), '{"dependencies":{}}'); }
  if (target === 'dependency-version') {
    await writeFile(join(root, 'entry/oh-package.json5'), '{"dependencies":{"@ohmate/ohmatekit":"6.0.1"}}');
  }
  if (target === 'guard') { await writeFile(join(root, 'entry/ohmate-runtime-hvigor.ts'), 'export const bypass = true;\n'); }
  expect((await doctor()).exitCode).toBe(1);
});

it.each(['consumer', 'dependency', 'profile'] as const)('reports malformed %s declarations with a stable rejection code', async target => {
  const path = target === 'consumer' ? 'build-profile.json5' : target === 'dependency' ? 'entry/oh-package.json5' : 'runtime-profile.json5';
  await writeFile(join(root, path), '{ malformed');
  expect(await doctor()).toMatchObject({ exitCode: 1, data: { staticValid: false, findings: [
    { code: 'RUNTIME_DOCTOR_CONFIG_INVALID', source: 'ohmate' },
  ] } });
});

it('reports absent SDK values and integration files as gaps, rather than certification or invalid configuration', async () => {
  await writeFile(join(root, 'build-profile.json5'), '{"modules":[{"name":"entry","srcPath":"./entry"}]}');
  const result = await doctor();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ staticValid: true, missing: expect.arrayContaining([
    'consumer-sdk-products', 'entry:runtime-profile-manifest',
  ]) });
});
