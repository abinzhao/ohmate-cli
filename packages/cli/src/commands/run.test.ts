/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolProvider } from '../toolchain/index.js';
import { DeviceManager } from '../service/device-manager.js';
import { HdcAdapter } from '../utils/hdc-adapter.js';
import { projectSkillChecker } from '../skills/index.js';
import { telemetry } from '../trace/index.js';
import * as smoke from '../smoke/index.js';
import run from './run.js';

let root: string;
const originalCwd = process.cwd(), originalExitCode = process.exitCode;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-run-paths-'));
  process.chdir(root);
  process.exitCode = undefined;
  vi.stubEnv('DEVECO_CLI_DATA_DIR', join(root, 'state'));
  vi.spyOn(telemetry, 'track').mockResolvedValue(undefined);
  vi.spyOn(projectSkillChecker, 'warnInvalidBundledLinks').mockResolvedValue(undefined);
  vi.spyOn(smoke, 'runPostLaunchSmoke').mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function put(file: string, text: string) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}
async function fixture(failure = false) {
  await put('build-profile.json5', '{"app":{"products":[{"name":"default"}]},"modules":[{"name":"entry","srcPath":"entry"}]}');
  await put('AppScope/app.json5', '{"app":{"bundleName":"org.example.private"}}');
  await put('entry/src/main/module.json5', '{"module":{"type":"entry","abilities":[{"name":"EntryAbility"}]}}');
  await put('build/custom/output/entry-unsigned.hap', 'current artifact');
  await put('build/cache/meta.json', '[{"hapName":"entry-unsigned.hap","isSigned":false}]');
  await put('official/hvigor-ohos-plugin/src/common/iml/module-path-info-iml.js', `
    const path = require('node:path');
    exports.ModulePathInfoIml = class {
      constructor() { this._modulePath = path.resolve('entry'); this._targetName = 'default'; this._productName = 'default'; }
      getModuleBuildOutputPath() { return path.resolve('build/custom/output'); }
      getIntermediatesOutputMetadata() { return path.resolve('build/cache/meta.json'); }
    };
  `);
  await put('official/hvigor.cjs', `
    const fs = require('node:fs'), args = process.argv.slice(2);
    if (args.includes('--help')) console.log('--no-daemon');
    if (args.includes('tasks')) {
      fs.writeFileSync('build/task-args.json', JSON.stringify(args));
      const { ModulePathInfoIml } = require('./hvigor-ohos-plugin/src/common/iml/module-path-info-iml.js');
      const paths = new ModulePathInfoIml();
      paths.getModuleBuildOutputPath();
      ${failure ? 'console.error("private task failure"); process.exitCode = 17;' : ''}
    }
  `);
  const provider = { nodePath: process.execPath, javaPath: process.execPath,
    hvigorJsPath: join(root, 'official/hvigor.cjs'), ohpmJsPath: join(root, 'official/ohpm.cjs'),
    sdkPath: join(root, 'official/sdk'), assertJava: () => undefined } as unknown as ToolProvider;
  vi.spyOn(ToolProvider, 'new').mockResolvedValue(provider);
  vi.spyOn(DeviceManager, 'from').mockReturnValue({
    listDevices: async () => ['localhost:private-test'],
    getDeviceInfo: async () => ({ serial: 'localhost:private-test' }),
  } as unknown as DeviceManager);
  const install = vi.spyOn(HdcAdapter.prototype, 'installApp').mockResolvedValue(undefined);
  vi.spyOn(HdcAdapter.prototype, 'launchApp').mockResolvedValue('private launch');
  return { install };
}
it('installs the observed custom artifact through run --skip-build', async () => {
  const { install } = await fixture();
  await run.parseAsync(['--module', 'entry', '--device', 'localhost:private-test', '--skip-build'], { from: 'user' });
  expect(install).toHaveBeenCalledWith('localhost:private-test', [join(root, 'build/custom/output/entry-unsigned.hap')]);
  expect(process.exitCode).toBeUndefined();
  expect(JSON.parse(await readFile(join(root, 'build/task-args.json'), 'utf8'))).toEqual(
    ['tasks', '--mode', 'module', '-p', 'module=entry@default', '-p', 'product=default', '-p', 'buildMode=debug', '--no-daemon']);
  expect(await readdir(join(root, 'state/tool-runs'))).toEqual([]);
  const names = await readdir(join(root, 'state/artifacts'));
  const evidence = JSON.parse(await readFile(join(root, 'state/artifacts', names.find(name => name.startsWith('run-artifact-paths-'))!), 'utf8'));
  expect(evidence).toMatchObject({ outputLayout: { invalid: false, binding: 'observed-partial' },
    artifacts: [join(root, 'build/custom/output/entry-unsigned.hap')], buildIdentity: 'unverified' });
});
it('retains a failed official path query and refuses installation', async () => {
  const { install } = await fixture(true);
  await run.parseAsync(['--module', 'entry', '--device', 'localhost:private-test', '--skip-build'], { from: 'user' });
  expect(install).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(await readdir(join(root, 'state/tool-runs'))).toEqual([]);
  const names = await readdir(join(root, 'state/artifacts'));
  const evidence = JSON.parse(await readFile(join(root, 'state/artifacts', names.find(name => name.startsWith('run-artifact-paths-'))!), 'utf8'));
  expect(evidence.invocations.at(-1)).toMatchObject({ toolExitCode: 17, signal: null,
    finishedAt: expect.any(String), outputHashes: { complete: true } });
});
