/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext, createRuntime } from '../runtime/index.js';

const exec = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ohmate-kit-tools-'));
  await mkdir(join(root, 'entry/src/main/ets'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'), JSON.stringify({
    app: { products: [{ name: 'default', targetSdkVersion: '26.0.0', compatibleSdkVersion: '26.0.0' }] },
    modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default' }] }],
  }));
  await writeFile(join(root, 'entry/src/main/module.json5'), '{"module":{"name":"entry","type":"entry"}}');
  await writeFile(join(root, 'entry/hvigorfile.ts'), "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n");
  await writeFile(join(root, 'entry/oh-package.json5'), '{"name":"entry","version":"1.0.0","dependencies":{"@ohmate/ohmatekit":"^6.0.0"}}');
  await cp(resolve('kit/ohmatekit/tools'), join(root, 'standalone-tools'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function run(name: string, input: object) {
  try {
    const result = await exec(process.execPath, [join(root, 'standalone-tools', name + '.mjs'),
      '--project', root, '--data-dir', join(root, 'private'), '--input', JSON.stringify(input)], {
      cwd: root, env: { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: '/private/tmp' },
      timeout: 15000, maxBuffer: 1024 * 1024,
    });
    return { exit: 0, value: JSON.parse(result.stdout) };
  } catch (error) {
    const failed = error as { code: number; stdout: string };
    return { exit: failed.code, value: JSON.parse(failed.stdout) };
  }
}

it.each(['release-none', 'debug', 'test'])('standalone generator matches CLI reviewed bytes: %s', async profile => {
  const input = { module: 'entry', profile };
  const runtime = await createRuntime(), context = await createExecutionContext({
    cwd: root, projectRoot: root, dataDir: join(root, 'private'),
  });
  const cli = await runtime.execute('integrate.runtime', input, context);
  const helper = await run('generate-integration', input);
  expect(helper.exit).toBe(0);
  expect(helper.value.data).toEqual(cli.data);
  await expect(readFile(join(root, 'entry/src/main/ets/OHMateRuntimeEntry.ets'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('standalone doctor reports declaration gaps without runtime or artifact claims', async () => {
  const result = await run('doctor', {});
  expect(result.exit).toBe(3);
  expect(result.value.data).toMatchObject({ status: 'incomplete', staticValid: true,
    missing: expect.arrayContaining(['compiler-bound-profile-entry', 'final-artifact-purity']) });
});

it('standalone release verifier shares all fourteen CLI gates and cannot approve missing evidence', async () => {
  const input = { modules: ['entry@default'] };
  const runtime = await createRuntime(), context = await createExecutionContext({
    cwd: root, projectRoot: root, dataDir: join(root, 'private'),
  });
  const cli = await runtime.execute('release.verify', input, context);
  const helper = await run('verify-release', input);
  expect(helper.exit).toBe(cli.exitCode);
  expect(helper.value.data).toEqual(cli.data);
  expect(helper.value.data).toMatchObject({ ready: false, verification: 'static-and-package-evidence', externalActions: [] });
  expect(helper.value.data.gates).toHaveLength(14);
});

it.each(['sarif', 'html'] as const)('standalone verifier renders %s from the same report without creating output files', async format => {
  const input = { modules: ['entry@default'] };
  const plain = await run('verify-release', input);
  const formatted = await run('verify-release', { ...input, format });
  expect(formatted.exit).toBe(plain.exit);
  expect(formatted.value.data).toMatchObject({ format, reportHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  if (format === 'sarif') {
    expect(formatted.value.data.content).toMatchObject({ version: '2.1.0', runs: [
      { properties: { reportHash: formatted.value.data.reportHash, ready: false } },
    ] });
  } else { expect(formatted.value.data.content).toContain(formatted.value.data.reportHash); }
  await expect(readFile(join(root, 'release-purity.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('helper rejects write and unknown switches without changing project source', async () => {
  const result = await run('generate-integration', { module: 'entry', write: true });
  expect(result.exit).toBe(4);
  await expect(readFile(join(root, 'entry/src/main/ets/OHMateRuntimeEntry.ets'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('standalone helper import creates no process, filesystem, timer or network effects', async () => {
  const source = `
    import fs from 'node:fs';
    import child from 'node:child_process';
    import net from 'node:net';
    import timers from 'node:timers';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const target = pathToFileURL(process.argv[1]).href, source = fs.readFileSync(process.argv[1], 'utf8');
    registerHooks({ load(url, context, next) {
      return url === target ? { format: 'module', source, shortCircuit: true } : next(url, context);
    }});
    const blocked = () => { throw new Error('KIT_TOOL_IMPORT_EFFECT'); };
    for (const name of ['writeFileSync', 'mkdirSync', 'openSync', 'readdirSync']) fs[name] = blocked;
    for (const name of ['writeFile', 'mkdir', 'open', 'readdir']) fs.promises[name] = blocked;
    for (const name of ['spawn', 'execFile', 'exec', 'spawnSync']) child[name] = blocked;
    for (const name of ['createConnection', 'connect', 'createServer']) net[name] = blocked;
    timers.setInterval = blocked; timers.setTimeout = blocked;
    globalThis.setInterval = blocked; globalThis.setTimeout = blocked;
    syncBuiltinESMExports();
    await import(target);
    process.stdout.write('IMPORTED');
  `;
  const result = await exec(process.execPath, ['--input-type=module', '--eval', source,
    join(root, 'standalone-tools/runtime.mjs')], {
    cwd: root, env: { HOME: join(root, 'home'), PATH: process.env.PATH, TMPDIR: '/private/tmp' },
    timeout: 15000, maxBuffer: 1024 * 1024,
  });
  expect(result.stdout).toBe('IMPORTED');
  await expect(readFile(join(root, 'private'))).rejects.toMatchObject({ code: 'ENOENT' });
});
