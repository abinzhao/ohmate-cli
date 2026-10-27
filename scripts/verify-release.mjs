/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js'), label = process.argv[3] ?? 'm1-release-built';
assert.match(label, /^[a-z0-9-]+$/);
const root = await mkdtemp(join(tmpdir(), 'ohmate-release-cli-')), home = join(root, 'home'), state = join(root, 'state');
const output = resolve('artifacts/validation', label), hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TMPDIR: root, OHMATE_DATA_DIR: state,
  NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
let opened = false;
function cli(args, project = root) {
  const child = spawnSync(process.execPath, [bin, ...args, '--project', project, '--format', 'json'],
    { cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(child.error, undefined);
  const receipt = JSON.parse(child.stdout); assert.equal(child.status, receipt.exitCode, child.stderr);
  return receipt;
}
function approved(args, project = root) {
  const plan = cli(args, project); assert.equal(plan.exitCode, 5, JSON.stringify(plan));
  return cli([...args, '--approve-plan', plan.data.planId], project);
}
async function archive(receipt) {
  const entries = [];
  for (const artifact of receipt.artifacts ?? []) {
    const bytes = await readFile(artifact.path); assert.equal(hash(bytes), artifact.sha256);
    const path = join(output, `${entries.length}-${basename(artifact.path)}`);
    await copyFile(artifact.path, path, 1);
    entries.push({ originalPath: artifact.path, archivedPath: path, sha256: artifact.sha256, kind: artifact.kind });
  }
  return entries;
}
async function symbols(directory) {
  const files = [], queue = [directory];
  while (queue.length) {
    const path = queue.shift();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { queue.push(child); }
      else if (entry.name === 'sourceMaps.map' || entry.name === 'nameCache.json') { files.push(child); }
    }
  }
  return files;
}
async function webVerify(app, input) {
  assert.equal(cli(['project', 'register', app]).exitCode, 0);
  const server = cli(['ui', '--no-open'], app); assert.equal(server.exitCode, 0); opened = true;
  const origin = server.data.origin, ticket = new URL(server.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const response = await fetch(`${origin}/api/v1/tasks`, { method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
    body: JSON.stringify({ toolId: 'release.verify', input, projectRoot: app, wait: true }), signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200);
  const task = await response.json(); assert.deepEqual(cli(['task', 'show', task.data.id]).data, task.data);
  assert.equal(task.data.receipt.data.gates.length, 14); assert.equal(task.data.receipt.data.ready, false);
  assert.equal(cli(['ui', 'stop']).exitCode, 0); opened = false; return task.data;
}
async function nativeProducer(app, artifact) {
  const llvm = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native/llvm/bin';
  const tools = { clang: join(llvm, 'clang'), strip: join(llvm, 'llvm-strip'), readelf: join(llvm, 'llvm-readelf') };
  const source = join(root, 'acceptance.c'), raw = join(root, 'libacceptance.so'), stripped = join(root, 'libacceptance-stripped.so');
  await writeFile(source, 'int ohmate_acceptance(void) { return 42; }\n');
  const invocations = [];
  for (const [tool, args] of [
    ['clang', ['--target=aarch64-linux-ohos', '-shared', '-fPIC', '-g', '-nostdlib', '-Wl,--build-id=sha1', '-o', raw, source]],
    ['strip', ['--strip-all', '-o', stripped, raw]], ['readelf', ['--notes', '--sections', '--file-header', stripped]],
  ]) {
    const executable = tools[tool], child = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    invocations.push({ executable, sha256: hash(await readFile(executable)), argv: args, exitCode: child.status, stdout: child.stdout, stderr: child.stderr });
  }
  const expectedId = invocations.at(-1).stdout.match(/Build ID:\s*([0-9a-f]+)/i)?.[1]; assert.ok(expectedId);
  const cases = [];
  await mkdir(join(app, 'build'), { recursive: true });
  for (const [name, file, abi] of [['stripped', stripped, 'arm64-v8a'], ['unstripped', raw, 'arm64-v8a'], ['wrong-abi', stripped, 'x86_64']]) {
    const zip = new AdmZip(artifact); zip.addFile(`libs/${abi}/libacceptance.so`, await readFile(file));
    const fixture = join(app, `build/native-${name}.hap`); await writeFile(fixture, zip.toBuffer());
    const result = cli(['release', 'verify', '--artifacts', fixture], app);
    assert.equal(result.data.native[0].buildId, expectedId);
    const packageGate = result.data.gates.find((g) => g.id === 'release.package-content');
    if (name === 'stripped') { assert.equal(packageGate.status, 'passed'); }
    if (name === 'unstripped') { assert.equal(packageGate.status, 'failed'); }
    if (name === 'wrong-abi') { assert.equal(result.data.gates.find((g) => g.id === 'release.native-abi').status, 'failed'); }
    cases.push({ fixture: 'derived-negative-and-reader-fixture-not-official-native-HAP', name, result, archived: await archive(result) });
  }
  await copyFile(raw, join(output, 'producer-unstripped.so'), 1); await copyFile(stripped, join(output, 'producer-stripped.so'), 1);
  return { invocations, expectedId, cases };
}
try {
  await mkdir(home); await mkdir(output, { recursive: false });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const created = approved(['create', '--app-name', 'ReleaseAcceptance', '--api-level', '22']);
  assert.equal(created.exitCode, 0, JSON.stringify(created)); const app = join(root, 'ReleaseAcceptance');
  const built = approved(['build', 'run', '--build-mode', 'release'], app);
  assert.equal(built.exitCode, 0, JSON.stringify(built));
  const manifest = built.artifacts.find((a) => a.kind === 'build-provenance').path;
  const selectedSymbols = await symbols(join(app, 'entry/build')), input = { manifest };
  const verified = cli(['release', 'verify', '--manifest', manifest], app);
  assert.ok([1, 3].includes(verified.exitCode)); assert.equal(verified.data.ready, false); assert.equal(verified.data.gates.length, 14);
  assert.equal(verified.data.gates.find((g) => g.id === 'release.build-mode').status, 'passed', JSON.stringify(verified));
  const guide = cli(['release', 'guide', '--manifest', manifest, '--lang', 'zh-CN'], app);
  assert.equal(guide.data.manualOnly, true); assert.deepEqual(guide.data.performed, []);
  const archived = cli(['release', 'artifacts', '--manifest', manifest, ...selectedSymbols.length ? ['--symbols', ...selectedSymbols] : []], app);
  assert.equal(archived.exitCode, 3, JSON.stringify(archived));
  for (const item of archived.data.archive) { assert.equal(hash(await readFile(item.archivedPath)), item.sha256); }
  const web = await webVerify(app, input), native = await nativeProducer(app, built.artifacts.find((a) => a.kind === 'hap').path);
  const evidence = [];
  for (const receipt of [created, built, verified, guide, archived, web.receipt]) { evidence.push(...await archive(receipt)); }
  await writeFile(join(output, 'result.json'), JSON.stringify({ schemaVersion: '1.0', bin, platform: process.platform, node: process.version,
    created, built, verified, guide, archive: archived, web, native, evidence,
    compatibility: { officialReleaseBuild: 'passed', officialNativeElfReader: 'passed', releaseReadiness: 'incomplete',
      fourteenGates: 'reported', manualReleaseOnly: true, deviceOperations: 'none', models: 'none', cloud: 'not-run', crossPlatform: 'not-run' } }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ label, gates: verified.data.summary, nativeBuildId: native.expectedId, evidence: evidence.length, output }, null, 2));
} finally {
  if (opened) { cli(['ui', 'stop']); }
  if (process.argv.includes('--keep')) { console.log(`Private verification root retained: ${root}`); }
  else { await rm(root, { recursive: true, force: true }); }
}
