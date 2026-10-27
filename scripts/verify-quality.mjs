/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js'), label = process.argv[3] ?? 'm1-quality-built';
const withSamples = process.argv.includes('--samples');
const root = await mkdtemp(join(tmpdir(), 'ohmate-quality-cli-')), home = join(root, 'home'), state = join(root, 'state');
const output = resolve('artifacts/validation', label);
let webOpened = false;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TMPDIR: root, OHMATE_DATA_DIR: state,
  NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc') };
function cli(args, project = root) {
  const child = spawnSync(process.execPath, [bin, ...args, '--project', project, '--format', 'json'],
    { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.error, undefined);
  const receipt = JSON.parse(child.stdout);
  assert.equal(child.status, receipt.exitCode, child.stderr);
  return receipt;
}
function approved(args, project) {
  const plan = cli(args, project);
  assert.equal(plan.exitCode, 5, JSON.stringify(plan));
  assert.match(plan.data.planId, /^[a-f0-9]{64}$/);
  return cli([...args, '--approve-plan', plan.data.planId], project);
}
async function localSamples(app) {
  const directory = join(app, 'entry/src/test');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'List.test.ets'),
    "import acceptance from './Acceptance.test';\nexport default function testsuite(): void { acceptance(); }\n");
  await writeFile(join(directory, 'Acceptance.test.ets'), `import { describe, it, expect } from '@ohos/hypium';
export default function acceptance(): void {
  describe('Acceptance', () => {
    it('addition', 0, () => { expect(2 + 3).assertEqual(5); });
    it('unicode', 0, () => { expect('鸿蒙'.length).assertEqual(2); });
  });
}
`);
  const agents = join(app, 'AGENTS.md'), text = await readFile(agents, 'utf8');
  await writeFile(agents, `${text}\nLocal acceptance tests: entry/src/test/List.test.ets registers Acceptance.test.ets; pure ArkTS only, no device/API operations.\n`);
}
async function archive(receipt) {
  const archived = [];
  const artifacts = [...receipt.artifacts ?? [], ...receipt.data.reports?.flatMap((report) =>
    report.result ? [{ path: report.result.absolutePath, sha256: report.result.sha256, kind: 'test-raw-result' }] : []) ?? []];
  for (const artifact of new Map(artifacts.map((item) => [item.path, item])).values()) {
    const bytes = await readFile(artifact.path);
    assert.equal(hash(bytes), artifact.sha256);
    const path = join(output, basename(artifact.path));
    await copyFile(artifact.path, path);
    archived.push({ originalPath: artifact.path, archivedPath: path, sha256: artifact.sha256, kind: artifact.kind });
  }
  return archived;
}
async function verifyTasks(app) {
  const submitted = cli(['task', 'submit', 'build.run', '--payload', '{}', '--wait'], app);
  assert.equal(submitted.data.state, 'awaiting-approval', JSON.stringify(submitted));
  const built = cli(['task', 'approve', submitted.data.id, submitted.data.plan.planId, '--wait'], app);
  assert.ok([0, 3].includes(built.exitCode), JSON.stringify(built));
  assert.ok(built.data.receipt.data.invocations.some((item) => item.argv.includes('assembleHap') && item.toolExitCode === 0));
  assert.equal(cli(['project', 'register', app]).exitCode, 0);
  const opened = cli(['ui', '--no-open'], app);
  assert.equal(opened.exitCode, 0); webOpened = true;
  const origin = opened.data.origin, ticket = new URL(opened.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  async function post(path, body) {
    const response = await fetch(`${origin}/api/v1/${path}`, { method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const planned = await post('tasks', { toolId: 'build.plan', input: {}, projectRoot: app, wait: true });
  assert.equal(planned.data.state, 'succeeded');
  assert.deepEqual(cli(['task', 'show', planned.data.id]).data, planned.data);
  const pending = await post('tasks', { toolId: 'test.local', input: { files: ['entry/src/test/Acceptance.test.ets'],
    scope: ['Acceptance#unicode'], coverage: false }, projectRoot: app, wait: true });
  assert.equal(pending.data.state, 'awaiting-approval', JSON.stringify(pending));
  const tested = await post(`tasks/${pending.data.id}/approve`, { planId: pending.data.plan.planId, wait: true });
  assert.equal(tested.data.state, 'succeeded', JSON.stringify(tested));
  assert.deepEqual(tested.data.receipt.data.reports[0].cases, ['Acceptance#unicode']);
  assert.deepEqual(cli(['task', 'show', tested.data.id]).data, tested.data);
  assert.equal(cli(['ui', 'stop']).exitCode, 0); webOpened = false;
  return { build: built.data, webBuildPlan: planned.data, webTest: tested.data };
}
try {
  await mkdir(home); await mkdir(output, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const created = approved(['create', '--app-name', 'QualityAcceptance', '--api-level', '22'], root);
  assert.equal(created.exitCode, 0, JSON.stringify(created));
  const app = join(root, 'QualityAcceptance'), profile = await readFile(join(app, 'build-profile.json5'));
  assert.match(await readFile(join(app, 'AGENTS.md'), 'utf8'), /QualityAcceptance/);
  if (withSamples) { await localSamples(app); }
  const plan = cli(['build', 'plan'], app);
  assert.equal(plan.exitCode, 0, JSON.stringify(plan));
  assert.ok(plan.data.tools.tools.hvigor.sha256);
  const build = approved(['build', 'run', ...withSamples ? ['--install'] : []], app);
  assert.ok(build.data.invocations?.length > 0, JSON.stringify(build));
  assert.ok(build.artifacts?.some((item) => item.kind === 'build-provenance'));
  const archived = await archive(build);
  assert.equal(hash(await readFile(join(app, 'build-profile.json5'))), hash(profile));
  const testArgs = ['test', 'local', ...withSamples ? ['--files', 'entry/src/test/Acceptance.test.ets'] : ['--modules', 'entry'], '--no-coverage'];
  const tests = withSamples ? approved(testArgs, app) : cli(testArgs, app);
  archived.push(...await archive(tests));
  let tasks, buildOnly, negative;
  if (withSamples) {
    assert.equal(build.exitCode, 0, JSON.stringify(build));
    assert.ok(build.data.provenance.inputs.some((item) => item.path === 'oh-package-lock.json5'), 'Compiler input must include the produced lock');
    assert.ok(build.data.provenance.dependencies.inputs.some((item) => item.path === 'oh-package-lock.json5'), 'Post-install graph must use the actual producer lock');
    assert.equal(tests.exitCode, 0, JSON.stringify(tests));
    assert.deepEqual(tests.data.reports[0].cases, ['Acceptance#addition', 'Acceptance#unicode']);
    buildOnly = approved(['test', 'local', '--modules', 'entry', '--build-only', '--no-coverage'], app);
    assert.equal(buildOnly.exitCode, 3, JSON.stringify(buildOnly));
    assert.ok(buildOnly.data.invocations.some((item) => item.argv.includes('UnitTestBuild') && item.toolExitCode === 0));
    tasks = await verifyTasks(app);
    archived.push(...await archive(buildOnly), ...await archive(tasks.build.receipt), ...await archive(tasks.webTest.receipt));
    const file = join(app, 'entry/src/test/Acceptance.test.ets'), text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('assertEqual(5)', 'assertEqual(6)'));
    negative = approved(['test', 'local', '--files', 'entry/src/test/Acceptance.test.ets', '--scope', 'Acceptance#addition', '--no-coverage'], app);
    assert.ok([1, 6].includes(negative.exitCode), JSON.stringify(negative));
    assert.equal(negative.data.reports[0].failed, 1, JSON.stringify(negative));
    archived.push(...await archive(negative));
    await writeFile(file, text);
  } else { assert.equal(tests.exitCode, 4); }
  const device = approved(['test', 'instrument', '--modules', 'entry'], app);
  assert.equal(device.data.execution, 'not-run');
  assert.equal(device.data.code, 'DEVICE_NOT_SELECTED');
  await writeFile(join(output, 'result.json'), JSON.stringify({
    schemaVersion: '1.0', bin, platform: process.platform, node: process.version,
    creation: created, plan, build, tests, buildOnly, negative, tasks, device, archived,
    compatibility: { officialToolsInvoked: true, sourceProfileUnchanged: true, modelRequests: 'none', deviceOperations: 'none',
      build: build.exitCode === 0 ? 'passed' : 'failed', localTests: tests.data.execution ?? 'not-run',
      instrumentTest: 'not-run', cloudTests: 'not-run', crossPlatform: 'not-run' },
  }, null, 2));
  console.log(JSON.stringify({ label, buildExit: build.exitCode, build: build.data.execution,
    failure: build.data.failure, localTests: tests.data.execution, result: join(output, 'result.json') }, null, 2));
} finally {
  if (webOpened) { cli(['ui', 'stop']); }
  if (process.argv.includes('--keep')) { console.log(`Private verification root retained: ${root}`); }
  else { await rm(root, { recursive: true, force: true }); }
}
