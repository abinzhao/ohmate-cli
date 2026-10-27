/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js'), label = process.argv[3] ?? 'm1-deps-built';
const root = await mkdtemp(join(tmpdir(), 'ohmate-deps-cli-')), app = join(root, 'app'), home = join(root, 'home');
const privateData = join(root, 'state'), hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = { HOME: home, PATH: process.env.PATH, TMPDIR: root, OHMATE_DATA_DIR: privateData,
  NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'), NPM_CONFIG_CACHE: join(home, 'cache') };
let registryRequests = 0;
let webOpened = false;
const registry = createServer((_, response) => { registryRequests++; response.writeHead(503); response.end('Network disabled for local producer verification'); });
function command(executable, args, cwd = app) {
  const process = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(process.error, undefined);
  return process;
}
function cli(args, project = app) {
  const output = command(process.execPath, [bin, ...args, '--project', project, '--format', 'json'], root);
  const receipt = JSON.parse(output.stdout);
  assert.equal(output.status, receipt.exitCode, output.stderr);
  return receipt;
}
async function put(path, value) {
  const file = join(app, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}
async function localInstall(executable, args) {
  const child = spawn(executable, args, { cwd: app, env, timeout: 60_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { child.kill(); } });
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8 * 1024 * 1024) { child.kill(); } });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}
async function verifyWeb() {
  assert.equal(cli(['project', 'register', app]).exitCode, 0);
  const opened = cli(['ui', '--no-open']);
  assert.equal(opened.exitCode, 0); webOpened = true;
  const origin = opened.data.origin, ticket = new URL(opened.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const response = await fetch(`${origin}/api/v1/tasks`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
    body: JSON.stringify({ toolId: 'deps.sbom', input: { standard: 'spdx' }, projectRoot: app, wait: true }), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const task = (await response.json()).data;
  assert.equal(task.state, 'succeeded', JSON.stringify(task));
  assert.equal(task.receipt.data.document.spdxVersion, 'SPDX-2.3');
  assert.deepEqual(cli(['task', 'show', task.id]).data, task);
  assert.equal(cli(['ui', 'stop']).exitCode, 0); webOpened = false;
}
try {
  await mkdir(home); await mkdir(app);
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  await put('build-profile.json5', { modules: [{ name: 'entry', srcPath: './entry' }, { name: 'shared', srcPath: './shared' }] });
  await put('oh-package.json5', { name: 'acceptance', version: '1.0.0' });
  await put('entry/src/main/module.json5', { module: { name: 'entry', type: 'entry' } });
  await put('shared/src/main/module.json5', { module: { name: 'shared', type: 'har' } });
  await put('entry/oh-package.json5', { name: 'entry', version: '1.0.0', dependencies: { shared: 'file:../shared' } });
  await put('shared/oh-package.json5', { name: 'shared', version: '1.0.0', main: 'Index.ets' });
  await put('shared/Index.ets', 'export const value = 1;\n');
  const doctor = cli(['doctor']);
  const components = doctor.data.toolchain.components;
  const node = components.find((item) => item.name === 'node')?.path, ohpm = components.find((item) => item.name === 'ohpm')?.path;
  assert.ok(node && ohpm, 'Official OHPM/Node required for producer verification');
  const help = command(node, [ohpm, 'install', '--help']);
  assert.equal(help.status, 0, help.stderr);
  registry.listen(0, '127.0.0.1');
  await once(registry, 'listening');
  const registryUrl = `http://127.0.0.1:${registry.address().port}`;
  env.HTTP_PROXY = registryUrl; env.HTTPS_PROXY = registryUrl;
  const installArgs = [ohpm, 'install', '--all', '--registry', registryUrl];
  assert.ok(help.stdout.includes('--registry'), 'Local registry isolation requires an observed option');
  const installed = await localInstall(node, installArgs);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert.equal(registryRequests, 0, 'Local-only OHPM fixture must not request registry metadata');
  await put('cloud/package.json', { name: 'acceptance-cloud', version: '1.0.0', workspaces: ['functions/*'], dependencies: { fn: 'file:functions/fn' } });
  await put('cloud/functions/fn/package.json', { name: 'fn', version: '1.0.0', license: 'MIT' });
  const npmResult = command('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], join(app, 'cloud'));
  assert.equal(npmResult.status, 0, npmResult.stderr + npmResult.stdout);
  await put('entry/src/main/cpp/CMakeLists.txt', 'add_library(entry SHARED entry.cpp)\n');
  await put('entry/src/main/ets/Index.ets', "import native from 'libentry.so';\nimport { value } from 'shared';\n");
  const graph = cli(['deps', 'analyze']);
  assert.equal(graph.exitCode, 0, JSON.stringify(graph.data));
  const lockInputs = graph.data.inputs.filter((input) => input.path.endsWith('-lock.json') || input.path.endsWith('-lock.json5'));
  assert.ok(lockInputs.length >= 2);
  for (const input of lockInputs) { assert.equal(hash(await readFile(join(app, input.path))), input.sha256); }
  assert.ok(graph.data.relationships.some((item) => item.kind === 'native-bridge'));
  assert.ok(graph.data.components.some((item) => item.ecosystem === 'npm' && item.name === 'fn' && item.version === '1.0.0'));
  assert.equal(cli(['deps', 'why', '--name', 'shared']).exitCode, 0);
  assert.equal(cli(['deps', 'audit']).data.checks.vulnerabilities, 'not-run');
  const cdx = cli(['deps', 'sbom']).data.document, spdx = cli(['deps', 'sbom', '--standard', 'spdx']).data.document;
  assert.equal(cdx.bomFormat, 'CycloneDX'); assert.equal(spdx.spdxVersion, 'SPDX-2.3');
  const refs = new Set(cdx.components.map((item) => item['bom-ref']));
  for (const edge of cdx.dependencies) { assert.ok(refs.has(edge.ref)); for (const target of edge.dependsOn) { assert.ok(refs.has(target)); } }
  const task = cli(['task', 'submit', 'deps.sbom', '--wait']);
  assert.equal(task.data.state, 'succeeded', JSON.stringify(task.data));
  assert.equal(task.data.receipt.data.document.bomFormat, 'CycloneDX');
  await verifyWeb();
  for (const input of lockInputs) { assert.equal(hash(await readFile(join(app, input.path))), input.sha256); }
  await mkdir('artifacts/validation', { recursive: true });
  await writeFile(`artifacts/validation/${label}.json`, JSON.stringify({
    status: 'passed', bin, platform: process.platform, node: process.version,
    registry: cli(['capabilities']).data.length,
    checks: ['official OHPM local producer with isolated registry', 'npm offline workspace producer', 'actual input hashes', 'locked workspace version',
      'native bridge', 'why', 'local audit', 'CycloneDX references', 'SPDX relationships', 'persistent task', 'same Web/CLI task receipt', 'input unchanged'],
    officialProducer: { executable: node, script: ohpm, executableHash: hash(await readFile(node)), scriptHash: hash(await readFile(ohpm)),
      packageVersion: JSON.parse(await readFile(join(dirname(dirname(ohpm)), 'package.json'), 'utf8')).version,
      args: installArgs.slice(1), helpHash: hash(help.stdout), exitCode: installed.status },
    inputs: lockInputs, deviceOperations: 'none', modelRequests: 'none', registryRequests,
    build: 'not-run', instrumentTest: 'not-run',
  }, null, 2));
  console.log(`Dependency CLI and official local producers verified: ${label}`);
} finally {
  if (webOpened) { cli(['ui', 'stop']); }
  if (registry.listening) { await new Promise((resolve) => registry.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
