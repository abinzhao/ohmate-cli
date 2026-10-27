/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { chmod, lstat, mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import JSON5 from 'json5';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js'), label = process.argv[3] ?? 'm1-native-build-built';
const root = await mkdtemp(join(tmpdir(), 'ohmate-native-build-cli-')), home = join(root, 'home');
const state = join(root, 'state'), output = resolve('artifacts/validation', label), receipts = {}, archived = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TMPDIR: root, OHMATE_DATA_DIR: state,
  NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
let webOpened = false;
function cli(args, project = root) {
  const child = spawnSync(process.execPath, [bin, ...args, '--project', project, '--format', 'json'],
    { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.error, undefined);
  const result = JSON.parse(child.stdout); assert.equal(child.status, result.exitCode, child.stderr);
  return result;
}
async function archive(name, receipt) {
  receipts[name] = receipt;
  await writeFile(join(output, `${name}.json`), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  for (const artifact of receipt.artifacts ?? []) {
    const bytes = await readFile(artifact.path); assert.equal(hash(bytes), artifact.sha256);
    const destination = join(output, `${name}-${basename(artifact.path)}`);
    await copyFile(artifact.path, destination);
    archived.push({ source: artifact.path, path: destination, sha256: artifact.sha256, kind: artifact.kind });
  }
}
async function approve(name, args, app, risk = 'R2') {
  const plan = cli(args, app);
  assert.equal(plan.exitCode, 5, JSON.stringify(plan)); assert.equal(plan.data.risk, risk);
  assert.equal(plan.provenance.adapter, 'native');
  await archive(`${name}-plan`, plan);
  const result = cli([...args, '--approve-plan', plan.data.planId], app);
  await archive(name, result); return result;
}
async function verifyHttp(app) {
  assert.equal(cli(['project', 'register', app]).exitCode, 0);
  const opened = cli(['ui', '--no-open'], app);
  assert.equal(opened.exitCode, 0); webOpened = true;
  const origin = opened.data.origin, ticket = new URL(opened.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const options = { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf };
  async function post(path, body) {
    const response = await fetch(`${origin}/api/v1/${path}`, { method: 'POST', headers: options,
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200); return response.json();
  }
  const pending = await post('tasks', { toolId: 'deveco.build', input: { modules: ['entry@default'] }, projectRoot: app, wait: true });
  assert.equal(pending.data.state, 'awaiting-approval', JSON.stringify(pending));
  assert.equal(pending.data.plan.risk, 'R2');
  const result = await post(`tasks/${pending.data.id}/approve`, { planId: pending.data.plan.planId, wait: true });
  assert.ok([0, 3].includes(result.data.receipt.exitCode), JSON.stringify(result));
  assert.equal(result.data.receipt.provenance.adapter, 'native');
  assert.ok(result.data.receipt.data.invocations.some((item) => item.argv.includes('assembleHap') && item.toolExitCode === 0));
  assert.deepEqual(cli(['task', 'show', pending.data.id]).data, result.data);
  await archive('http-build', result.data.receipt);
  await writeFile(join(output, 'http-task.json'), JSON.stringify(result.data, null, 2), { flag: 'wx' });
  assert.equal(cli(['ui', 'stop']).exitCode, 0); webOpened = false;
}
try {
  await mkdir(home); await mkdir(output, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const created = await approve('created', ['create', '--app-name', 'NativeBuildAcceptance', '--api-level', '22'], root);
  assert.equal(created.exitCode, 0, JSON.stringify(created));
  const app = join(root, 'NativeBuildAcceptance'), profilePath = join(app, 'build-profile.json5');
  const original = await readFile(profilePath);
  assert.match(await readFile(join(app, 'AGENTS.md'), 'utf8'), /NativeBuildAcceptance/);
  const first = await approve('default-build', ['build', '--modules', 'entry@default'], app);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert.ok(first.artifacts.some((item) => item.kind === 'hap'));
  const compiler = first.data.provenance.toolchain.compilerIdentity;
  assert.equal(compiler.scope, 'installed-default-candidates');
  assert.match(compiler.components.es2abc.sha256, /^[a-f0-9]{64}$/);
  assert.equal(compiler.components.es2abc.version, null);
  assert.equal(compiler.components.es2abc.executionObserved, false);
  assert.ok(first.data.provenance.loaderInputs.loaders.length > 0, 'Actual generated loader must be observed');
  assert.ok(first.data.provenance.loaderInputs.loaders.every((loader) =>
    loader.binding === 'unverified' && loader.inputPhase === 'post-build' && /^[a-f0-9]{64}$/.test(loader.sha256)));
  assert.equal(first.data.provenance.buildId, null);
  assert.ok(first.data.invocations.some((item) => item.argv.includes('install') && item.toolExitCode === 0));
  assert.equal(hash(await readFile(profilePath)), hash(original));
  const cache = join(app, 'entry/build/config/buildConfig.json'), cacheText = '{"compileConfig":{},"patchConfig":{"mode":"hotReload"}}\n';
  await mkdir(join(app, 'entry/build/config'), { recursive: true }); await writeFile(cache, cacheText);
  await chmod(cache, 0o664);
  const second = await approve('cache-build', ['build', '--modules', 'entry@default'], app);
  assert.ok([0, 3].includes(second.exitCode), JSON.stringify(second));
  const cleanup = second.data.configuration.cacheCleanup;
  assert.equal(cleanup.state, 'removed'); assert.match(cleanup.journalId, /^[a-f0-9-]+$/);
  await assert.rejects(readFile(cache), { code: 'ENOENT' });
  await archive('cache-inspection', cli(['build', 'cache', 'inspect', '--journal-id', cleanup.journalId], app));
  const restored = await approve('cache-restored', ['build', 'cache', 'restore', '--journal-id', cleanup.journalId], app);
  assert.equal(restored.exitCode, 0); assert.equal(await readFile(cache, 'utf8'), cacheText);
  assert.equal((await lstat(cache)).mode & 0o777, 0o664);
  await chmod(cache, 0o644);
  const incomplete = cli(['build', 'cache', 'inspect', '--journal-id', cleanup.journalId], app);
  await archive('cache-permissions-incomplete', incomplete);
  assert.equal(incomplete.data.files[0].state, 'permissions');
  const corrected = await approve('cache-permissions-retried', ['build', 'cache', 'restore', '--journal-id', cleanup.journalId], app);
  assert.equal(corrected.exitCode, 0); assert.equal((await lstat(cache)).mode & 0o777, 0o664);
  assert.equal(await readFile(cache, 'utf8'), cacheText);
  await verifyHttp(app);
  const profile = JSON5.parse(original.toString('utf8'));
  profile.app.signingConfigs = [{ name: 'AcceptanceMissingMaterial', type: 'HarmonyOS', material: {} }];
  const signingProfile = `\uFEFF// private signing failure fixture\r\n${JSON5.stringify(profile, null, 2)}\r\n`;
  await writeFile(profilePath, signingProfile);
  const signed = await approve('signing-failure', ['build', '--modules', 'entry@default', '--signing-config=AcceptanceMissingMaterial'], app, 'R3');
  assert.equal(signed.exitCode, 6, JSON.stringify(signed));
  assert.equal(signed.data.configuration.signing.state, 'restored');
  assert.equal(await readFile(profilePath, 'utf8'), signingProfile);
  assert.ok(signed.data.invocations.some((item) => item.toolExitCode !== 0));
  assert.ok(signed.artifacts.some((item) => item.kind === 'build-signing-journal'));
  await writeFile(profilePath, original);
  const caps = cli(['capabilities']).data;
  assert.equal(caps.find((item) => item.id === 'deveco.build').adapter, 'native');
  for (const id of ['build.signing.inspect', 'build.signing.restore', 'build.cache.inspect', 'build.cache.restore']) {
    assert.ok(caps.some((item) => item.id === id));
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ schemaVersion: '1.0', status: 'passed', bin,
    platform: process.platform, node: process.version, receipts, archived, publicCommands: caps.length,
    scope: { actualHvigor: true, nativeDefaultBuild: true, httpTaskParity: true, exactCacheRecovery: true,
      cachePermissionRecovery: 'simulated interrupted state; exact mode verified',
      signingReferenceRestore: 'official missing-material failure only', signingMaterials: 'none',
      actualSignatureGeneration: 'not-run', deviceOperations: 'none', modelRequests: 'none',
      fullCompilerClosure: 'not-certified', crossPlatform: 'not-run' } }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', label, publicCommands: caps.length, artifacts: archived.length }));
} finally {
  if (webOpened) { cli(['ui', 'stop']); }
  if (process.argv.includes('--keep')) { console.log(`Private root retained: ${root}`); }
  else { await rm(root, { recursive: true, force: true }); }
}
