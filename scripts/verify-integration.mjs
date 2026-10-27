/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const bin = resolve(process.argv[2] ?? 'packages/cli-wrapper/cli.js');
const label = process.argv[3] ?? 'm1-integrate-r1-built';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const output = resolve('artifacts/validation', label), root = await mkdtemp(join(tmpdir(), 'ohmate-integration-cli-'));
const home = join(root, 'home'), dataDir = join(root, 'private'), app = join(root, 'IntegrationAcceptance');
await mkdir(home); await mkdir(output, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
  OHMATE_DATA_DIR: dataDir, NPM_CONFIG_USERCONFIG: join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'),
  DEVECO_CLI_DISABLE_TELEMETRY: '1', DEVECO_CLI_DISABLE_UPDATE: 'all',
  SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function cli(args, project = app) {
  const child = spawnSync(process.execPath, [bin, ...args, '--project', project, '--format', 'json'], {
    cwd: root, env, encoding: 'utf8', shell: false, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.ok(child.stdout.trim(), child.stderr);
  const receipt = JSON.parse(child.stdout);
  assert.equal(child.status, receipt.exitCode, child.stderr);
  return receipt;
}
function approve(args, project) {
  const planned = cli(args, project);
  assert.equal(planned.exitCode, 5, JSON.stringify(planned.data));
  return cli([...args, '--approve-plan', planned.data.planId], project);
}
let webOpened = false;
try {
  assert.equal(approve(['create', '--app-name', 'IntegrationAcceptance', '--api-level', '22'], root).exitCode, 0);
  const testDirectory = join(app, 'entry/src/test');
  await mkdir(testDirectory, { recursive: true });
  await writeFile(join(testDirectory, 'List.test.ets'), "import acceptance from './Acceptance.test';\nexport default function testsuite(): void { acceptance(); }\n");
  await writeFile(join(testDirectory, 'Acceptance.test.ets'), `import { describe, it, expect } from '@ohos/hypium';
export default function acceptance(): void {
  describe('IntegrationAcceptance', () => {
    it('addition', 0, () => { expect(2 + 3).assertEqual(5); });
  });
}
`);
  const built = approve(['build', 'run', '--install']);
  await writeFile(join(output, 'initial-build.json'), JSON.stringify(built, null, 2), { flag: 'wx' });
  assert.equal(built.exitCode, 0, JSON.stringify(built.data));
  const tools = cli(['build', 'plan']).data.tools;
  const original = await readFile(join(app, 'hvigorfile.ts'), 'utf8');
  const integrated = approve(['integrate', 'hvigor']);
  assert.equal(integrated.exitCode, 0, JSON.stringify(integrated.data));
  const plugin = await readFile(join(app, 'ohmate-hvigor.ts'));
  await writeFile(join(output, 'ohmate-hvigor.ts'), plugin, { flag: 'wx' });
  const commonRoot = process.argv[4] ? resolve(process.argv[4]) : resolve('packages/cli');
  await mkdir(join(app, 'node_modules/@ohmate'), { recursive: true });
  await symlink(commonRoot, join(app, 'node_modules/@ohmate/cli-common'), 'dir');
  const javaHome = dirname(dirname(tools.tools.java.path));
  const officialEnv = { ...env, PATH: [dirname(tools.tools.java.path), dirname(tools.tools.node.path), env.PATH].join(delimiter),
    JAVA_HOME: javaHome, DEVECO_SDK_HOME: tools.sdkPath, HVIGOR_USER_HOME: join(home, '.hvigor'), OHPM_HOME: join(home, '.ohpm') };
  function hvigor(task, filename) {
    const child = spawnSync(tools.tools.node.path, [tools.tools.hvigor.path, '--mode', 'project', task,
      '-p', 'product=default', '-p', 'buildMode=debug', '--no-daemon'], {
      cwd: app, env: officialEnv, encoding: 'utf8', shell: false, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(child.error, undefined);
    const raw = `${child.stdout}\n${child.stderr}`;
    return writeFile(join(output, filename), raw, { flag: 'wx' }).then(() => ({ status: child.status, raw }));
  }
  const catalog = await hvigor('tasks', 'official-tasks.log');
  assert.equal(catalog.status, 0, catalog.raw);
  for (const task of ['ohmatecliScan', 'ohmatecliDocs', 'ohmatecliTest', 'ohmatecliVerifyRelease']) { assert.ok(catalog.raw.includes(task)); }
  const scan = await hvigor('ohmatecliScan', 'official-scan.log');
  assert.notEqual(scan.status, 0);
  assert.ok(scan.raw.includes('"command":"scan"') && scan.raw.includes('"completeness":"incomplete"') &&
    scan.raw.includes('"exitCode":3'), scan.raw);
  const test = await hvigor('ohmatecliTest', 'official-test.log');
  assert.notEqual(test.status, 0);
  const line = test.raw.split(/\r?\n/).find((entry) => entry.startsWith('{"exitCode":5'));
  assert.ok(line, test.raw);
  const pending = JSON.parse(line);
  assert.equal(pending.data.execution, 'awaiting-approval');
  const resumed = cli(['task', 'approve', pending.data.taskId, pending.data.planId, '--wait']);
  await writeFile(join(output, 'resumed-test.json'), JSON.stringify(resumed, null, 2), { flag: 'wx' });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.data));
  assert.equal(resumed.data.receipt.data.reports[0].passed, 1);
  const release = await hvigor('ohmatecliVerifyRelease', 'official-release.log');
  assert.notEqual(release.status, 0);
  assert.ok(release.raw.includes('"command":"release.verify"'), release.raw);
  const exported = cli(['skill', 'export']);
  assert.equal(exported.exitCode, 0);
  const portablePath = join(output, 'ohmate-cli');
  await cp(exported.data.path, portablePath, { recursive: true, errorOnExist: true, force: false });
  assert.equal(cli(['skill', 'verify', '--path', portablePath]).exitCode, 0);
  const opened = cli(['ui', '--no-open']);
  assert.equal(opened.exitCode, 0); webOpened = true;
  const origin = opened.data.origin, ticket = new URL(opened.data.url).hash.slice('#access='.length);
  const connected = await fetch(`${origin}/api/v1/connect`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie } })).json();
  const response = await fetch(`${origin}/api/v1/tasks`, { method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json', 'x-ohmate-csrf': bootstrap.csrf },
    body: JSON.stringify({ toolId: 'skill.verify', input: { path: portablePath }, projectRoot: app, wait: true }),
  });
  assert.equal(response.status, 200);
  const web = await response.json();
  assert.equal(web.data.state, 'succeeded');
  assert.deepEqual(web.data.receipt.data, cli(['skill', 'verify', '--path', portablePath]).data);
  assert.equal(cli(['ui', 'stop']).exitCode, 0); webOpened = false;
  const restore = approve(['workspace', 'recovery', 'restore', '--journal-id', integrated.data.journalId]);
  assert.equal(restore.exitCode, 0);
  assert.equal(await readFile(join(app, 'hvigorfile.ts'), 'utf8'), original);
  await assert.rejects(readFile(join(app, 'ohmate-hvigor.ts')), { code: 'ENOENT' });
  const hvigorMetadata = await readFile(join(dirname(dirname(tools.tools.hvigor.path)), 'hvigor/package.json'));
  const result = { status: 'passed', bin, platform: process.platform, toolchainVersion: tools.version,
    officialHvigorVersion: JSON.parse(hvigorMetadata).version, officialHvigorMetadataHash: hash(hvigorMetadata),
    pluginHash: hash(plugin), officialApiHash: hash(await readFile(join(dirname(dirname(tools.tools.hvigor.path)), 'hvigor/types/index.d.ts'))),
    taskCatalog: true, scanCoverageIncomplete: true, persistentTestApproval: true, actualLocalTestPassed: 1,
    releaseNotCertified: true, portableCount: exported.data.count, portablePath, registryHash: exported.data.registryHash,
    webCliAgreement: true, byteExactRecovery: true, devices: 'not-operated', cloud: 'not-contacted' };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  if (webOpened) { cli(['ui', 'stop']); }
  await rm(root, { recursive: true, force: true });
}
