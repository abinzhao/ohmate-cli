/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';

let root: string;
const configPath = 'entry/src/main/module.json5';
const extension = { name: 'OHMateFaultLogExtension', type: 'faultLog',
  srcEntry: './ets/faultlogextension/OHMateFaultLogExtension.ets', exported: false };
const entrySource = "import { FaultLogExtensionAbility, hiAppEvent } from '@kit.PerformanceAnalysisKit';\n" +
  'export default class OHMateFaultLogExtension extends FaultLogExtensionAbility {\n' +
  'onFaultReportReady(): void { hiAppEvent.addWatcher({name:"OhmateDelayedFault", onReceive:()=>{}}); }\n}\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-faultlog-config-'));
  await mkdir(join(root, 'AppScope'));
  await mkdir(join(root, 'entry/src/main/ets/faultlogextension'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), JSON.stringify({
    app: { products: [{ name: 'default', compatibleSdkVersion: '26.0.0', targetSdkVersion: '26.0.0' }] },
    modules: [{ name: 'entry', srcPath: './entry' }],
  }));
  await writeFile(join(root, 'AppScope/app.json5'), '{"app":{"bundleName":"dev.example.fixture"}}');
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/OHMateFaultLogExtension.ets'), entrySource);
  await moduleConfig();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function moduleConfig(extensions: unknown[] = [extension]) {
  await writeFile(join(root, configPath), JSON.stringify({ module: {
    name: 'entry', type: 'entry', deviceTypes: ['phone'], extensionAbilities: extensions,
  } }));
}
async function validate() {
  const context = await createExecutionContext({ cwd: root, projectRoot: root, dataDir: join(root, 'private') });
  return (await createRuntime()).execute('config.validate', { path: configPath }, context);
}
function findings(result: Awaited<ReturnType<typeof validate>>) {
  return JSON.stringify(result.data);
}
it('keeps an unconfigured optional Extension explicit without changing the configuration', async () => {
  await moduleConfig([]);
  const before = await readFile(join(root, configPath));
  const result = await validate();
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ faultLog: { status: 'not-configured' } });
  expect(await readFile(join(root, configPath))).toEqual(before);
});
it('reports static sources separately from unverified host registration and delayed execution', async () => {
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(result.data).toMatchObject({ valid: null, faultLog: { status: 'incomplete', staticValid: true,
    hostRegistration: 'not-verified', delayedExecution: 'not-run', buildIdentity: 'unverified',
    sources: [{ path: extension.srcEntry.replace('./', 'entry/src/main/'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] } });
});
it.each([
  [{ ...extension, exported: true }, 'FAULTLOG_EXPORTED'],
  [{ ...extension, srcEntry: '../outside.ets' }, 'FAULTLOG_SOURCE_PATH_INVALID'],
  [{ ...extension, srcEntry: './ets/faultlogextension/Missing.ets' }, 'FAULTLOG_SOURCE_MISSING'],
  [{ ...extension, name: 'DifferentClass' }, 'FAULTLOG_ENTRY_UNVERIFIED'],
])('rejects invalid configuration or keeps unverifiable entry incomplete: %s', async (item, code) => {
  await moduleConfig([item]);
  const result = await validate();
  expect(result.exitCode).toBe(code === 'FAULTLOG_ENTRY_UNVERIFIED' ? 3 : 1);
  expect(findings(result)).toContain(code);
});
it('rejects a duplicate Extension name before traversing source', async () => {
  await moduleConfig([extension, { ...extension, type: 'backup' }]);
  expect((await validate()).exitCode).toBe(1);
  expect(findings(await validate())).toContain('FAULTLOG_NAME_DUPLICATE');
});
it.each(['20.0.0', 20])('rejects a declared compatible SDK below API21: %s', async (compatibleSdkVersion) => {
  await writeFile(join(root, 'build-profile.json5'), JSON.stringify({ app: { products: [
    { name: 'default', compatibleSdkVersion, targetSdkVersion: '26.0.0' },
  ] }, modules: [{ name: 'entry', srcPath: './entry' }] }));
  const result = await validate();
  expect(result.exitCode).toBe(1);
  expect(findings(result)).toContain('FAULTLOG_API_TOO_LOW');
});
it.each([
  ["import { window as nativeWindow } from '@kit.ArkUI';", 'FAULTLOG_FORBIDDEN_MODULE'],
  ["import window from '@ohos.window';", 'FAULTLOG_FORBIDDEN_MODULE'],
  ["import { camera } from '@kit.CameraKit';", 'FAULTLOG_FORBIDDEN_MODULE'],
  ["import { UIAbilityContext as Ctx } from '@kit.AbilityKit';", 'FAULTLOG_FORBIDDEN_MODULE'],
])('rejects forbidden Extension dependencies including aliases: %s', async (importText, code) => {
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/OHMateFaultLogExtension.ets'), importText + '\n' + entrySource);
  const result = await validate();
  expect(result.exitCode).toBe(1);
  expect(findings(result)).toContain(code);
});
it('checks transitive local imports and reexports rather than only the Extension entry', async () => {
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/OHMateFaultLogExtension.ets'),
    'import { helper } from "./helper";\n' + entrySource);
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/helper.ets'), 'export { helper } from "./nested";');
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/nested.ets'),
    'import { vibrator } from "@kit.SensorServiceKit"; export const helper = 1;');
  const result = await validate();
  expect(result.exitCode).toBe(1);
  expect(findings(result)).toContain('FAULTLOG_FORBIDDEN_MODULE');
  expect(findings(result)).toContain('nested.ets');
});
it('does not treat string/comment lookalikes as real imports', async () => {
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/OHMateFaultLogExtension.ets'),
    '// import { window } from "@kit.ArkUI";\nconst text = "import window from @ohos.window";\n' + entrySource);
  expect((await validate()).exitCode).toBe(3);
  expect(findings(await validate())).not.toContain('FAULTLOG_FORBIDDEN_MODULE');
});
it.each([
  'const loaded = import("./helper");',
  'const loaded = require("./helper");',
  'import * as tools from "@kit.BasicServicesKit";',
  'import { something } from "unverified-package";',
])('keeps unresolved/dynamic dependency closure incomplete: %s', async (text) => {
  await writeFile(join(root, 'entry/src/main/ets/faultlogextension/OHMateFaultLogExtension.ets'), text + '\n' + entrySource);
  const result = await validate();
  expect(result.exitCode).toBe(3);
  expect(findings(result)).toContain('FAULTLOG_DEPENDENCY_UNVERIFIED');
});
