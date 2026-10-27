/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = process.argv[2] ?? 'm0';
if (!/^[a-z0-9-]+$/.test(stage)) { throw new Error('Invalid package validation stage'); }
const packageDir = join(root, 'artifacts/packages', stage);
const temp = await mkdtemp(join(await realpath(tmpdir()), 'ohmate-install-'));
const privateHome = join(temp, 'home');
await mkdir(privateHome, { mode: 0o700 });
await writeFile(join(privateHome, 'npmrc'), '');
await writeFile(join(privateHome, 'global-npmrc'), '');
const packages = ['cli-common', 'knowledgebase', 'ohmatecli'].map((name) => join(packageDir, `ohmate-${name}-0.1.0.tgz`));
function run(executable, args, env = {}) {
  const result = spawnSync(executable, args, {
    cwd: temp, shell: false, encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: privateHome, USERPROFILE: privateHome, TMPDIR: temp, TEMP: temp, TMP: temp,
      NPM_CONFIG_USERCONFIG: join(privateHome, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(privateHome, 'global-npmrc'),
      NPM_CONFIG_CACHE: join(privateHome, 'cache'), OHMATE_DATA_DIR: join(temp, 'data'), ...env },
  });
  if (result.status !== 0) {
    throw new Error(`Verification failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}
await writeFile(join(temp, 'package.json'), '{"private":true,"type":"module"}\n');
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(npmBinary, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', ...packages]);
run(npmBinary, ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
const binary = join(temp, 'node_modules/@ohmate/ohmatecli/cli.js');
const doctor = JSON.parse(run(process.execPath, [binary, 'doctor', '--format', 'json']));
const capabilities = JSON.parse(run(process.execPath, [binary, 'capabilities', '--format', 'json']));
let lazyModelSdk;
if (capabilities.data.some((spec) => spec.id === 'agent.run')) {
  const runtimeUrl = pathToFileURL(join(temp, 'node_modules/@ohmate/cli-common/dist/runtime.js')).href;
  const cliUrl = pathToFileURL(join(temp, 'node_modules/@ohmate/cli-common/dist/cli.js')).href;
  run(process.execPath, ['--input-type=module', '--eval', `
    import { registerHooks } from 'node:module';
    registerHooks({resolve(specifier, context, next) {
      if (specifier.startsWith('@earendil-works/')) throw new Error('MODEL_SDK_EAGER_IMPORT');
      if (specifier === 'typescript' || /[/\\\\]typescript[/\\\\]/.test(specifier)) throw new Error('COMPILER_EAGER_IMPORT');
      return next(specifier, context);
    }});
    await import(${JSON.stringify(runtimeUrl)});
    await import(${JSON.stringify(cliUrl)});
  `]);
  lazyModelSdk = true;
}
if (doctor.schemaVersion !== '1.0' || doctor.exitCode !== 0 || !capabilities.data.some((spec) => spec.id === 'deveco.ui.layout')) {
  throw new Error('Installed runtime/registry is incomplete');
}
let tasks;
if (capabilities.data.some((spec) => spec.id === 'task.submit')) {
  const submitted = JSON.parse(run(process.execPath, [binary, 'task', 'submit', 'capabilities', '--wait', '--project', temp, '--format', 'json']));
  if (submitted.data.state !== 'succeeded' || submitted.data.receipt.exitCode !== 0) { throw new Error('Installed foreground task failed'); }
  const background = JSON.parse(run(process.execPath, [binary, 'task', 'submit', 'capabilities', '--project', temp, '--format', 'json']));
  const deadline = Date.now() + 15000;
  let task;
  do {
    task = JSON.parse(run(process.execPath, [binary, 'task', 'show', background.data.id, '--format', 'json'])).data;
    if (task.state === 'succeeded' && !task.processes.length) { break; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  if (task.state !== 'succeeded' || task.processes.length) { throw new Error('Installed background task failed'); }
  const output = run(process.execPath, [binary, 'task', 'events', task.id, '--after', '1', '--format', 'ndjson']);
  const events = output.trim().split('\n').map((line) => JSON.parse(line));
  if (!events.length || !events.every((event, index) => event.taskId === task.id && event.sequence === index + 2)) {
    throw new Error('Installed task event cursor is invalid');
  }
  tasks = { foreground: submitted.data.state, background: task.state, eventCount: events.length };
}
const identity = await Promise.all(packages.map(async (path) => ({
  path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
})));
const report = {
  schemaVersion: '1.0', platform: process.platform, node: process.version,
  installation: temp, offlineReinstall: true, cachePreparedOnline: true, scriptsDisabled: true,
  credentialConfiguration: 'private-empty-files', isolatedHome: true,
  installLockSha256: createHash('sha256').update(await readFile(join(temp, 'package-lock.json'))).digest('hex'),
  doctor: { status: doctor.status, warnings: doctor.warnings.map((warning) => warning.code) },
  registry: { registered: capabilities.data.length },
  stage, tasks, lazyModelSdk, lazyCompiler: lazyModelSdk,
  packages: identity,
};
await mkdir(join(root, 'artifacts/validation'), { recursive: true });
await writeFile(join(root, 'artifacts/validation', `${stage}-package.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Offline isolated installation passed: ${temp}`);
